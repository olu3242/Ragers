import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A test that fails on purpose.
 *
 * It exists so the certification evidence path can be proved end to end against a
 * real `node --test` run rather than against a string somebody pasted into a fixture.
 * The parsers in `src/certification/evidence.ts` read TAP that the runner actually
 * produced, and TAP output has a way of differing from what you remember it being.
 *
 * Deliberately outside `tests/unit/` and `tests/integration/`, so neither `npm test`
 * nor any certification gate collects it. Only
 * `tests/unit/certification.evidence.test.ts` runs it, on purpose, and asserts what
 * the evidence kept.
 */
test('a passing test beside the failing one, so the run is not all red', () => {
  assert.equal(1 + 1, 2);
});

test('the deliberate failure: an asserted refusal that did not happen', () => {
  const refused = false;
  assert.equal(refused, true, 'the boundary must refuse this input');
});

test('the deliberate failure with a multi-line assertion', () => {
  assert.deepEqual(['accepted'], [], 'every one of these must be a governed refusal');
});
