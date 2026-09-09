import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterKeyOf,
  clusterKeyMatches,
  computeFactors,
  isClusterable,
  matchExperiences,
  SAME_EXPERIENCE_WINDOW_MS,
  scoreFactors,
  temporalProximity,
  termSimilarity,
  type MatchCandidate,
} from '../../src/domain/matching.ts';
import { computeSignal, highestConcentration, isTrending, median } from '../../src/domain/signal.ts';
import {
  applyResolution,
  canTransitionResolution,
  resolutionFromReports,
  RESOLUTION_STATUSES,
  signalStatusFor,
  tallyReports,
  type ResolutionReport,
} from '../../src/domain/resolution.ts';

const NOW = 1_700_000_000_000;

/**
 * Builder for match candidates. An override of `undefined` means "this
 * identifier is not known", which is a distinct case from disagreement in the
 * matcher, so it deletes the field rather than setting it to undefined.
 */
const candidate = (
  overrides: { readonly [K in keyof MatchCandidate]?: MatchCandidate[K] | undefined } = {},
): MatchCandidate => {
  const row: Record<string, unknown> = {
    entityId: 'ent_air',
    categoryId: 'cat_travel',
    issueTypeId: 'iss_refund',
    locationId: 'loc_dfw',
    occurredAt: NOW,
    terms: ['refund', 'delay', 'weeks'],
  };
  for (const [field, value] of Object.entries(overrides)) {
    if (value === undefined) delete row[field];
    else row[field] = value;
  }
  return row as unknown as MatchCandidate;
};

// ── Matching ─────────────────────────────────────────────────────────────
test('full agreement is the same experience', () => {
  const result = matchExperiences(candidate(), candidate());
  assert.equal(result.relationship, 'same_experience');
  assert.ok(result.score > 0.9);
  assert.match(result.rationale, /same entity and issue/);
});

test('a different entity is disqualifying, however similar the wording', () => {
  const result = matchExperiences(
    candidate(),
    candidate({ entityId: 'ent_other' }),
  );
  assert.equal(result.relationship, 'no_match', 'different organizations are different experiences');
  assert.match(result.rationale, /different entities/);
});

test('a semantic score alone never produces a match', () => {
  // Identical wording, but neither side names an entity, category or issue.
  const left: MatchCandidate = { terms: ['refund', 'delay', 'weeks'] };
  const right: MatchCandidate = { terms: ['refund', 'delay', 'weeks'] };
  const result = matchExperiences(left, right);

  assert.equal(result.factors.semantic, 1, 'the text is identical');
  assert.notEqual(result.relationship, 'same_experience', 'identical text is not proof of the same experience');
  assert.match(result.rationale, /deterministic agreement/);
});

test('the same entity and issue at a different time is similar, not the same', () => {
  const result = matchExperiences(
    candidate(),
    candidate({ occurredAt: NOW - SAME_EXPERIENCE_WINDOW_MS - 1 }),
  );
  assert.equal(result.relationship, 'similar_experience');
  assert.equal(result.factors.temporal, 0, 'outside the window');
});

test('the same entity at a different place is similar, not the same', () => {
  const result = matchExperiences(candidate(), candidate({ locationId: 'loc_lhr' }));
  assert.equal(result.relationship, 'similar_experience');
});

test('the same entity with a different issue but comparable wording is similar', () => {
  const result = matchExperiences(
    candidate(),
    candidate({ issueTypeId: 'iss_baggage', terms: ['refund', 'delay', 'baggage'] }),
  );
  assert.equal(result.relationship, 'similar_experience');
});

test('a shared category with comparable wording is related', () => {
  const result = matchExperiences(
    candidate({ entityId: undefined }),
    candidate({ entityId: undefined, issueTypeId: 'iss_other' }),
  );
  assert.equal(result.relationship, 'related_experience');
});

test('unknown identifiers are treated as unknown, not as agreement', () => {
  const factors = computeFactors(candidate(), candidate({ entityId: undefined }));
  assert.equal(factors.entity, 0.5, 'unknown sits between agreement and disagreement');
  assert.notEqual(factors.entity, 1);
});

test('term similarity is symmetric and bounded', () => {
  assert.equal(termSimilarity(['a', 'b'], ['a', 'b']), 1);
  assert.equal(termSimilarity(['a'], ['b']), 0);
  assert.equal(termSimilarity([], ['a']), 0, 'no terms means no similarity, not perfect similarity');
  assert.equal(termSimilarity(['a', 'b'], ['b', 'a']), termSimilarity(['b', 'a'], ['a', 'b']));
  assert.equal(termSimilarity(['a', 'b', 'c'], ['a', 'b']), 0.6667);
});

test('temporal proximity decays to zero across the window', () => {
  const day = 24 * 60 * 60 * 1_000;
  assert.equal(temporalProximity(NOW, NOW), 1);
  assert.equal(temporalProximity(NOW, NOW - SAME_EXPERIENCE_WINDOW_MS), 0);
  assert.equal(temporalProximity(NOW, NOW + SAME_EXPERIENCE_WINDOW_MS), 0, 'direction does not matter');

  // Decays monotonically at a scale that matters. The factor is rounded to four
  // decimals over a 90-day window, so it moves in roughly two-hour steps —
  // deliberate, because a few seconds between two accounts of the same incident
  // is not evidence of anything.
  assert.ok(temporalProximity(NOW, NOW - day) > temporalProximity(NOW, NOW - 2 * day));
  assert.ok(temporalProximity(NOW, NOW - 30 * day) > temporalProximity(NOW, NOW - 60 * day));
  assert.equal(
    temporalProximity(NOW, NOW - 1_000),
    temporalProximity(NOW, NOW - 2_000),
    'sub-hour differences are deliberately indistinguishable',
  );

  assert.equal(temporalProximity(NOW, undefined), 0.5, 'unknown is not disagreement');
  assert.equal(temporalProximity(undefined, undefined), 0.5);
});

test('the score is deterministic and weighted toward the facts', () => {
  const factors = computeFactors(candidate(), candidate());
  assert.equal(scoreFactors(factors), scoreFactors(factors));

  // Entity and issue together outweigh everything else.
  const factsOnly = { entity: 1, issue: 1, category: 0, semantic: 0, temporal: 0, geographic: 0 };
  const textOnly = { entity: 0, issue: 0, category: 1, semantic: 1, temporal: 1, geographic: 1 };
  assert.ok(scoreFactors(factsOnly) > 0.5);
  assert.ok(scoreFactors(factsOnly) > scoreFactors(textOnly) - 0.01);
});

test('a cluster key is the pattern, and needs an entity to be meaningful', () => {
  const key = clusterKeyOf('rage', candidate());
  assert.deepEqual(key, {
    kind: 'rage',
    entityId: 'ent_air',
    categoryId: 'cat_travel',
    issueTypeId: 'iss_refund',
  });
  assert.ok(clusterKeyMatches(key, clusterKeyOf('rage', candidate())));
  assert.equal(clusterKeyMatches(key, clusterKeyOf('rave', candidate())), false, 'kind is part of the pattern');
  assert.ok(isClusterable(key));
  assert.equal(isClusterable(clusterKeyOf('rage', candidate({ entityId: undefined }))), false);
});

// ── Resolution ───────────────────────────────────────────────────────────
test('the resolution lifecycle allows the documented paths', () => {
  assert.deepEqual([...RESOLUTION_STATUSES], [
    'open', 'gaining_signal', 'acknowledged', 'under_review',
    'resolved', 'partially_resolved', 'disputed', 'reopened',
  ]);
  assert.ok(canTransitionResolution('open', 'gaining_signal'));
  assert.ok(canTransitionResolution('acknowledged', 'under_review'));
  assert.ok(canTransitionResolution('under_review', 'resolved'));
  assert.ok(canTransitionResolution('under_review', 'partially_resolved'));
  assert.ok(canTransitionResolution('resolved', 'reopened'), 'resolution is not permanent');
  assert.ok(canTransitionResolution('partially_resolved', 'resolved'));
  assert.equal(canTransitionResolution('open', 'resolved'), false, 'resolution needs a path through review');
  assert.equal(canTransitionResolution('resolved', 'open'), false);
});

test('an organization response can never mark an experience resolved', () => {
  for (const to of ['resolved', 'partially_resolved'] as const) {
    const result = applyResolution({ current: 'under_review', to, source: 'organization' });
    assert.equal(result.ok, false, `an organization must not set ${to}`);
    if (!result.ok) assert.equal(result.error.code, 'organization_cannot_resolve');
  }

  // It may acknowledge and review, which is the legitimate reach.
  assert.ok(applyResolution({ current: 'open', to: 'acknowledged', source: 'organization' }).ok);
  assert.ok(applyResolution({ current: 'acknowledged', to: 'under_review', source: 'organization' }).ok);
  // And the experiencers may resolve it.
  assert.ok(applyResolution({ current: 'under_review', to: 'resolved', source: 'experiencer' }).ok);
});

test('resolution is derived from what experiencers reported', () => {
  const report = (reporterId: string, kind: ResolutionReport['kind']): ResolutionReport => ({
    id: `rr_${reporterId}`,
    experienceId: 'exp_1',
    reporterId,
    kind,
    reportedAt: NOW,
  });

  assert.equal(resolutionFromReports([]), undefined, 'no reports justify no change');

  // Everyone made whole → resolved.
  assert.equal(
    resolutionFromReports([report('a', 'resolved_for_me'), report('b', 'resolved_for_me')]),
    'resolved',
  );

  // One person made whole is not the pattern being fixed.
  assert.equal(
    resolutionFromReports([report('a', 'resolved_for_me'), report('b', 'still_unresolved')]),
    'partially_resolved',
  );
  assert.equal(resolutionFromReports([report('a', 'partially_resolved')]), 'partially_resolved');
  assert.equal(
    resolutionFromReports([report('a', 'still_unresolved'), report('b', 'still_unresolved')]),
    undefined,
    'still unresolved is not a new state',
  );
});

test('the report tally reports the resolved share', () => {
  const reports: ResolutionReport[] = [
    { id: '1', experienceId: 'e', reporterId: 'a', kind: 'resolved_for_me', reportedAt: NOW },
    { id: '2', experienceId: 'e', reporterId: 'b', kind: 'resolved_for_me', reportedAt: NOW },
    { id: '3', experienceId: 'e', reporterId: 'c', kind: 'still_unresolved', reportedAt: NOW },
  ];
  const tally = tallyReports(reports);
  assert.equal(tally.resolved, 2);
  assert.equal(tally.unresolved, 1);
  assert.equal(tally.reporters, 3);
  assert.equal(tally.resolvedShare, 0.6667);
});

test('volume alone moves an open experience to gaining signal, and no further', () => {
  assert.equal(signalStatusFor('open', 2), undefined, 'below the threshold');
  assert.equal(signalStatusFor('open', 3), 'gaining_signal');
  assert.equal(signalStatusFor('acknowledged', 100), undefined, 'volume does not override a human step');
});

// ── Signal ───────────────────────────────────────────────────────────────
const experience = (overrides: Partial<Parameters<typeof computeSignal>[0]['experiences'][number]> = {}) => ({
  id: 'exp_1',
  kind: 'rage' as const,
  actorId: 'actor_1',
  publishedAt: NOW - 1_000,
  hasVoice: false,
  hasNarrative: true,
  hasEvidence: false,
  resolutionStatus: 'open',
  reopenedCount: 0,
  ...overrides,
});

const corroboration = (overrides: Partial<Parameters<typeof computeSignal>[0]['corroborations'][number]> = {}) => ({
  experienceId: 'exp_1',
  corroboratorId: 'actor_2',
  type: 're_rage' as const,
  createdAt: NOW - 500,
  hasVoice: false,
  hasNarrative: false,
  hasEvidence: false,
  ...overrides,
});

test('unique experiencers counts authors and corroborators once each', () => {
  const metrics = computeSignal({
    experiences: [experience(), experience({ id: 'exp_2', actorId: 'actor_3' })],
    corroborations: [
      corroboration({ corroboratorId: 'actor_2' }),
      corroboration({ experienceId: 'exp_2', corroboratorId: 'actor_2' }),
      corroboration({ experienceId: 'exp_2', corroboratorId: 'actor_4' }),
    ],
    reports: [],
    respondedExperienceIds: [],
    now: NOW,
  });

  // actor_1, actor_3 (authors) + actor_2, actor_4 (corroborators) = 4 people.
  assert.equal(metrics.uniqueExperiencers, 4, 'the same person corroborating twice is still one person');
  assert.equal(metrics.rageCount, 2);
  assert.equal(metrics.reRageCount, 3);
  assert.equal(metrics.reRaveCount, 0);
});

test('support counts describe what was attached, never what was verified', () => {
  const metrics = computeSignal({
    experiences: [experience({ hasNarrative: true, hasVoice: true, hasEvidence: true })],
    corroborations: [
      corroboration({ hasNarrative: true }),
      corroboration({ corroboratorId: 'actor_3', hasEvidence: true }),
    ],
    reports: [],
    respondedExperienceIds: [],
    now: NOW,
  });
  assert.equal(metrics.contextSupportedCount, 2);
  assert.equal(metrics.voiceSupportedCount, 1);
  assert.equal(metrics.evidenceSupportedCount, 2);
  // The metric vocabulary contains nothing that reads as a verification claim.
  assert.equal(Object.keys(metrics).some((key) => /verified/i.test(key)), false);
});

test('resolution rate reflects experiencer reports, not organization responses', () => {
  const metrics = computeSignal({
    experiences: [experience()],
    corroborations: [corroboration()],
    reports: [
      { id: '1', experienceId: 'exp_1', reporterId: 'actor_1', kind: 'resolved_for_me', reportedAt: NOW },
      { id: '2', experienceId: 'exp_1', reporterId: 'actor_2', kind: 'still_unresolved', reportedAt: NOW },
    ],
    // The organization responded, which must not move the resolution rate.
    respondedExperienceIds: ['exp_1'],
    now: NOW,
  });
  assert.equal(metrics.responseRate, 1, 'the organization did respond');
  assert.equal(metrics.resolutionRate, 0.5, 'but only half the experiencers say it was resolved');
});

test('signal metrics are deterministic and recomputed, so retries cannot drift', () => {
  const inputs = {
    experiences: [experience()],
    corroborations: [corroboration(), corroboration({ corroboratorId: 'actor_3' })],
    reports: [],
    respondedExperienceIds: [],
    now: NOW,
  };
  assert.deepEqual(computeSignal(inputs), computeSignal(inputs), 'the same rows give the same answer');
});

test('growth and acceleration are computed over windows', () => {
  const month = 30 * 24 * 60 * 60 * 1_000;
  const metrics = computeSignal({
    experiences: [experience({ publishedAt: NOW - 2.5 * month })],
    corroborations: [
      corroboration({ createdAt: NOW - 1.5 * month }),
      corroboration({ corroboratorId: 'a', createdAt: NOW - 0.5 * month }),
      corroboration({ corroboratorId: 'b', createdAt: NOW - 0.4 * month }),
      corroboration({ corroboratorId: 'c', createdAt: NOW - 0.3 * month }),
    ],
    reports: [],
    respondedExperienceIds: [],
    now: NOW,
  });
  assert.ok(metrics.growthRate > 0, 'three claims this window against one last window is growth');
  assert.equal(typeof metrics.signalAcceleration, 'number');
});

test('geographic concentration reports where claims cluster', () => {
  const metrics = computeSignal({
    experiences: [experience({ locationId: 'loc_dfw' })],
    corroborations: [
      corroboration({ locationId: 'loc_dfw' }),
      corroboration({ corroboratorId: 'a', locationId: 'loc_dfw' }),
      corroboration({ corroboratorId: 'b', locationId: 'loc_lhr' }),
    ],
    reports: [],
    respondedExperienceIds: [],
    now: NOW,
  });
  assert.deepEqual(metrics.geographicConcentration, { loc_dfw: 3, loc_lhr: 1 });
  assert.deepEqual(highestConcentration(metrics.geographicConcentration), { locationId: 'loc_dfw', count: 3 });
  assert.equal(highestConcentration({}), undefined);
});

test('median resolution time ignores unresolved experiences', () => {
  const day = 24 * 60 * 60 * 1_000;
  const metrics = computeSignal({
    experiences: [
      experience({ id: 'a', publishedAt: NOW - 10 * day, resolvedAt: NOW - 5 * day }),
      experience({ id: 'b', actorId: 'actor_9', publishedAt: NOW - 30 * day, resolvedAt: NOW - 9 * day }),
      experience({ id: 'c', actorId: 'actor_8', publishedAt: NOW - 3 * day }),
    ],
    corroborations: [],
    reports: [],
    respondedExperienceIds: [],
    now: NOW,
  });
  assert.equal(metrics.medianResolutionMs, Math.round((5 * day + 21 * day) / 2));
  assert.equal(median([]), undefined);
  assert.equal(median([3, 1, 2]), 2);
});

test('a trend needs both volume and growth', () => {
  const base = computeSignal({
    experiences: [experience()],
    corroborations: [corroboration()],
    reports: [],
    respondedExperienceIds: [],
    now: NOW,
  });
  assert.equal(isTrending({ ...base, uniqueExperiencers: 10, growthRate: 0 }), false, 'volume alone is history');
  assert.equal(isTrending({ ...base, uniqueExperiencers: 1, growthRate: 5 }), false, 'growth alone is noise');
  assert.ok(isTrending({ ...base, uniqueExperiencers: 10, growthRate: 0.5 }));
});

test('reopen rate tracks experiences that came back', () => {
  const metrics = computeSignal({
    experiences: [experience({ reopenedCount: 1 }), experience({ id: 'b', actorId: 'z', reopenedCount: 0 })],
    corroborations: [],
    reports: [],
    respondedExperienceIds: [],
    now: NOW,
  });
  assert.equal(metrics.reopenRate, 0.5);
});
