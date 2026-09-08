import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeHarness, member } from '../support/runtime-harness.ts';
import { ok, err, type Result } from '../../src/runtime/result.ts';
import { transientError, validationError, type EngineError } from '../../src/runtime/errors.ts';
import type { CommandHandler, HandlerOutcome } from '../../src/runtime/bus.ts';

interface CountInput {
  readonly amount: number;
}

const countingHandler = (state: { calls: number; total: number }): CommandHandler<CountInput, number> => ({
  name: 'test.count',
  action: 'experience.create',
  resolveResource: async () => ok({ type: 'experience' as const, ownerActorId: member().actorId }),
  handle: async (input): Promise<Result<HandlerOutcome<number>, EngineError>> => {
    state.calls += 1;
    state.total += input.amount;
    return ok({
      value: state.total,
      events: [
        {
          aggregateType: 'experience',
          aggregateId: 'exp_1',
          eventName: 'TestCounted',
          payload: { amount: input.amount },
        },
      ],
    });
  },
});

test('a replayed command returns the first response and causes no second effect', async () => {
  const h = createRuntimeHarness();
  const state = { calls: 0, total: 0 };
  h.bus.register(countingHandler(state));

  const first = await h.bus.dispatch({
    name: 'test.count',
    input: { amount: 5 },
    actor: member(),
    idempotencyKey: 'key-1',
  });
  const replay = await h.bus.dispatch({
    name: 'test.count',
    input: { amount: 5 },
    actor: member(),
    idempotencyKey: 'key-1',
  });

  assert.deepEqual(first, ok(5));
  assert.deepEqual(replay, ok(5), 'replay must return the identical first response');
  assert.equal(state.calls, 1, 'handler must run exactly once');
  assert.equal(state.total, 5, 'no second effect');

  const events = await h.outbox.all();
  assert.equal(events.length, 1, 'a replay must not append a second event');
});

test('a different idempotency key is a distinct command', async () => {
  const h = createRuntimeHarness();
  const state = { calls: 0, total: 0 };
  h.bus.register(countingHandler(state));

  await h.bus.dispatch({ name: 'test.count', input: { amount: 2 }, actor: member(), idempotencyKey: 'a' });
  const second = await h.bus.dispatch({
    name: 'test.count',
    input: { amount: 3 },
    actor: member(),
    idempotencyKey: 'b',
  });

  assert.deepEqual(second, ok(5));
  assert.equal(state.calls, 2);
});

test('a non-retryable rejection is replayed stably', async () => {
  const h = createRuntimeHarness();
  let calls = 0;
  h.bus.register({
    name: 'test.reject',
    action: 'experience.create',
    resolveResource: async () => ok({ type: 'experience' as const, ownerActorId: member().actorId }),
    handle: async () => {
      calls += 1;
      return err(validationError('too_long', 'body exceeds limit'));
    },
  });

  const first = await h.bus.dispatch({
    name: 'test.reject',
    input: {},
    actor: member(),
    idempotencyKey: 'k',
  });
  const replay = await h.bus.dispatch({
    name: 'test.reject',
    input: {},
    actor: member(),
    idempotencyKey: 'k',
  });

  assert.equal(first.ok, false);
  assert.equal(replay.ok, false);
  assert.deepEqual(first, replay, 'a rejection must replay identically');
  assert.equal(calls, 1, 'invalid input is not re-executed');
});

test('a transient failure releases the key so the same command can be retried', async () => {
  const h = createRuntimeHarness();
  let calls = 0;
  h.bus.register({
    name: 'test.flaky',
    action: 'experience.create',
    resolveResource: async () => ok({ type: 'experience' as const, ownerActorId: member().actorId }),
    handle: async () => {
      calls += 1;
      if (calls === 1) return err(transientError('upstream', 'temporarily unavailable'));
      return ok({ value: 'recovered' });
    },
  });

  const first = await h.bus.dispatch({
    name: 'test.flaky',
    input: {},
    actor: member(),
    idempotencyKey: 'same',
  });
  const second = await h.bus.dispatch({
    name: 'test.flaky',
    input: {},
    actor: member(),
    idempotencyKey: 'same',
  });

  assert.equal(first.ok, false);
  assert.deepEqual(second, ok('recovered'), 'the same key must be reusable after a transient failure');
  assert.equal(calls, 2);
});

test('concurrent dispatch of one idempotency key produces exactly one effect', async () => {
  const h = createRuntimeHarness();
  const state = { calls: 0, total: 0 };
  h.bus.register(countingHandler(state));

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      h.bus.dispatch({
        name: 'test.count',
        input: { amount: 1 },
        actor: member(),
        idempotencyKey: 'race',
      }),
    ),
  );

  assert.equal(state.calls, 1, 'exactly one handler execution under concurrency');
  const succeeded = results.filter((r) => r.ok);
  assert.equal(succeeded.length, 1, 'exactly one caller succeeds; the rest see in-flight');
  const events = await h.outbox.all();
  assert.equal(events.length, 1);
});
