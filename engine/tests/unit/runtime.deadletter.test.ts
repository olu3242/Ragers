import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeHarness } from '../support/runtime-harness.ts';
import { err, ok } from '../../src/runtime/result.ts';
import { internalError, transientError } from '../../src/runtime/errors.ts';

test('an exhausted consumer dead-letters with its failure history intact', async () => {
  const h = createRuntimeHarness({ retry: { maxAttempts: 3, baseMs: 1_000, factor: 2 } });
  let attempts = 0;
  h.orchestrator.subscribe({
    name: 'always-failing',
    events: ['Doomed'],
    handle: async () => {
      attempts += 1;
      return err(transientError('upstream_down', `attempt ${attempts} failed`));
    },
  });

  await h.outbox.append([{ aggregateType: 'experience', aggregateId: 'A', eventName: 'Doomed', payload: { k: 1 } }], 'corr-1');

  // Each round consumes one attempt; advance past the backoff between rounds.
  for (let round = 0; round < 3; round += 1) {
    await h.orchestrator.drain();
    h.clock.advance(60_000);
  }

  assert.equal(attempts, 3, 'exactly maxAttempts attempts');
  const dead = await h.deadLetters.list();
  assert.equal(dead.length, 1, 'the event must land in the dead-letter store');
  assert.equal(dead[0]?.eventName, 'Doomed');
  assert.equal(dead[0]?.source, 'always-failing');
  assert.equal(dead[0]?.correlationId, 'corr-1');
  assert.deepEqual(dead[0]?.payload, { k: 1 }, 'the payload is preserved for replay');
  assert.equal(dead[0]?.failureHistory.length, 3, 'the full failure history is preserved');
});

test('a non-retryable consumer failure dead-letters immediately', async () => {
  const h = createRuntimeHarness({ retry: { maxAttempts: 5 } });
  let attempts = 0;
  h.orchestrator.subscribe({
    name: 'poison',
    events: ['Poison'],
    handle: async () => {
      attempts += 1;
      return err(internalError('bad_shape', 'payload is unprocessable'));
    },
  });

  await h.outbox.append([{ aggregateType: 'experience', aggregateId: 'A', eventName: 'Poison', payload: {} }], 'c');
  await h.orchestrator.drainAll();

  assert.equal(attempts, 1, 'a poison message is not retried');
  assert.equal((await h.deadLetters.list()).length, 1);
});

test('a thrown consumer error is captured rather than escaping the orchestrator', async () => {
  const h = createRuntimeHarness({ retry: { maxAttempts: 1 } });
  h.orchestrator.subscribe({
    name: 'thrower',
    events: ['Boom'],
    handle: async () => {
      throw new Error('unexpected');
    },
  });

  await h.outbox.append([{ aggregateType: 'experience', aggregateId: 'A', eventName: 'Boom', payload: {} }], 'c');
  const report = await h.orchestrator.drainAll();

  assert.equal(report.deadLettered, 1);
  const dead = await h.deadLetters.list();
  assert.match(dead[0]?.failureHistory[0]?.error ?? '', /consumer_threw/);
});

test('one failing consumer does not block a healthy consumer on the same event', async () => {
  const h = createRuntimeHarness({ retry: { maxAttempts: 1 } });
  let healthy = 0;
  h.orchestrator.subscribe({
    name: 'healthy',
    events: ['Shared'],
    handle: async () => {
      healthy += 1;
      return ok(undefined);
    },
  });
  h.orchestrator.subscribe({
    name: 'broken',
    events: ['Shared'],
    handle: async () => err(internalError('nope', 'always fails')),
  });

  await h.outbox.append([{ aggregateType: 'experience', aggregateId: 'A', eventName: 'Shared', payload: {} }], 'c');
  await h.orchestrator.drainAll();

  assert.equal(healthy, 1, 'the healthy consumer still receives the event');
  assert.equal((await h.deadLetters.list()).length, 1, 'only the broken consumer dead-letters');
});
