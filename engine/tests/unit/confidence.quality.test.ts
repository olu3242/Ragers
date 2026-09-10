import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessConfidence,
  CONFIDENCE_BANDS,
  CONFIDENCE_FACTORS,
  CONFIDENCE_PERSON_FLOOR,
  CONFIDENCE_STALE_AFTER_MS,
  confidenceAdjustsCorroborationCount,
  confidenceIsAScore,
  confidenceMovement,
  confidenceSeries,
  explainConfidence,
  FORBIDDEN_CONFIDENCE_INPUTS,
  trustScoreEntersConfidence,
  type ConfidenceInput,
} from '../../src/domain/confidence.ts';
import {
  assessResolutionQuality,
  assessResponseQuality,
  explainQuality,
  qualityIsAScore,
  qualityRanksOrganizations,
  qualityReadsTrustScore,
  responseQualityMeasure,
  QUALITY_BANDS,
  type ResolutionQualityInput,
  type ResponseQualityInput,
} from '../../src/domain/quality.ts';

/**
 * Phases 81, 82, 84 and 85 — the pure parts.
 *
 * The band's whole claim is that trust and quality can be *stated* without becoming scores
 * about people. That claim is only checkable if the deciding functions are pure, which is why
 * every assertion here is over hand-built inputs.
 */
const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = join(here, '..', '..');
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const input = (over: Partial<ConfidenceInput> = {}): ConfidenceInput => ({
  independentPeople: 5,
  selfContributions: 0,
  duplicateRows: 0,
  evidencePresent: 1,
  evidenceContradicted: 0,
  coordinationSuspected: false,
  mostRecentContributionAt: NOW,
  clusterConsistency: 1,
  now: NOW,
  ...over,
});

// ── Phase 81: the count is a count ───────────────────────────────────────
test('self-corroboration cannot inflate confidence', () => {
  // One actor cannot manufacture confidence, and the discard is *visible* rather than
  // silently ignored — an author who corroborated their own experience twenty times sees
  // twenty discarded, not a higher band.
  const alone = assessConfidence(input({ independentPeople: 1, selfContributions: 20 }));
  assert.equal(alone.band, 'insufficient', 'twenty of your own claims is one person');
  assert.equal(alone.discarded.self, 20);
  assert.equal(alone.independentPeople, 1, 'and the count is unchanged by the discarding');
});

test('duplicate rows cannot inflate unique people', () => {
  const duplicated = assessConfidence(input({ independentPeople: 2, duplicateRows: 40 }));
  assert.equal(duplicated.band, 'insufficient', 'forty rows from two people is two people');
  assert.equal(duplicated.discarded.duplicates, 40);
});

test('confidence never adjusts the corroboration count', () => {
  // The central rule of the phase, and the reason it was renamed from "trust-weighted
  // corroboration": a weighted count would stop being a count of people, and the guarantee
  // `EXPERIENCE_SIGNAL_ENGINE_READY` attests is that it is one.
  for (const people of [0, 1, 3, 40]) {
    assert.equal(assessConfidence(input({ independentPeople: people })).independentPeople, people);
  }
  assert.equal(confidenceAdjustsCorroborationCount(), undefined);
});

test('below the person floor nothing is stated, and it is not called low', () => {
  // `insufficient` rather than a low band: "we do not know" and "this is weakly supported"
  // are different statements, and the second one is a finding.
  const thin = assessConfidence(input({ independentPeople: CONFIDENCE_PERSON_FLOOR - 1 }));
  assert.equal(thin.band, 'insufficient');
  assert.match(explainConfidence(thin), /so nothing is stated/);
});

test('contradicted evidence lowers confidence, and caps it', () => {
  // The strongest single negative, because it is a checkable disagreement rather than an
  // inference. It caps rather than subtracting, so no amount of volume overrides it.
  const many = assessConfidence(input({ independentPeople: 200, evidenceContradicted: 1 }));
  assert.equal(many.band, 'limited', 'two hundred people do not outvote a contradiction');
  assert.ok(
    many.reasons.some((reason) => reason.factor === 'evidence_contradicted' && reason.direction === 'lowers'),
  );
});

test('a set under coordination review is capped, and no claim is touched', () => {
  const suspected = assessConfidence(input({ independentPeople: 40, coordinationSuspected: true }));
  assert.equal(suspected.band, 'limited', 'capped until a person has looked');
  assert.equal(suspected.independentPeople, 40, 'and not one claim was discounted');
});

test('stale contributions lower confidence and mark it not current', () => {
  const stale = assessConfidence(
    input({ mostRecentContributionAt: NOW - CONFIDENCE_STALE_AFTER_MS - DAY }),
  );
  assert.equal(stale.current, false);
  assert.equal(stale.band, 'limited', 'a pattern that stopped is not strongly supported now');
});

test('no evidence is neutral, because most accounts have none', () => {
  // Absence of evidence is not evidence of absence, and treating it as a negative would
  // penalise everybody who experienced something without documenting it.
  const bare = assessConfidence(input({ evidencePresent: 0 }));
  const withEvidence = assessConfidence(input({ evidencePresent: 3 }));
  assert.equal(
    bare.reasons.find((reason) => reason.factor === 'evidence_present')?.direction,
    'neutral',
  );
  assert.equal(bare.band, 'moderate');
  assert.equal(withEvidence.band, 'moderate', 'and evidence alone does not reach strong');
});

test('strong needs both volume and something openable', () => {
  const strong = assessConfidence(
    input({ independentPeople: CONFIDENCE_PERSON_FLOOR * 2, evidencePresent: 1 }),
  );
  assert.equal(strong.band, 'strong');
  const volumeOnly = assessConfidence(
    input({ independentPeople: CONFIDENCE_PERSON_FLOOR * 2, evidencePresent: 0 }),
  );
  assert.equal(volumeOnly.band, 'moderate', 'volume alone is moderate');
});

test('every factor is reported, including the ones that did nothing', () => {
  // A subset would let a surface show only the negatives, or only the positives, and either
  // is a different claim from the one the band makes.
  const reported = assessConfidence(input()).reasons.map((reason) => reason.factor);
  assert.deepEqual([...reported].sort(), [...CONFIDENCE_FACTORS].sort());
});

test('the band is ordinal and there is no number behind it', () => {
  assert.equal(confidenceIsAScore(), false);
  const serialised = JSON.stringify(assessConfidence(input()));
  assert.equal(/"band":"[a-z]+"/.test(serialised), true);
  assert.equal(/"score"|"weight"|"confidenceValue"/.test(serialised), false);
});

test('no per-person trust figure may enter a confidence', () => {
  // The rule that keeps a new account's honest claim worth what an established account's is.
  // Scanned for a *read*, following the Phase 73 correction: a guard that flags a prohibition
  // forces the prohibitions out and takes their reasons with them.
  const modules = ['src/domain/confidence.ts', 'src/engines/confidence.engine.ts'];
  const reads = ['store.trustAssessments', 'accountConfidence', 'contributionConfidence', 'store.reputation'];
  const offenders: string[] = [];
  for (const relative of modules) {
    const source = readFileSync(join(engineRoot, relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const read of reads) {
      if (source.includes(read)) offenders.push(`${relative} reads ${read}`);
    }
  }
  assert.deepEqual(offenders, [], 'confidence reads facts about claims, never scores about claimants');
  assert.equal(trustScoreEntersConfidence(), false);
  // And the prohibitions are still written down, with their reasons.
  for (const forbidden of ['account_confidence', 'account_age', 'reputation', 'engagement']) {
    assert.ok((FORBIDDEN_CONFIDENCE_INPUTS[forbidden] ?? '').length > 40, `${forbidden} says why`);
  }
});

// ── Phase 82: the series ─────────────────────────────────────────────────
test('a series is deterministic, and boundary order does not matter', () => {
  // Each point counts the whole set as of its own boundary rather than folding forward, which
  // is what makes replay safe: there is no accumulator to double-apply.
  const boundaries = [NOW - 10 * DAY, NOW - 5 * DAY, NOW];
  const at = (boundary: number): ConfidenceInput => input({ now: boundary });
  const once = confidenceSeries(boundaries, at);
  const reversed = confidenceSeries([...boundaries].reverse(), at);
  assert.deepEqual(once, reversed, 'any order gives the same series');
  assert.deepEqual(
    once.map((point) => point.at),
    [...boundaries].sort((left, right) => left - right),
    'and it is ordered oldest first',
  );
});

test('replaying a boundary produces the identical point', () => {
  const twice = confidenceSeries([NOW, NOW], () => input());
  assert.equal(twice.length, 2, 'the pure function does not deduplicate');
  assert.deepEqual(twice[0], twice[1], 'but the points are identical, so a key absorbs the replay');
});

test('confidence movement is a direction, never a delta over bands', () => {
  // "Moderate minus limited" is not a quantity, and subtracting over an ordinal scale is how a
  // band quietly becomes a score.
  const rising = confidenceSeries([NOW - DAY, NOW], (boundary) =>
    input({
      now: boundary,
      independentPeople: boundary === NOW ? 8 : 3,
      evidencePresent: boundary === NOW ? 2 : 0,
    }),
  );
  const first = rising[0];
  const second = rising[1];
  assert.ok(first && second);
  assert.equal(confidenceMovement(first, second), 'rose');
  assert.equal(confidenceMovement(second, first), 'fell');
  assert.equal(confidenceMovement(first, first), 'held');
});

test('every point carries the reason its band landed there', () => {
  for (const point of confidenceSeries([NOW], () => input())) {
    assert.ok(point.deciding.length > 10, 'a history without explanations is a graph nobody can use');
  }
  assert.deepEqual([...CONFIDENCE_BANDS], ['insufficient', 'limited', 'moderate', 'strong']);
});

// ── Phase 84: response quality is not responsiveness ─────────────────────
const responseInput = (over: Partial<ResponseQualityInput> = {}): ResponseQualityInput => ({
  cases: 10,
  acknowledged: 10,
  actionDescribed: 6,
  outcomesAccepted: 6,
  outcomesReported: 8,
  recurrences: 0,
  agingOpen: 0,
  ...over,
});

test('a fast non-answer does not read as good', () => {
  // The whole reason Phase 84 is not Phase 39. Acknowledging every case within the hour and
  // doing nothing is excellent responsiveness and bad response quality, and a measure that
  // could not tell them apart would teach organizations to reply quickly and act never.
  const formLetters = assessResponseQuality(
    responseInput({ acknowledged: 10, actionDescribed: 0, outcomesAccepted: 0, outcomesReported: 8 }),
  );
  assert.notEqual(formLetters.band, 'good');
  assert.ok(
    formLetters.reasons.some(
      (reason) => reason.dimension === 'action_described' && reason.direction === 'lowers',
    ),
    'and it says which dimension is missing',
  );
});

test('recurrence lowers response quality, because it means it did not work', () => {
  const recurred = assessResponseQuality(responseInput({ recurrences: 3 }));
  const clean = assessResponseQuality(responseInput());
  assert.ok(
    recurred.reasons.some((reason) => reason.dimension === 'recurrence' && reason.direction === 'lowers'),
  );
  assert.equal(clean.band, 'good');
  assert.notEqual(recurred.band, 'good');
});

test('response quality is withheld for a tiny sample', () => {
  // Below the floor the band is `insufficient`. "We do not know" and "they are bad at this"
  // are opposite statements and the second is defamatory.
  const tiny = assessResponseQuality(responseInput({ cases: 2, acknowledged: 2, actionDescribed: 0 }));
  const withheld = responseQualityMeasure(tiny);
  assert.equal(withheld.withheld, true);
  assert.equal(withheld.withheld === true && withheld.shortBy > 0, true, 'and it says how short');
});

// ── Phase 85: resolved != well resolved ──────────────────────────────────
const resolutionInput = (over: Partial<ResolutionQualityInput> = {}): ResolutionQualityInput => ({
  statusResolved: true,
  reportsResolved: 4,
  reportsPartial: 0,
  reportsUnresolved: 0,
  openDisputes: 0,
  upheldDisputes: 0,
  recurrences: 0,
  followUpResponses: 1,
  evidenceAttached: 1,
  ...over,
});

test('resolved and disputed is never high quality, and both facts are visible', () => {
  // The single most important rule in the module. A status of resolved with a dispute against
  // it is a contested account, and showing it as a success takes one party's word for it.
  const contested = assessResolutionQuality(resolutionInput({ upheldDisputes: 1 }));
  assert.equal(contested.statusResolved, true, 'the status is carried through');
  assert.notEqual(contested.band, 'good', 'and the band is not good');
  assert.match(explainQuality(contested), /dispute/);
});

test('a partial resolution is not a resolution', () => {
  const partial = assessResolutionQuality(resolutionInput({ reportsResolved: 2, reportsPartial: 3 }));
  assert.equal(partial.band, 'mixed');
  assert.ok(
    partial.reasons.some((reason) => reason.dimension === 'completeness' && reason.direction === 'lowers'),
  );
});

test('recurrence makes a resolution poor, whatever the reports said', () => {
  const recurred = assessResolutionQuality(resolutionInput({ recurrences: 2 }));
  assert.equal(recurred.band, 'poor', 'it happened again, so it was not resolved well');
});

test('nobody having reported an outcome is insufficient, not good', () => {
  const silent = assessResolutionQuality(
    resolutionInput({ reportsResolved: 0, reportsPartial: 0, reportsUnresolved: 0 }),
  );
  assert.equal(silent.band, 'insufficient');
  assert.match(explainQuality(silent), /not enough has been reported/);
});

test('a clean, accepted, followed-up resolution is good', () => {
  assert.equal(assessResolutionQuality(resolutionInput()).band, 'good');
});

test('quality is bands and dimensions, never a score or a ranking', () => {
  assert.equal(qualityIsAScore(), false);
  assert.equal(qualityRanksOrganizations(), undefined);
  assert.equal(qualityReadsTrustScore(), false);
  assert.deepEqual([...QUALITY_BANDS], ['insufficient', 'poor', 'mixed', 'good']);
  const serialised = JSON.stringify(assessResolutionQuality(resolutionInput()));
  assert.equal(/"score"|"rank"|"percentile"/.test(serialised), false);
});

test('no quality measure reads a per-person trust figure', () => {
  const modules = ['src/domain/quality.ts', 'src/engines/quality.engine.ts'];
  const offenders: string[] = [];
  for (const relative of modules) {
    const source = readFileSync(join(engineRoot, relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const read of ['store.trustAssessments', 'accountConfidence', 'contributionConfidence']) {
      if (source.includes(read)) offenders.push(`${relative} reads ${read}`);
    }
  }
  assert.deepEqual(offenders, [], 'quality is about what happened, not about who');
});
