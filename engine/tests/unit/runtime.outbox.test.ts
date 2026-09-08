import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeHarness, member } from '../support/runtime-harness.ts';
import { ok } from '../../src/runtime/result.ts';
import type { DomainEventEnvelope } from '../../src/runtime/outbox.ts';

test('outbox assigns monotonic sequence numbers per aggregate', async () => {
  const h = createRuntimeHarness();
  await h.outbox.append(
    [
      { aggregateType: 'experience', aggregateId: 'A', eventName: 'E1', payload: {} },
      { aggregateType: 'experience', aggregateId: 'B', eventName: 'E1', payload: {} },
      { aggregateType: 'experience', aggregateId: 'A', eventName: 'E2', payload: {} },
    ],
    'corr-1',
  );
  const all = await h.outbox.all();
  const forA = all.filter((r) => r.aggregateId === 'A').map((r) => r.sequence);
  const forB = all.filter((r) => r.aggregateId === 'B').map((r) => r.sequence);
  assert.deepEqual(forA, [1, 2], 'sequences are per-aggregate, not global');
  assert.deepEqual(forB, [1]);
});

test('events are delivered in sequence order per aggregate', async () => {
  const h = createRuntimeHarness();
  const seen: number[] = [];
  h.orchestrator.subscribe({
    name: 'recorder',
    events: ['E1', 'E2', 'E3'],
    handle: async (event: DomainEventEnvelope) => {
      seen.push(event.sequence);
      return ok(undefined);
    },
  });

  await h.outbox.append(
    [
      { aggregateType: 'experience', aggregateId: 'A', eventName: 'E1', payload: {} },
      { aggregateType: 'experience', aggregateId: 'A', eventName: 'E2', payload: {} },
      { aggregateType: 'experience', aggregateId: 'A', eventName: 'E3', payload: {} },
    ],
    'corr-1',
  );

  await h.orchestrator.drainAll();
  assert.deepEqual(seen, [1, 2, 3], 'ordering per aggregate must be preserved');
  assert.equal(await h.outbox.pendingCount(), 0);
});

test('a backing-off head event blocks later events for the same aggregate only', async () => {
  const h = createRuntimeHarness({ retry: { maxAttempts: 5, baseMs: 10_000, factor: 2 } });
  const seen: string[] = [];
  let failA1 = true;
  h.orchestrator.subscribe({
    name: 'blocker',
    events: ['A1', 'A2', 'B1'],
    handle: async (event) => {
      if (event.eventName === 'A1' && failA1) {
        return { ok: false as const, error: { kind: 'transient' as const, code: 'x', message: 'later', retryable: true } };
      }
      seen.push(event.eventName);
      return ok(undefined);
    },
  });

  await h.outbox.append(
    [
      { aggregateType: 'experience', aggregateId: 'A', eventName: 'A1', payload: {} },
      { aggregateType: 'experience', aggregateId: 'A', eventName: 'A2', payload: {} },
    ],
    'corr-a',
  );
  await h.outbox.append([{ aggregateType: 'experience', aggregateId: 'B', eventName: 'B1', payload: {} }], 'corr-b');

  await h.orchestrator.drain();
  assert.deepEqual(seen, ['B1'], 'aggregate B proceeds while A is blocked at its head');

  failA1 = false;
  h.clock.advance(20_000);
  await h.orchestrator.drainAll();
  assert.deepEqual(seen, ['B1', 'A1', 'A2'], 'A resumes in order once the head succeeds');
});

test('an event with no subscriber is delivered rather than left pending', async () => {
  const h = createRuntimeHarness();
  await h.outbox.append(
    [{ aggregateType: 'experience', aggregateId: 'A', eventName: 'Unwatched', payload: {} }],
    'corr-1',
  );
  await h.orchestrator.drainAll();
  assert.equal(await h.outbox.pendingCount(), 0);
});

test('re-delivery to an idempotent consumer produces no second effect', async () => {
  const h = createRuntimeHarness();
  const applied = new Set<string>();
  let effects = 0;
  h.orchestrator.subscribe({
    name: 'idempotent-projector',
    events: ['Projected'],
    handle: async (event) => {
      // The idempotency guard every consumer must implement.
      if (applied.has(event.id)) return ok(undefined);
      applied.add(event.id);
      effects += 1;
      return ok(undefined);
    },
  });

  await h.outbox.append(
    [{ aggregateType: 'experience', aggregateId: 'A', eventName: 'Projected', payload: {} }],
    'corr-1',
  );
  await h.orchestrator.drainAll();
  await h.orchestrator.drainAll();
  await h.orchestrator.drainAll();

  assert.equal(effects, 1, 'at-least-once delivery must not cause a second effect');
});

test('the command bus writes events to the outbox with the command correlation id', async () => {
  const h = createRuntimeHarness();
  h.bus.register({
    name: 'test.emit',
    action: 'experience.create',
    resolveResource: async () => ok({ type: 'experience' as const, ownerActorId: member().actorId }),
    handle: async () =>
      ok({
        value: 'done',
        events: [{ aggregateType: 'experience', aggregateId: 'exp_1', eventName: 'Emitted', payload: {} }],
      }),
  });

  await h.bus.dispatch({
    name: 'test.emit',
    input: {},
    actor: member(),
    idempotencyKey: 'k',
    correlationId: 'corr-fixed',
  });

  const all = await h.outbox.all();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.correlationId, 'corr-fixed');
});
