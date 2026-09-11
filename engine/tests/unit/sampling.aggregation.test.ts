import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SAMPLE_FLOORS,
  floorFor,
  measure,
  toPayload,
  withheldCaption,
} from '../../src/domain/sampling.ts';
import {
  MINIMUM_DISTINCT_CONTRIBUTORS,
  aggregate,
  publishableTogether,
} from '../../src/domain/aggregation.ts';
import { MINIMUM_SAMPLE } from '../../src/engines/responsiveness.engine.ts';
import { handoffMutatesGovernedState } from '../../src/engines/handoff.engine.ts';

/**
 * Phases 38–40 at the domain layer.
 *
 * The rule under test is "a measure withheld beats a measure invented", and the tests
 * that matter are the ones asserting a withheld measure carries no value to leak —
 * not a zero, not a null, not a rounded hint.
 */

// ── Phase 38 — floors ────────────────────────────────────────────────────
test('a measure below its floor is withheld and carries no value at all', () => {
  const m = measure('responsiveness', 2, () => 1_234);
  assert.equal(m.withheld, true);
  // The type has no `value` in this branch, and neither does the object: a caller
  // writing `value ?? 0` cannot publish a zero that means "we do not know".
  assert.equal('value' in m, false);
  if (m.withheld) {
    assert.equal(m.shortBy, floorFor('responsiveness') - 2);
  }
});

test('the thunk is not even evaluated below the floor', () => {
  let computed = false;
  measure('responsiveness', 1, () => {
    computed = true;
    return 1;
  });
  // The forbidden figure never exists in a variable. That is the point of a thunk
  // rather than a value.
  assert.equal(computed, false);
});

test('a measure at its floor is reported', () => {
  const m = measure('responsiveness', floorFor('responsiveness'), () => 42);
  assert.equal(m.withheld, false);
  if (!m.withheld) assert.equal(m.value, 42);
});

test('the withheld payload has no value key, so JSON cannot leak one', () => {
  const payload = toPayload(measure('responsiveness', 0, () => 99));
  assert.equal('value' in payload, false);
  assert.equal(payload['withheld'], true);
});

test('the caption says how far off it is, in one voice', () => {
  const m = measure('benchmark', 4, () => 1);
  assert.equal(m.withheld, true);
  if (m.withheld) {
    assert.match(withheldCaption(m), /4 of 20/);
    assert.match(withheldCaption(m, 'organizations'), /Too few organizations/);
  }
});

test('responsiveness reads its floor from the one policy, not its own constant', () => {
  // Two floors for the same measure is how two surfaces come to disagree about
  // whether the same number is safe to show.
  assert.equal(MINIMUM_SAMPLE, SAMPLE_FLOORS.responsiveness);
});

test('a benchmark floor is higher than a single-organization measure', () => {
  // A comparison between parties is more identifying than a measure about one.
  assert.ok(floorFor('benchmark') > floorFor('responsiveness'));
});

// ── Phase 39 — aggregation ──────────────────────────────────────────────
test('enough rows from too few people is suppressed, not published', () => {
  const result = aggregate({
    kind: 'benchmark',
    sampleSize: 200,
    distinctContributors: 3,
    compute: () => 0.5,
  });
  assert.equal(result.suppressed, true);
  if (result.suppressed) assert.equal(result.reason, 'too_few_people');
});

test('a small cell is suppressed rather than rounded', () => {
  const result = aggregate({ kind: 'benchmark', sampleSize: 2, distinctContributors: 2, compute: () => 1 });
  assert.equal(result.suppressed, true);
  // Rounding a 2 to "fewer than 5" still says somebody is there, which in a group of
  // one organization is an identification.
  if (result.suppressed) assert.equal('value' in result, false);
});

test('an aggregate over a single contributor is refused', () => {
  const result = aggregate({ kind: 'benchmark', sampleSize: 40, distinctContributors: 1, compute: () => 1 });
  assert.equal(result.suppressed, true);
});

test('a subset too close to its parent is suppressed, because the remainder is recoverable', () => {
  // 22 of 24 people: the two who are left are identifiable by subtraction, even though
  // both aggregates individually clear every floor.
  const result = aggregate({
    kind: 'benchmark',
    sampleSize: 60,
    distinctContributors: 22,
    parentDistinctContributors: 24,
    compute: () => 0.4,
  });
  assert.equal(result.suppressed, true);
  if (result.suppressed) assert.equal(result.reason, 'differencing_risk');
});

test('a subset well clear of its parent is published', () => {
  const result = aggregate({
    kind: 'benchmark',
    sampleSize: 60,
    distinctContributors: 22,
    parentDistinctContributors: 60,
    compute: () => 0.4,
  });
  assert.equal(result.suppressed, false);
  if (!result.suppressed) {
    assert.equal(result.measure.withheld, false);
    assert.equal(result.distinctContributors, 22);
  }
});

test('a subset equal to its parent is published — nothing is left to recover', () => {
  const result = aggregate({
    kind: 'benchmark',
    sampleSize: 60,
    distinctContributors: 30,
    parentDistinctContributors: 30,
    compute: () => 0.4,
  });
  assert.equal(result.suppressed, false);
});

test('every suppression explains itself, so a surface shows a reason not a blank', () => {
  for (const input of [
    { sampleSize: 2, distinctContributors: 2 },
    { sampleSize: 200, distinctContributors: 3 },
  ]) {
    const result = aggregate({ kind: 'benchmark', compute: () => 1, ...input });
    assert.equal(result.suppressed, true);
    if (result.suppressed) assert.ok(result.explanation.length > 0);
  }
});

test('individually safe aggregates can be unsafe as a set', () => {
  // One hidden sibling, and the remainder recoverable by subtracting the shown ones
  // from the parent. This is the differencing attack in its simplest form, and it
  // exists only at the level of the whole set.
  assert.equal(
    publishableTogether(30, [
      { distinctContributors: 14, published: true },
      { distinctContributors: 14, published: true },
      { distinctContributors: 2, published: false },
    ]),
    false,
  );
  // Two hidden siblings: the remainder does not identify either.
  assert.equal(
    publishableTogether(30, [
      { distinctContributors: 12, published: true },
      { distinctContributors: 12, published: true },
      { distinctContributors: 3, published: false },
      { distinctContributors: 3, published: false },
    ]),
    true,
  );
});

test('publishing nothing, or everything, is always safe', () => {
  assert.equal(publishableTogether(30, [{ distinctContributors: 10, published: false }]), true);
  assert.equal(publishableTogether(30, [{ distinctContributors: 30, published: true }]), true);
});

test('the person floor is a named constant, not a literal spread across call sites', () => {
  assert.equal(typeof MINIMUM_DISTINCT_CONTRIBUTORS, 'number');
  assert.ok(MINIMUM_DISTINCT_CONTRIBUTORS >= 5);
});

// ── Phase 40 — the handoff boundary ─────────────────────────────────────
test('a handoff never mutates governed state — the rule, as code', () => {
  assert.equal(handoffMutatesGovernedState(), false);
});
