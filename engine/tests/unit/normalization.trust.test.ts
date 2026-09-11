import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIDENCE_FLOOR,
  confirmationToRecord,
  confirmedValue,
  confirmFacts,
  extractFacts,
  extractionToRecord,
  extractTerms,
  recordToExtraction,
  worthConfirming,
} from '../../src/domain/normalization.ts';
import {
  assessTrust,
  BURST_THRESHOLD,
  detectCoordinatedBurst,
  type TrustInputs,
} from '../../src/domain/trust.ts';

const NOW = 1_700_000_000_000;

const aliases = new Map([
  ['northwind air', 'ent_northwind'],
  ['northwind', 'ent_northwind'],
  ['other co', 'ent_other'],
]);
const categories = new Map([['shopping & service', 'cat_shopping']]);

// ── Extraction: proposes, never decides ──────────────────────────────────
test('extraction reads an entity from an alias and keeps the words it read', () => {
  const outcome = extractFacts({
    text: 'Northwind Air lost my bag and the refund never arrived.',
    source: 'text',
    aliases,
    categories,
    now: NOW,
  });
  const entity = outcome.suggestions.find((suggestion) => suggestion.field === 'entity');
  assert.equal(entity?.value, 'ent_northwind');
  assert.equal(
    entity?.evidence,
    'Northwind Air',
    'the suggestion carries the person’s own words, so the confirmation can show why it is asking',
  );
});

test('the longest matching alias wins, so a prefix cannot hijack the entity', () => {
  const outcome = extractFacts({
    text: 'Northwind Air lost my bag.',
    source: 'text',
    aliases: new Map([...aliases, ['air', 'ent_generic_air']]),
    categories,
    now: NOW,
  });
  assert.equal(outcome.suggestions.find((s) => s.field === 'entity')?.value, 'ent_northwind');
});

test('a voice reading is less confident than the same reading from typed text', () => {
  const input = { text: 'Northwind Air lost my bag.', aliases, categories, now: NOW };
  const typed = extractFacts({ ...input, source: 'text' });
  const spoken = extractFacts({ ...input, source: 'voice' });
  const typedEntity = typed.suggestions.find((s) => s.field === 'entity')?.confidence ?? 0;
  const spokenEntity = spoken.suggestions.find((s) => s.field === 'entity')?.confidence ?? 0;
  assert.ok(spokenEntity < typedEntity, 'a transcript is a reading of speech, not the speech');
  assert.equal(spoken.source, 'voice');
});

test('extraction never returns a confirmed field, only suggestions', () => {
  const outcome = extractFacts({
    text: 'Northwind Air lost my bag.',
    source: 'text',
    aliases,
    categories,
    now: NOW,
  });
  const record = extractionToRecord(outcome);
  assert.ok(Object.keys(record).includes('suggestions'));
  assert.equal(
    confirmedValue(record, 'entity'),
    undefined,
    'reading an extraction as a confirmed value must yield nothing',
  );
});

test('low-confidence guesses are not worth putting in front of a person', () => {
  const outcome = {
    source: 'text' as const,
    suggestions: [
      { field: 'entity' as const, value: 'ent_a', confidence: CONFIDENCE_FLOOR - 0.01 },
      { field: 'category' as const, value: 'cat_a', confidence: CONFIDENCE_FLOOR },
    ],
  };
  assert.deepEqual(
    worthConfirming(outcome).map((s) => s.field),
    ['category'],
  );
});

// ── Confirmation: the only thing that makes a fact ───────────────────────
test('only what the person affirmed becomes confirmed', () => {
  const extracted = extractFacts({
    text: 'Northwind Air lost my bag.',
    source: 'text',
    aliases,
    categories,
    now: NOW,
  });
  const confirmation = confirmFacts(
    { fields: { entity: 'ent_northwind' }, extracted },
    { actorId: 'actor_1', now: NOW },
  );
  assert.equal(confirmation.ok, true);
  if (!confirmation.ok) return;

  const record = confirmationToRecord(confirmation.value);
  assert.equal(confirmedValue(record, 'entity'), 'ent_northwind');
  assert.equal(
    confirmedValue(record, 'title'),
    undefined,
    'a title was suggested but not affirmed, so it is not a fact',
  );
});

test('an edited confirmation is recorded as edited', () => {
  const extracted = extractFacts({
    text: 'Northwind Air lost my bag.',
    source: 'text',
    aliases,
    categories,
    now: NOW,
  });
  const confirmation = confirmFacts(
    // The person was shown ent_northwind and said it was someone else.
    { fields: { entity: 'ent_other' }, extracted },
    { actorId: 'actor_1', now: NOW },
  );
  assert.equal(confirmation.ok, true);
  if (!confirmation.ok) return;
  assert.equal(confirmation.value.fields[0]?.edited, true);
  assert.deepEqual(confirmationToRecord(confirmation.value)['_edited'], ['entity']);
});

test('accepting a suggestion unchanged is not an edit', () => {
  const extracted = extractFacts({ text: 'Northwind lost my bag.', source: 'text', aliases, categories, now: NOW });
  const confirmation = confirmFacts(
    { fields: { entity: 'ent_northwind' }, extracted },
    { actorId: 'actor_1', now: NOW },
  );
  assert.equal(confirmation.ok && confirmation.value.fields[0]?.edited, false);
});

test('a confirmation cannot be empty, unknown, or in the future', () => {
  const extracted = { source: 'none' as const, suggestions: [] };
  const base = { actorId: 'actor_1', now: NOW };

  const empty = confirmFacts({ fields: { entity: '   ' }, extracted }, base);
  assert.equal(empty.ok === false && empty.error.code, 'empty_confirmation');

  const future = confirmFacts({ fields: { occurredAt: String(NOW + 1) }, extracted }, base);
  assert.equal(future.ok === false && future.error.code, 'occurred_in_future');

  const long = confirmFacts({ fields: { title: 'x'.repeat(200) }, extracted }, base);
  assert.equal(long.ok === false && long.error.code, 'title_too_long');
});

test('an extraction record round-trips, and junk in it is dropped rather than trusted', () => {
  const outcome = extractFacts({ text: 'Northwind lost my bag.', source: 'voice', aliases, categories, now: NOW });
  const restored = recordToExtraction(extractionToRecord(outcome));
  assert.equal(restored.source, 'voice');
  assert.deepEqual(
    restored.suggestions.map((s) => s.field),
    outcome.suggestions.map((s) => s.field),
  );

  const junk = recordToExtraction({
    source: 'nonsense',
    suggestions: [{ field: 'not_a_field', value: 'x' }, { value: 'no field' }, 'a string'],
  });
  assert.equal(junk.source, 'none');
  assert.deepEqual(junk.suggestions, []);
});

// ── Terms ────────────────────────────────────────────────────────────────
test('terms drop stopwords and short tokens, which would fake similarity', () => {
  const terms = extractTerms('The refund was not processed and they were very rude about it.');
  assert.ok(terms.includes('refund'));
  assert.ok(terms.includes('processed'));
  assert.equal(terms.includes('the'), false);
  assert.equal(terms.includes('was'), false);
  assert.equal(terms.includes('very'), false);
});

test('repeating a word does not make an account more similar', () => {
  assert.deepEqual(extractTerms('refund refund refund'), ['refund']);
});

// ── Trust: internal, and never derived from tone ─────────────────────────
const trustInputs = (overrides: Partial<TrustInputs> = {}): TrustInputs => ({
  accountAgeMs: 60 * 24 * 60 * 60 * 1_000,
  publishedExperiences: 3,
  activeCorroborations: 2,
  retractedCorroborations: 0,
  upheldReports: 0,
  dismissedReports: 0,
  moderationRemovals: 0,
  evidenceAttached: 0,
  evidenceContradicted: 0,
  riskFlags: [],
  ...overrides,
});

test('trust is three separate confidences, not one score', () => {
  const assessment = assessTrust(trustInputs());
  assert.ok(assessment.accountConfidence > 0);
  assert.ok(assessment.contributionConfidence > 0);
  assert.ok(assessment.evidenceConfidence > 0);
  assert.equal(
    Object.keys(assessment).includes('score'),
    false,
    'a single trust score is exactly what must not exist',
  );
});

test('a new account with a well-supported contribution is not penalised as a contributor', () => {
  const fresh = assessTrust(trustInputs({ accountAgeMs: 0, publishedExperiences: 1, upheldReports: 3 }));
  const old = assessTrust(trustInputs({ accountAgeMs: 365 * 24 * 60 * 60 * 1_000, publishedExperiences: 1, upheldReports: 3 }));
  assert.ok(fresh.accountConfidence < old.accountConfidence, 'account age is an account fact');
  assert.equal(
    fresh.contributionConfidence,
    old.contributionConfidence,
    'being new says nothing about whether this contribution holds up',
  );
});

test('retraction churn lowers contribution confidence; retracting once does not', () => {
  const once = assessTrust(trustInputs({ activeCorroborations: 9, retractedCorroborations: 1 }));
  const churn = assessTrust(trustInputs({ activeCorroborations: 1, retractedCorroborations: 9 }));
  assert.ok(churn.contributionConfidence < once.contributionConfidence);
  assert.ok(churn.rationale.some((line) => line.includes('retracted')));
});

test('contradicted evidence is the strongest negative, and it is explained', () => {
  const clean = assessTrust(trustInputs({ evidenceAttached: 2 }));
  const contradicted = assessTrust(trustInputs({ evidenceAttached: 2, evidenceContradicted: 2 }));
  assert.ok(contradicted.evidenceConfidence < clean.evidenceConfidence);
  assert.ok(contradicted.rationale.some((line) => line.includes('contradicted')));
});

test('every confidence stays within bounds however extreme the inputs', () => {
  const worst = assessTrust(
    trustInputs({
      accountAgeMs: 0,
      publishedExperiences: 0,
      retractedCorroborations: 50,
      dismissedReports: 50,
      moderationRemovals: 50,
      evidenceContradicted: 50,
    }),
  );
  const best = assessTrust(
    trustInputs({
      accountAgeMs: 10 * 365 * 24 * 60 * 60 * 1_000,
      publishedExperiences: 500,
      upheldReports: 500,
      evidenceAttached: 500,
    }),
  );
  for (const value of [
    worst.accountConfidence,
    worst.contributionConfidence,
    worst.evidenceConfidence,
    best.accountConfidence,
    best.contributionConfidence,
    best.evidenceConfidence,
  ]) {
    assert.ok(value >= 0 && value <= 1, `${value} out of bounds`);
  }
});

// ── Abuse detection: a flag, never an action ─────────────────────────────
test('many distinct people corroborating within minutes is flagged for review', () => {
  const corroborations = Array.from({ length: BURST_THRESHOLD }, (_unused, index) => ({
    corroboratorId: `actor_${index}`,
    createdAt: NOW + index * 1_000,
    type: 're_rage' as const,
  }));
  const burst = detectCoordinatedBurst(corroborations);
  assert.equal(burst.detected, true);
  assert.equal(burst.count, BURST_THRESHOLD);
});

test('the same volume spread over days is not a burst', () => {
  const day = 24 * 60 * 60 * 1_000;
  const corroborations = Array.from({ length: BURST_THRESHOLD + 3 }, (_unused, index) => ({
    corroboratorId: `actor_${index}`,
    createdAt: NOW + index * day,
    type: 're_rage' as const,
  }));
  assert.equal(detectCoordinatedBurst(corroborations).detected, false);
});

test('below the threshold nothing is flagged, however fast', () => {
  const corroborations = Array.from({ length: BURST_THRESHOLD - 1 }, (_unused, index) => ({
    corroboratorId: `actor_${index}`,
    createdAt: NOW,
    type: 're_rage' as const,
  }));
  assert.equal(detectCoordinatedBurst(corroborations).detected, false);
});
