import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeHarness } from '../support/runtime-harness.ts';
import { err, ok } from '../../src/runtime/result.ts';
import { transientError, internalError } from '../../src/runtime/errors.ts';
import {
  canTransitionJob,
  isHeldJob,
  isTerminalJob,
  JOB_STATES,
  heartbeatDeadline,
} from '../../src/runtime/jobs.ts';

/**
 * Phase 21 — distributed orchestration.
 *
 * The properties under test are the ones that make delivery survive a process
 * dying: a job is held by exactly one worker, an expired lease returns the job
 * to the queue with its progress intact, and a restarted worker resumes rather
 * than duplicating.
 */
test('the job state machine allows only the documented transitions', () => {
  assert.deepEqual([...JOB_STATES], [
    'queued',
    'leased',
    'running',
    'waiting',
    'retrying',
    'completed',
    'failed',
    'dead_letter',
  ]);

  assert.ok(canTransitionJob('queued', 'leased'));
  assert.ok(canTransitionJob('leased', 'running'));
  assert.ok(canTransitionJob('leased', 'queued'), 'a lease can expire without the worker acting');
  assert.ok(canTransitionJob('running', 'completed'));
  assert.ok(canTransitionJob('running', 'failed'));
  assert.ok(canTransitionJob('running', 'waiting'));
  assert.ok(canTransitionJob('waiting', 'queued'));
  assert.ok(canTransitionJob('failed', 'retrying'));
  assert.ok(canTransitionJob('failed', 'dead_letter'));
  assert.ok(canTransitionJob('retrying', 'queued'));

  assert.equal(canTransitionJob('queued', 'running'), false, 'a job must be leased before it runs');
  assert.equal(canTransitionJob('completed', 'queued'), false, 'completed is terminal');
  assert.equal(canTransitionJob('dead_letter', 'queued'), false, 'dead_letter is terminal');
  assert.equal(canTransitionJob('running', 'dead_letter'), false, 'failure is recorded before dead-lettering');

  assert.ok(isTerminalJob('completed'));
  assert.ok(isTerminalJob('dead_letter'));
  assert.ok(isHeldJob('leased'));
  assert.ok(isHeldJob('running'));
  assert.equal(isHeldJob('queued'), false);
});

test('a worker registers and heartbeats, and a silent worker is reaped', async () => {
  const h = createRuntimeHarness();
  await h.workers.register({ id: 'worker_a', hostname: 'host-1', now: h.clock.now() });
  await h.workers.register({ id: 'worker_b', hostname: 'host-2', now: h.clock.now() });

  assert.equal((await h.workers.list()).length, 2);
  assert.equal((await h.workers.get('worker_a'))?.state, 'alive');

  h.clock.advance(60_000);
  await h.workers.heartbeat('worker_a', h.clock.now());

  const reaped = await h.workers.reapStale(h.clock.now() - heartbeatDeadline(5_000));
  assert.deepEqual(reaped, ['worker_b'], 'only the silent worker is declared dead');
  assert.equal((await h.workers.get('worker_a'))?.state, 'alive');
  assert.equal((await h.workers.get('worker_b'))?.state, 'dead');
});

test('a job is held by exactly one worker at a time', async () => {
  const h = createRuntimeHarness();
  const now = h.clock.now();

  const first = await h.deliveries.claim('evt_1', 'projector', 'worker_a', now + 30_000, now);
  assert.ok(first, 'the first worker takes the job');
  assert.equal(first?.leaseOwner, 'worker_a');
  assert.equal(first?.state, 'leased');
  assert.equal(first?.attemptCount, 1);

  const second = await h.deliveries.claim('evt_1', 'projector', 'worker_b', now + 30_000, now);
  assert.equal(second, undefined, 'a second worker must not get the same job');

  assert.equal(await h.deliveries.countHeldBy('worker_a'), 1);
  assert.equal(await h.deliveries.countHeldBy('worker_b'), 0);
});

test('an expired lease returns the job to the queue with its attempt count and checkpoint intact', async () => {
  const h = createRuntimeHarness();
  const now = h.clock.now();

  const claimed = await h.deliveries.claim('evt_1', 'projector', 'worker_a', now + 10_000, now);
  assert.ok(claimed);
  // The worker saves progress, then dies without completing.
  await h.deliveries.put({ ...claimed, state: 'running', checkpoint: { processed: 7 } });

  // Before expiry nothing is reclaimable.
  assert.deepEqual(await h.deliveries.reclaimExpired(now + 5_000), []);

  const reclaimed = await h.deliveries.reclaimExpired(now + 20_000);
  assert.equal(reclaimed.length, 1, 'the abandoned job is reclaimed once its lease lapses');
  assert.equal(reclaimed[0]?.state, 'queued');
  assert.equal(reclaimed[0]?.leaseOwner, undefined, 'the dead worker no longer holds it');
  assert.equal(reclaimed[0]?.attemptCount, 1, 'the attempt count is preserved');
  assert.deepEqual(reclaimed[0]?.checkpoint, { processed: 7 }, 'progress is preserved so the retry resumes');

  // Another worker can now take it, and it is attempt 2.
  const retaken = await h.deliveries.claim('evt_1', 'projector', 'worker_b', now + 40_000, now + 20_000);
  assert.equal(retaken?.leaseOwner, 'worker_b');
  assert.equal(retaken?.attemptCount, 2);
  assert.deepEqual(retaken?.checkpoint, { processed: 7 });
});

test('a completed job is never re-claimed, so at-least-once delivery cannot double-run it', async () => {
  const h = createRuntimeHarness();
  const now = h.clock.now();
  await h.deliveries.put({
    outboxId: 'evt_1',
    consumer: 'projector',
    state: 'completed',
    attemptCount: 1,
    nextAttemptAt: now,
  });

  assert.equal(await h.deliveries.claim('evt_1', 'projector', 'worker_b', now + 10_000, now), undefined);
  assert.deepEqual(await h.deliveries.reclaimExpired(now + 100_000), [], 'a completed job is not reclaimable');
});

test('a consumer can checkpoint progress and a retry resumes from it', async () => {
  const h = createRuntimeHarness({ retry: { maxAttempts: 4, baseMs: 1_000, factor: 1 } });
  const seen: (number | undefined)[] = [];
  let attempts = 0;

  h.orchestrator.subscribe({
    name: 'resumable',
    events: ['Chunked'],
    handle: async (_event, ctx) => {
      attempts += 1;
      seen.push(ctx.checkpoint['processed'] as number | undefined);
      // Process half, save, then fail on the first attempt only.
      if (attempts === 1) {
        await ctx.saveCheckpoint({ processed: 5 });
        return err(transientError('half_done', 'interrupted'));
      }
      return ok(undefined);
    },
  });

  await h.outbox.append([{ aggregateType: 'experience', aggregateId: 'A', eventName: 'Chunked', payload: {} }], 'corr');
  await h.orchestrator.drain();
  h.clock.advance(60_000);
  await h.orchestrator.drain();

  assert.equal(attempts, 2);
  assert.deepEqual(seen, [undefined, 5], 'the retry sees the checkpoint the first attempt wrote');
});

test('execution history records every transition of a job', async () => {
  const h = createRuntimeHarness({ retry: { maxAttempts: 2, baseMs: 1_000, factor: 1 } });
  h.orchestrator.subscribe({
    name: 'flaky',
    events: ['Tracked'],
    handle: async () => err(transientError('nope', 'transient')),
  });

  const [record] = await h.outbox.append(
    [{ aggregateType: 'experience', aggregateId: 'A', eventName: 'Tracked', payload: {} }],
    'corr',
  );
  await h.orchestrator.drain();
  h.clock.advance(60_000);
  await h.orchestrator.drain();

  const history = await h.jobHistory.forDelivery(`${record?.id}::flaky`);
  const states = history.map((entry) => entry.state);
  assert.ok(states.includes('leased'), 'the lease is recorded');
  assert.ok(states.includes('running'), 'the run is recorded');
  assert.ok(states.includes('failed'), 'the failure is recorded');
  assert.ok(states.includes('retrying'), 'the retry decision is recorded');
  assert.ok(states.includes('dead_letter'), 'the final dead-letter is recorded');
  assert.ok(history.every((entry) => entry.workerId !== undefined), 'every entry names the worker');
});

test('the concurrency limit bounds how many jobs one worker holds', async () => {
  const h = createRuntimeHarness({ maxConcurrent: 2 });
  const now = h.clock.now();
  for (const id of ['evt_1', 'evt_2']) {
    await h.deliveries.claim(id, 'slow', h.orchestrator.workerId, now + 30_000, now);
  }
  assert.equal(await h.deliveries.countHeldBy(h.orchestrator.workerId), 2);

  let ran = 0;
  h.orchestrator.subscribe({
    name: 'slow',
    events: ['Limited'],
    handle: async () => {
      ran += 1;
      return ok(undefined);
    },
  });
  await h.outbox.append(
    [{ aggregateType: 'experience', aggregateId: 'B', eventName: 'Limited', payload: {} }],
    'corr',
  );

  await h.orchestrator.drain();
  assert.equal(ran, 0, 'a worker at its limit takes no further work');

  // Once the held leases lapse the worker proceeds.
  h.clock.advance(60_000);
  await h.orchestrator.drainAll();
  assert.equal(ran, 1);
});

test('a worker restart resumes in-flight work without duplicating it', async () => {
  const h = createRuntimeHarness();
  let effects = 0;
  const applied = new Set<string>();

  // The consumer is idempotent, as at-least-once delivery requires.
  const consumer = {
    name: 'projector',
    events: ['Restarted'],
    handle: async (event: { id: string }) => {
      if (applied.has(event.id)) return ok(undefined);
      applied.add(event.id);
      effects += 1;
      return ok(undefined);
    },
  };

  const [record] = await h.outbox.append(
    [{ aggregateType: 'experience', aggregateId: 'A', eventName: 'Restarted', payload: {} }],
    'corr',
  );
  assert.ok(record);

  // Worker A leases the job and dies mid-flight, leaving the lease behind.
  const now = h.clock.now();
  const leased = await h.deliveries.claim(record?.id ?? '', 'projector', 'worker_a', now + 10_000, now);
  await h.deliveries.put({ ...(leased as NonNullable<typeof leased>), state: 'running' });
  await h.workers.register({ id: 'worker_a', hostname: 'host-a', now });

  // Worker B starts up after the lease has lapsed and drains.
  h.clock.advance(30_000);
  const workerB = createRuntimeHarness({
    shared: { outbox: h.outbox, deliveries: h.deliveries, deadLetters: h.deadLetters, workers: h.workers, clock: h.clock },
    workerId: 'worker_b',
  });
  workerB.orchestrator.subscribe(consumer);

  await workerB.orchestrator.drainAll();

  assert.equal(effects, 1, 'the work happens exactly once across the restart');
  assert.equal(await h.outbox.pendingCount(), 0, 'and the event is fully delivered');

  const delivery = await h.deliveries.get(record?.id ?? '', 'projector');
  assert.equal(delivery?.state, 'completed');
  assert.equal(delivery?.leaseOwner, 'worker_b', 'the surviving worker finished it');
});

test('two workers draining the same backlog never run one job twice', async () => {
  const h = createRuntimeHarness();
  const runs: string[] = [];
  const consumer = (label: string) => ({
    name: 'shared',
    events: ['Contended'],
    handle: async () => {
      runs.push(label);
      return ok(undefined);
    },
  });

  await h.outbox.append(
    [{ aggregateType: 'experience', aggregateId: 'A', eventName: 'Contended', payload: {} }],
    'corr',
  );

  const shared = {
    outbox: h.outbox,
    deliveries: h.deliveries,
    deadLetters: h.deadLetters,
    workers: h.workers,
    clock: h.clock,
  };
  const a = createRuntimeHarness({ shared, workerId: 'worker_a' });
  const b = createRuntimeHarness({ shared, workerId: 'worker_b' });
  a.orchestrator.subscribe(consumer('a'));
  b.orchestrator.subscribe(consumer('b'));

  // Drain concurrently: exactly one of them may run the job.
  await Promise.all([a.orchestrator.drain(), b.orchestrator.drain()]);

  assert.equal(runs.length, 1, `exactly one worker ran the job, got ${runs.join(',')}`);
});

test('a poison message is isolated and does not block healthy jobs behind it', async () => {
  const h = createRuntimeHarness({ retry: { maxAttempts: 1 } });
  const healthy: string[] = [];

  h.orchestrator.subscribe({
    name: 'poison-handler',
    events: ['Poison'],
    handle: async () => err(internalError('unprocessable', 'poison')),
  });
  h.orchestrator.subscribe({
    name: 'healthy-handler',
    events: ['Healthy'],
    handle: async (event) => {
      healthy.push(event.aggregateId);
      return ok(undefined);
    },
  });

  await h.outbox.append([{ aggregateType: 'experience', aggregateId: 'A', eventName: 'Poison', payload: {} }], 'c1');
  await h.outbox.append([{ aggregateType: 'experience', aggregateId: 'B', eventName: 'Healthy', payload: {} }], 'c2');

  await h.orchestrator.drainAll();

  assert.deepEqual(healthy, ['B'], 'the healthy aggregate is processed');
  assert.equal((await h.deadLetters.list()).length, 1, 'the poison message is isolated');
  assert.equal(await h.outbox.pendingCount(), 0, 'and neither event stays pending');
});

test('a drain reports reclaimed and contended counts for observability', async () => {
  const h = createRuntimeHarness();
  const now = h.clock.now();
  // A job abandoned by another worker.
  const claimed = await h.deliveries.claim('evt_x', 'watcher', 'worker_gone', now + 1_000, now);
  await h.deliveries.put({ ...(claimed as NonNullable<typeof claimed>), state: 'running' });
  h.clock.advance(5_000);

  const report = await h.orchestrator.drain();
  assert.equal(report.reclaimed, 1, 'the report surfaces reclaimed work');
  assert.equal(typeof report.contended, 'number');
});
