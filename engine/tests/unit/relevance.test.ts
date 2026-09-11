import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareRelevance,
  explainRelevance,
  fairnessFor,
  FAIRNESS_VOTE_FLOOR,
  FORBIDDEN_RELEVANCE_INPUTS,
  rankByRelevance,
  recencyBucketOf,
  RELEVANCE_PRECEDENCE,
  relevanceCompositeScore,
  trustAffectsRelevance,
  type RelevanceFactors,
} from '../../src/domain/relevance.ts';
import {
  FORBIDDEN_PROFILE_INPUTS,
  PROFILE_INPUTS,
  emptyProfile,
  explainProfile,
  profileIsEmpty,
  profileIsReadableByOthers,
  profileIsStored,
  profileRanksAnything,
} from '../../src/domain/relevance-profile.ts';

/**
 * Phases 73 and 74, the pure parts.
 *
 * The point of this band is that discovery can be useful without becoming an engagement
 * ranking, and the only way that claim is checkable is if the comparison is a pure function
 * somebody can read. So every ordering assertion here is over hand-built factors — no store,
 * no clock, no consumer.
 */
const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = join(here, '..', '..');
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const factors = (over: Partial<RelevanceFactors> = {}): RelevanceFactors => ({
  experienceId: 'exp_a',
  kind: 'rage',
  contextMatch: 'direct',
  corroboratingPeople: 0,
  recency: 'today',
  engagement: 0,
  publishedAt: NOW,
  ...over,
});

// ── The precedence, which is the whole argument ──────────────────────────
test('corroboration outranks engagement, whatever the engagement is', () => {
  // The central assertion of the band. Under the old composite, engagement carried a 0.5
  // weight and corroborations were summed into it — so forty taps beat four people saying it
  // happened to them. Here the number of people wins at any engagement level, because they
  // are different factors and one is above the other.
  const corroborated = factors({ experienceId: 'exp_real', corroboratingPeople: 4, engagement: 0 });
  const popular = factors({ experienceId: 'exp_loud', corroboratingPeople: 3, engagement: 10_000 });
  assert.ok(compareRelevance(corroborated, popular) < 0, 'people who lived it outrank people who reacted');
});

test('context outranks corroboration, so a widely-corroborated irrelevance does not win', () => {
  // Discovery is a question. Something that does not answer it is not the answer however
  // many people it happened to — and this is what keeps "what happens at this company" from
  // degrading into "the biggest story on the platform".
  const onTopic = factors({ experienceId: 'exp_topic', contextMatch: 'direct', corroboratingPeople: 1 });
  const offTopic = factors({ experienceId: 'exp_off', contextMatch: 'adjacent', corroboratingPeople: 90 });
  assert.ok(compareRelevance(onTopic, offTopic) < 0);
});

test('engagement decides only among candidates equal on everything above it', () => {
  const busier = factors({ experienceId: 'exp_busy', engagement: 12 });
  const quieter = factors({ experienceId: 'exp_quiet', engagement: 1 });
  assert.ok(compareRelevance(busier, quieter) < 0, 'as a tiebreak, it works');
  assert.match(explainRelevance(busier, quieter), /equal on everything that means something/);
});

test('the precedence is stated, closed, and puts engagement last', () => {
  assert.deepEqual(RELEVANCE_PRECEDENCE, [
    'context_match',
    'corroboration',
    'recency',
    'fairness',
    'engagement',
  ]);
  assert.equal(RELEVANCE_PRECEDENCE.at(-1), 'engagement', 'last, and the order is the argument');
});

// ── Fairness: withheld, not zero ─────────────────────────────────────────
test('fairness below its floor is withheld rather than defaulted to zero', () => {
  // The defect this replaces: `totalVotes === 0 ? 0` gave a brand-new experience the same
  // contribution as a unanimously-unfair one, at a 0.3 weight, so everything new was
  // suppressed by a number nobody had produced.
  assert.equal(fairnessFor(0, 0), undefined, 'no votes is no reading');
  assert.equal(fairnessFor(2, 1), undefined, 'and three votes is still below the floor');
  assert.equal(fairnessFor(4, 1), 0.8, 'at the floor it participates');
  assert.ok(FAIRNESS_VOTE_FLOOR >= 5, 'the floor is a real floor');
});

test('an unvoted experience is not ordered below a well-voted one on fairness alone', () => {
  // The failure the old code had: unvoted content sank. Here the two are equal at the
  // fairness step and fall through to engagement, so being new is not a penalty.
  const unvoted = factors({ experienceId: 'exp_new', engagement: 0 });
  const voted = factors({ experienceId: 'exp_voted', fairness: 0.95, engagement: 0 });
  assert.equal(
    compareRelevance(unvoted, voted) < 0,
    unvoted.experienceId < voted.experienceId,
    'they are equal on every factor, so only the stable id tiebreak separates them',
  );
});

test('two candidates that both have a fairness reading are ordered by it', () => {
  const fairer = factors({ experienceId: 'exp_fair', fairness: 0.9 });
  const less = factors({ experienceId: 'exp_less', fairness: 0.3 });
  assert.ok(compareRelevance(fairer, less) < 0);
  assert.match(explainRelevance(fairer, less), /thought it was fair/);
});

// ── Determinism and explainability ───────────────────────────────────────
test('ranking is deterministic for fixed inputs, including for equal candidates', () => {
  const set = [
    factors({ experienceId: 'exp_c' }),
    factors({ experienceId: 'exp_a' }),
    factors({ experienceId: 'exp_b' }),
  ];
  const once = rankByRelevance(set).map((row) => row.experienceId);
  const twice = rankByRelevance([...set].reverse()).map((row) => row.experienceId);
  assert.deepEqual(once, twice, 'the same set in a different order ranks the same');
  assert.deepEqual(once, ['exp_a', 'exp_b', 'exp_c'], 'and equal candidates fall to a stable id order');
});

test('recency is bucketed, so the ordering does not churn on every clock tick', () => {
  assert.equal(recencyBucketOf(NOW, NOW), 'today');
  assert.equal(recencyBucketOf(NOW - 3 * DAY, NOW), 'this_week');
  assert.equal(recencyBucketOf(NOW - 20 * DAY, NOW), 'this_month');
  assert.equal(recencyBucketOf(NOW - 60 * DAY, NOW), 'this_quarter');
  assert.equal(recencyBucketOf(NOW - 400 * DAY, NOW), 'older');
  // Two things published hours apart on the same day are equal on recency, which is what
  // stops a refresh reshuffling the page for no reason a reader could name.
  assert.equal(recencyBucketOf(NOW - 1000, NOW), recencyBucketOf(NOW - 60_000, NOW));
});

test('every ordered pair has a reason in words', () => {
  const pairs: readonly [RelevanceFactors, RelevanceFactors][] = [
    [factors({ contextMatch: 'direct' }), factors({ contextMatch: 'adjacent', experienceId: 'b' })],
    [factors({ corroboratingPeople: 5 }), factors({ corroboratingPeople: 1, experienceId: 'b' })],
    [factors({ recency: 'today' }), factors({ recency: 'older', experienceId: 'b' })],
    [factors({ fairness: 0.9 }), factors({ fairness: 0.2, experienceId: 'b' })],
    [factors({ engagement: 9 }), factors({ engagement: 1, experienceId: 'b' })],
    [factors({ experienceId: 'a' }), factors({ experienceId: 'b' })],
  ];
  for (const [above, below] of pairs) {
    const reason = explainRelevance(above, below);
    assert.ok(reason.length > 10, `a real sentence, got "${reason}"`);
    assert.equal(/\d+\.\d{3,}/.test(reason), false, `no opaque number in "${reason}"`);
  }
});

test('one person is described as a person, not as 1 people', () => {
  // Small, and it is the difference between a sentence somebody trusts and one that reads
  // like a template. The count is the trust primitive; it should not look generated.
  const one = factors({ corroboratingPeople: 1 });
  const none = factors({ corroboratingPeople: 0, experienceId: 'b' });
  assert.match(explainRelevance(one, none), /1 person said it happened to them/);
});

// ── The absences ─────────────────────────────────────────────────────────
test('there is no composite score, and trust does not rank', () => {
  assert.equal(relevanceCompositeScore(), undefined);
  assert.equal(trustAffectsRelevance(), false);
});

test('no forbidden input appears as a factor', () => {
  const factorNames = new Set(RELEVANCE_PRECEDENCE as readonly string[]);
  for (const forbidden of Object.keys(FORBIDDEN_RELEVANCE_INPUTS)) {
    assert.equal(factorNames.has(forbidden), false, `${forbidden} is not a ranking factor`);
  }
});

test('every forbidden input carries a reason somebody can argue with', () => {
  for (const [name, reason] of Object.entries(FORBIDDEN_RELEVANCE_INPUTS)) {
    assert.ok(reason.length > 40, `${name} says why, not just that`);
  }
});

test('no trust or reputation value is READ by the relevance modules', () => {
  // The discovery guard, in the Phase 48 pattern — but scanning for a **read** rather than a
  // mention, and the distinction was found by the guard failing on its own reinforcement.
  //
  // The first version looked for the bare identifiers `trustBand` and `reputation`, and
  // immediately flagged two lines: the `reputation` key in `FORBIDDEN_RELEVANCE_INPUTS` and
  // the `trustBand` key in `FORBIDDEN_DISCOVERY_FILTERS`. Both are *prohibitions*. A guard
  // that cannot tell a prohibition from a use would force the prohibitions out of the
  // codebase, taking their reasons with them — so the two lines most clearly enforcing the
  // rule would have been deleted to satisfy the test enforcing it.
  //
  // What actually matters is whether a value is fetched. Every store access in this codebase
  // goes through `deps.store.<table>`, so that is the shape to look for. A factor that ranked
  // by trust would have to read it, and it could not read it without one of these.
  const modules = ['src/domain/relevance.ts', 'src/engines/discovery.engine.ts'];
  const reads = [
    'store.trustAssessments',
    'store.reputation',
    'store.riskEvents',
    '.trustBand',
    '.internalSignals',
  ];
  const offenders: string[] = [];
  for (const relative of modules) {
    const source = readFileSync(join(engineRoot, relative), 'utf8')
      // Comments stripped: these modules *discuss* trust at length, and the reasoning is the
      // most valuable thing in them.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const read of reads) {
      if (source.includes(read)) offenders.push(`${relative} reads ${read}`);
    }
  }
  assert.deepEqual(offenders, [], 'trust may constrain amplification and may never rank');

  // And the prohibitions themselves are still present, which the tightened guard no longer
  // punishes. Asserted here so a later edit cannot quietly drop them.
  assert.ok(FORBIDDEN_RELEVANCE_INPUTS['trust'] !== undefined, 'trust is still named as forbidden');
  assert.ok(FORBIDDEN_RELEVANCE_INPUTS['reputation'] !== undefined, 'and so is reputation');
});

// ── Phase 74, the profile ────────────────────────────────────────────────
test('an empty profile is empty, and that is a distinct state', () => {
  // Load-bearing: an empty profile must produce *unfiltered* discovery, and the failure
  // (filter by an empty set, get nothing) is one plausible line away.
  assert.equal(profileIsEmpty(emptyProfile('actor_1')), true);
  assert.equal(
    profileIsEmpty({ ...emptyProfile('actor_1'), authoredCategories: ['Housing'] }),
    false,
  );
});

test('the profile inputs are exactly the four declared kinds', () => {
  assert.deepEqual(PROFILE_INPUTS, [
    'followed_subjects',
    'watched_experiences',
    'authored_categories',
    'stated_locality',
  ]);
});

test('every forbidden profile input is named with its objection', () => {
  // None of these exists in the codebase. They are listed so that adding one has to pass a
  // test that states the objection, rather than passing review because whoever wanted it had
  // a plausible reason.
  for (const [name, reason] of Object.entries(FORBIDDEN_PROFILE_INPUTS)) {
    assert.ok(reason.length > 50, `${name} carries a real argument`);
  }
  for (const expected of ['view_history', 'dwell_time', 'scroll_depth', 'inferred_demographics']) {
    assert.ok(FORBIDDEN_PROFILE_INPUTS[expected] !== undefined, `${expected} is named`);
  }
});

test('nothing in the codebase records a view, a dwell or a scroll', () => {
  // The finding this phase is built on, asserted rather than assumed. A privacy-safe
  // relevance profile is not a compromise here — it is the only kind available, and this is
  // what keeps that true as the codebase grows.
  const roots = ['src/domain', 'src/engines', 'src/runtime', 'src/ports'];
  const offenders: string[] = [];
  for (const root of roots) {
    for (const name of readdirSync(join(engineRoot, root))) {
      if (!name.endsWith('.ts')) continue;
      // The two modules that *name* these as forbidden are the exception, and they are the
      // reason the rule survives.
      if (name === 'relevance-profile.ts' || name === 'relevance.ts') continue;
      const source = readFileSync(join(engineRoot, root, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const term of ['dwellTime', 'dwell_time', 'viewCount', 'viewHistory', 'scrollDepth']) {
        if (source.includes(term)) offenders.push(`${root}/${name} has ${term}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'no attention metric exists, and this is what keeps it that way');
});

test('the profile explains itself in terms somebody would recognise as their own actions', () => {
  const lines = explainProfile({
    actorId: 'actor_1',
    followedSubjectIds: ['sub_1'],
    watchedExperienceIds: ['exp_1', 'exp_2'],
    authoredCategories: ['Housing'],
    statedLocalityIds: [],
  });
  assert.ok(lines.some((line) => /chose to follow/.test(line)));
  assert.ok(lines.some((line) => /chose to watch/.test(line)));
  assert.ok(lines.some((line) => /you have posted in/.test(line)));
  // A profile nobody can inspect is one nobody can correct.
  assert.equal(lines.some((line) => /score|weight|model/.test(line)), false);
});

test('an empty profile explains that it will show everything', () => {
  const lines = explainProfile(emptyProfile('actor_new'));
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /you will see everything/);
});

test('the profile is not stored, does not rank, and is not readable by others', () => {
  assert.equal(profileIsStored(), false);
  assert.equal(profileRanksAnything(), false);
  assert.equal(profileIsReadableByOthers(), false);
});
