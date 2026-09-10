import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness } from '../support/engine-harness.ts';
import {
  incidentReport,
  incidentSurfaceAddsACommand,
  incidentSurfaceReclaimsLeases,
  staleWorkers,
  strugglingEvents,
  STRUGGLING_ATTEMPT_THRESHOLD,
} from '../../src/engines/incident.engine.ts';
import { heartbeatDeadline } from '../../src/runtime/jobs.ts';
import type { OutboxRecord } from '../../src/runtime/outbox.ts';
import type { WorkerRecord } from '../../src/runtime/jobs.ts';

/**
 * Phase 66.
 *
 * The tables all existed; what was missing was a read. So most of what is worth testing
 * here is what the read *refuses* to do — it reports a stuck lease rather than reclaiming
 * it, and it offers no command of its own.
 */
const NOW = 1_800_000_000_000;

const worker = (over: Partial<WorkerRecord> = {}): WorkerRecord => ({
  id: 'w1',
  hostname: 'worker-1',
  startedAt: NOW - 60_000,
  lastHeartbeatAt: NOW,
  state: 'alive',
  ...over,
});

const outboxRecord = (over: Partial<OutboxRecord> = {}): OutboxRecord =>
  ({
    id: 'evt_1',
    aggregateType: 'experience',
    aggregateId: 'exp_1',
    eventName: 'ExperiencePublished',
    payload: {},
    correlationId: 'corr',
    sequence: 1,
    occurredAt: NOW,
    state: 'queued',
    attemptCount: 0,
    nextAttemptAt: NOW,
    ...over,
  }) as OutboxRecord;

test('a worker that has stopped heartbeating is reported, with how long ago', async () => {
  const silent = worker({ id: 'w_silent', lastHeartbeatAt: NOW - heartbeatDeadline() - 5_000 });
  const stale = await staleWorkers([worker(), silent], NOW);
  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.id, 'w_silent');
  assert.ok((stale[0]?.silentForMs ?? 0) > heartbeatDeadline(), 'and how long it has been silent');
});

test('a worker already marked dead is not reported again', async () => {
  // It has been handled. Listing it would mean an operator reading the same failure twice
  // and wondering which one is current.
  const stale = await staleWorkers(
    [worker({ state: 'dead', lastHeartbeatAt: NOW - 10 * heartbeatDeadline() })],
    NOW,
  );
  assert.deepEqual(stale, []);
});

test('a worker inside its grace period is not stale, so a slow beat is not an incident', async () => {
  const stale = await staleWorkers([worker({ lastHeartbeatAt: NOW - heartbeatDeadline() + 1 })], NOW);
  assert.deepEqual(stale, [], 'the grace multiplier is what makes a missed beat survivable');
});

test('one failure is a retry doing its job, and is not listed', () => {
  // A surface that is noisy on a normal day is one nobody reads on an abnormal one.
  const listed = strugglingEvents([
    outboxRecord({ attemptCount: 1, state: 'failed', lastError: 'timeout' }),
  ]);
  assert.deepEqual(listed, []);
});

test('an event past the threshold is listed, worst first, with its last error', () => {
  const listed = strugglingEvents([
    outboxRecord({ id: 'a', attemptCount: STRUGGLING_ATTEMPT_THRESHOLD, state: 'failed' }),
    outboxRecord({ id: 'b', attemptCount: 9, state: 'failed', lastError: 'connection refused' }),
  ]);
  assert.deepEqual(
    listed.map((event) => event.id),
    ['b', 'a'],
    'worst first, because that is the one to look at',
  );
  assert.equal(listed[0]?.lastError, 'connection refused');
});

test('a delivered event is never listed, however many attempts it took', () => {
  // The check is `deliveredAt`, not a state comparison. An outbox record's terminal state
  // is `ready`, so comparing against `completed` would have been vacuously true for every
  // record and listed successful deliveries as struggling.
  const listed = strugglingEvents([
    outboxRecord({ attemptCount: 12, state: 'ready', deliveredAt: NOW }),
  ]);
  assert.deepEqual(listed, [], 'it succeeded in the end, which is the retry working');
});

test('the report is one read, so every number agrees with every other', async () => {
  // Five separate reads taken at five instants cannot answer the question an operator is
  // actually asking, which is whether these are one problem or several.
  const h = createEngineHarness();
  const report = await incidentReport(h.engine);
  assert.equal(typeof report.generatedAt, 'number');
  assert.equal(report.health.state, 'healthy', 'a fresh engine is healthy');
  assert.deepEqual(report.deadLetters, []);
  assert.deepEqual(report.struggling, []);
  assert.equal(report.outboxPending, 0);
});

test('a dead letter is reported with its full failure history', async () => {
  // "It failed" is not a diagnosis, and the attempt that failed *differently* is usually
  // the informative one — so the history travels rather than the latest error alone.
  const h = createEngineHarness();
  const recorded = await h.engine.deadLetters.record({
    source: 'consumer:feed',
    eventName: 'ExperiencePublished',
    aggregateType: 'experience',
    aggregateId: 'exp_1',
    payload: { experienceId: 'exp_1' },
    correlationId: 'corr',
    failureHistory: [
      { attempt: 1, error: 'timeout', at: NOW },
      { attempt: 2, error: 'constraint violation on feed_entries', at: NOW + 1 },
    ],
  });

  const report = await incidentReport(h.engine);
  assert.equal(report.deadLetters.length, 1);
  assert.equal(report.deadLetters[0]?.id, recorded.id);
  assert.equal(report.deadLetters[0]?.failureHistory.length, 2, 'both attempts, not just the last');
  assert.match(
    report.deadLetters[0]?.failureHistory[1]?.error ?? '',
    /constraint violation/,
    'and the one that says what actually broke',
  );
});

test('the surface reports a stuck worker and reclaims nothing', async () => {
  // The runtime already reclaims a dead worker's leases on its own schedule. A surface
  // that also did it would be a second actor racing the first, which is exactly the class
  // of bug an incident surface exists to help find.
  const h = createEngineHarness();
  await h.engine.workers.register({ id: 'w_stuck', hostname: 'host-1', now: h.clock.now() });
  h.clock.advance(heartbeatDeadline() + 10_000);

  const report = await incidentReport(h.engine);
  assert.equal(report.staleWorkers.length, 1, 'it is reported as silent');

  const after = await h.engine.workers.get('w_stuck');
  assert.equal(after?.state, 'alive', 'and its state was not changed by looking at it');
  assert.equal(incidentSurfaceReclaimsLeases(), false);
});

test('the incident surface registers no command of its own', async () => {
  // Replay already exists, is already governed by the policy matrix, and already writes an
  // audit event. A second path is how one of them ends up without the audit.
  const h = createEngineHarness();
  const commands = h.engine.bus.registeredCommands();
  assert.equal(
    commands.some((name) => name.startsWith('incident.')),
    false,
  );
  assert.ok(commands.includes('governance.replayDeadLetter'), 'the existing replay is the action');
  assert.equal(incidentSurfaceAddsACommand(), false);
});

test('no workers registered is distinguishable from every worker healthy', async () => {
  // They look identical on a page that only lists problems, and they are opposite
  // situations: one means the queue is draining, the other means nothing is draining it.
  const h = createEngineHarness();
  const empty = await incidentReport(h.engine);
  assert.deepEqual(empty.workers, [], 'nothing registered');

  await h.engine.workers.register({ id: 'w_live', hostname: 'host-1', now: h.clock.now() });
  const staffed = await incidentReport(h.engine);
  assert.equal(staffed.workers.length, 1);
  assert.deepEqual(staffed.staleWorkers, [], 'registered and healthy');
});
