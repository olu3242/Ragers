import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMERGING_MAX_EXPERIENCERS,
  EXPIRES_AFTER_MS,
  lifecycleOf,
  RESOLVED_SHARE,
  setLifecycleState,
  SIGNAL_LIFECYCLE_STATES,
  STABILIZING_AFTER_MS,
  type SignalLifecycleInput,
} from '../../src/domain/signal-lifecycle.ts';
import {
  decayedWeightOf,
  HALF_LIFE_MS,
  pruneDecayedContributions,
  recoveryOf,
  weightAt,
  WEIGHT_HORIZON_MS,
} from '../../src/domain/decay.ts';
import { floorFor } from '../../src/domain/sampling.ts';

/**
 * Phases 54 and 55, as pure rules.
 *
 * The whole point of both is that a signal can stop being current, so most of these
 * assert something *becoming false* — which is the direction nothing in phases 1–50
 * could express.
 */
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const input = (overrides: Partial<SignalLifecycleInput> = {}): SignalLifecycleInput => ({
  firstContributionAt: NOW - 40 * DAY,
  lastContributionAt: NOW - 1 * DAY,
  uniqueExperiencers: 12,
  recentContributions: 4,
  resolvedShare: 0,
  outcomeReporters: 0,
  now: NOW,
  ...overrides,
});

// ── P54 lifecycle ─────────────────────────────────────────────────────────
test('a pattern with recent contributions is active and current', () => {
  const lifecycle = lifecycleOf(input());
  assert.equal(lifecycle.state, 'active');
  assert.equal(lifecycle.because, 'recent_contribution');
  assert.equal(lifecycle.current, true);
});

test('a pattern below the reporting floor is emerging, not active', () => {
  const lifecycle = lifecycleOf(input({ uniqueExperiencers: EMERGING_MAX_EXPERIENCERS }));
  assert.equal(lifecycle.state, 'emerging');
  assert.equal(lifecycle.because, 'below_reporting_floor');
  // Emerging is still current: something is happening, it just cannot be reported yet.
  assert.equal(lifecycle.current, true);
});

test('the emerging boundary is the reporting floor, derived rather than restated', () => {
  assert.equal(EMERGING_MAX_EXPERIENCERS, floorFor('responsiveness') - 1);
});

test('a pattern nobody has reported for a month is stabilizing and no longer current', () => {
  // The failure test the phase names: stale signal decay. Nothing changed about the
  // measurements — only time passed — and the signal must stop presenting as live.
  const lifecycle = lifecycleOf(input({ lastContributionAt: NOW - STABILIZING_AFTER_MS - DAY, recentContributions: 0 }));
  assert.equal(lifecycle.state, 'stabilizing');
  assert.equal(lifecycle.because, 'no_recent_contribution');
  assert.equal(lifecycle.current, false);
});

test('a pattern nobody has reported for six months is expired', () => {
  const lifecycle = lifecycleOf(input({ lastContributionAt: NOW - EXPIRES_AFTER_MS, recentContributions: 0 }));
  assert.equal(lifecycle.state, 'expired');
  assert.equal(lifecycle.because, 'no_contribution_within_expiry');
  assert.equal(lifecycle.current, false);
});

test('expiry outranks a confirmed outcome, because nothing recent is nothing recent', () => {
  const lifecycle = lifecycleOf(
    input({
      lastContributionAt: NOW - EXPIRES_AFTER_MS,
      recentContributions: 0,
      resolvedShare: 1,
      outcomeReporters: 20,
    }),
  );
  assert.equal(lifecycle.state, 'expired', 'precedence is explicit and total');
});

test('a signal settles when enough people reported an outcome and enough said it was fixed', () => {
  const lifecycle = lifecycleOf(
    input({
      lastContributionAt: NOW - 40 * DAY,
      recentContributions: 0,
      resolvedShare: RESOLVED_SHARE,
      outcomeReporters: floorFor('resolution_rate'),
    }),
  );
  assert.equal(lifecycle.state, 'resolved');
  assert.equal(lifecycle.because, 'outcome_confirmed_by_reporters');
  assert.equal(lifecycle.current, false);
});

test('one satisfied reporter cannot settle a pattern', () => {
  const lifecycle = lifecycleOf(
    input({
      lastContributionAt: NOW - 40 * DAY,
      recentContributions: 0,
      resolvedShare: 1,
      outcomeReporters: 1,
    }),
  );
  assert.notEqual(lifecycle.state, 'resolved');
  assert.equal(lifecycle.state, 'stabilizing');
});

test('a settled signal still receiving reports has not settled', () => {
  const lifecycle = lifecycleOf(
    input({ recentContributions: 3, resolvedShare: 1, outcomeReporters: 20 }),
  );
  assert.equal(lifecycle.state, 'active', 'people are still reporting it');
});

test('every state is reachable, and the enum lists exactly them', () => {
  const reached = new Set([
    lifecycleOf(input()).state,
    lifecycleOf(input({ uniqueExperiencers: 1 })).state,
    lifecycleOf(input({ lastContributionAt: NOW - STABILIZING_AFTER_MS - DAY, recentContributions: 0 })).state,
    lifecycleOf(input({ lastContributionAt: NOW - EXPIRES_AFTER_MS, recentContributions: 0 })).state,
    lifecycleOf(
      input({
        lastContributionAt: NOW - 40 * DAY,
        recentContributions: 0,
        resolvedShare: 1,
        outcomeReporters: 20,
      }),
    ).state,
  ]);
  assert.deepEqual([...reached].sort(), [...SIGNAL_LIFECYCLE_STATES].sort());
});

test('no command sets a lifecycle state', () => {
  assert.equal(setLifecycleState(), undefined);
});

// ── P55 decay and recovery ────────────────────────────────────────────────
test('a contribution made now counts fully, and half as much after a half-life', () => {
  assert.equal(weightAt(NOW, NOW), 1);
  assert.equal(Number(weightAt(NOW - HALF_LIFE_MS, NOW).toFixed(4)), 0.5);
});

test('a contribution past the horizon counts for nothing, and is counted as such', () => {
  assert.equal(weightAt(NOW - WEIGHT_HORIZON_MS, NOW), 0);
  const decayed = decayedWeightOf({ contributionsAt: [NOW - WEIGHT_HORIZON_MS - DAY, NOW], now: NOW });
  assert.equal(decayed.weight, 1);
  assert.equal(decayed.contributionCount, 2, 'the old row is still counted as a row');
  assert.equal(decayed.beyondHorizon, 1, 'and reported as past the horizon rather than dropped silently');
});

test('replaying the same contributions in a different order gives the same weight', () => {
  // The failure test the phase names. A weight that depended on order could not be
  // recomputed from rows, which is the only way this is ever computed.
  const moments = [NOW - 200 * DAY, NOW - 5 * DAY, NOW - 90 * DAY, NOW - 1 * DAY, NOW - 400 * DAY];
  const forward = decayedWeightOf({ contributionsAt: moments, now: NOW });
  const reversed = decayedWeightOf({ contributionsAt: [...moments].reverse(), now: NOW });
  const shuffled = decayedWeightOf({ contributionsAt: [moments[3]!, moments[0]!, moments[4]!, moments[1]!, moments[2]!], now: NOW });

  assert.equal(forward.weight, reversed.weight);
  assert.equal(forward.weight, shuffled.weight);
  assert.equal(forward.lastContributionAt, NOW - 1 * DAY, 'and the latest is the latest whatever the order');
});

test('a hundred very old contributions do not sum their way back to significance', () => {
  const ancient = Array.from({ length: 100 }, () => NOW - WEIGHT_HORIZON_MS - DAY);
  const decayed = decayedWeightOf({ contributionsAt: ancient, now: NOW });
  assert.equal(decayed.weight, 0);
  assert.equal(decayed.contributionCount, 100, 'the rows are all still there');
});

test('decay reads no row away — the count never falls', () => {
  const moments = [NOW - 300 * DAY, NOW - 200 * DAY, NOW - 100 * DAY];
  const early = decayedWeightOf({ contributionsAt: moments, now: NOW - 100 * DAY });
  const late = decayedWeightOf({ contributionsAt: moments, now: NOW + 400 * DAY });
  assert.ok(late.weight < early.weight, 'the weight falls with time');
  assert.equal(late.contributionCount, early.contributionCount, 'the record does not');
});

test('a pattern picking up again is recovering; one going quiet is fading', () => {
  const returning = [NOW - 300 * DAY, NOW - 280 * DAY, NOW - 2 * DAY, NOW - 1 * DAY];
  assert.equal(recoveryOf({ contributionsAt: returning, now: NOW }, 30 * DAY), 'recovering');

  const quiet = [NOW - 300 * DAY, NOW - 280 * DAY];
  assert.equal(recoveryOf({ contributionsAt: quiet, now: NOW }, 30 * DAY), 'fading');
});

test('a pattern with nothing in it is steady rather than fading', () => {
  assert.equal(recoveryOf({ contributionsAt: [], now: NOW }, 30 * DAY), 'steady');
});

test('nothing prunes a decayed contribution', () => {
  assert.equal(pruneDecayedContributions(), undefined);
});

test('a brand-new pattern is not recovering — it has nothing to recover from', () => {
  // Everything inside the window and nothing before it. Reading this as recovery would
  // have every new pattern claim a history, and would draw a `pattern_recovered`
  // conclusion about its own first week.
  const brandNew = [NOW - 3 * DAY, NOW - 2 * DAY, NOW - 1 * DAY];
  assert.equal(recoveryOf({ contributionsAt: brandNew, now: NOW }, 30 * DAY), 'steady');
});
