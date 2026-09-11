import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRetryPolicy } from '../../src/runtime/retry.ts';
import { transientError, validationError } from '../../src/runtime/errors.ts';
import { canTransitionWork, isTerminalWork, WORK_STATES } from '../../src/runtime/work.ts';

test('backoff is deterministic and exponential, capped at maxMs', () => {
  const policy = createRetryPolicy({ maxAttempts: 6, baseMs: 1_000, factor: 2, maxMs: 10_000 });
  const schedule = [1, 2, 3, 4, 5, 6].map((attempt) => policy.backoffMs(attempt));
  assert.deepEqual(schedule, [1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  assert.deepEqual(schedule, [1, 2, 3, 4, 5, 6].map((a) => policy.backoffMs(a)), 'must be deterministic');
});

test('only retryable errors are retried, and only within maxAttempts', () => {
  const policy = createRetryPolicy({ maxAttempts: 3 });
  assert.equal(policy.shouldRetry(transientError('t', 'temporary'), 1), true);
  assert.equal(policy.shouldRetry(transientError('t', 'temporary'), 2), true);
  assert.equal(policy.shouldRetry(transientError('t', 'temporary'), 3), false, 'exhausted at maxAttempts');
  assert.equal(policy.shouldRetry(validationError('v', 'bad input'), 1), false, 'invalid input is never retried');
});

test('work state machine allows only the documented transitions', () => {
  assert.deepEqual([...WORK_STATES], ['queued', 'processing', 'ready', 'failed', 'dead_letter']);
  assert.ok(canTransitionWork('queued', 'processing'));
  assert.ok(canTransitionWork('processing', 'ready'));
  assert.ok(canTransitionWork('processing', 'failed'));
  assert.ok(canTransitionWork('failed', 'queued'));
  assert.ok(canTransitionWork('failed', 'dead_letter'));

  assert.equal(canTransitionWork('queued', 'ready'), false, 'work cannot skip processing');
  assert.equal(canTransitionWork('ready', 'processing'), false, 'ready is terminal');
  assert.equal(canTransitionWork('dead_letter', 'queued'), false, 'dead_letter is terminal');

  assert.ok(isTerminalWork('ready'));
  assert.ok(isTerminalWork('dead_letter'));
  assert.equal(isTerminalWork('failed'), false, 'failed is retryable, not terminal');
});
