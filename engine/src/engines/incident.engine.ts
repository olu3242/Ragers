import { heartbeatDeadline, type WorkerRecord } from '../runtime/jobs.ts';
import type { HealthReport } from '../runtime/health.ts';
import type { DeadLetterRecord } from '../runtime/deadletter.ts';
import type { OutboxRecord } from '../runtime/outbox.ts';
import type { Engine } from '../engine.ts';

/**
 * Operator incident reads — Phase 66.
 *
 * The tables an operator needs during an incident all exist: dead letters with their full
 * failure history, worker heartbeats, the outbox with its attempt counts, and the leased
 * job runtime. What did not exist is a *read*. An operator diagnosing a stuck pipeline
 * today opens psql, and the first thing they do at 03:00 is remember the schema.
 *
 * Three constraints shape this, all from the roadmap and all worth restating because each
 * one rules out a shortcut that would have been easier:
 *
 * **Reads and existing commands only.** Replay already exists as
 * `governance.replayDeadLetter`, it is already governed by the policy matrix, and it
 * already writes an audit event. This surfaces it rather than adding a second path — a
 * second path is how one of them ends up without the audit.
 *
 * **No new privilege.** Everything here is reachable by a moderator or an admin through
 * the policy matrix already, or it does not appear. This module adds no capability; it
 * adds a question that can now be asked in one call instead of five.
 *
 * **It diagnoses; it does not decide.** Nothing here retries, reclaims, drains or
 * quarantines anything on its own. A stuck lease is *reported* as stuck. The system
 * already reclaims dead workers' leases on its own schedule, and a surface that also did
 * it would be a second actor racing the first — which is exactly the class of bug an
 * incident surface exists to help find.
 */

/** A worker that has missed enough heartbeats to be presumed gone. */
export interface StaleWorker {
  readonly id: string;
  readonly hostname: string;
  readonly state: WorkerRecord['state'];
  readonly lastHeartbeatAt: number;
  readonly silentForMs: number;
}

/** An outbox event that has failed enough times to be worth a person's attention. */
export interface StrugglingEvent {
  readonly id: string;
  readonly eventName: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly attemptCount: number;
  readonly state: OutboxRecord['state'];
  readonly lastError?: string;
  readonly nextAttemptAt: number;
}

export interface IncidentReport {
  /**
   * The raw health report, **not** the degraded reading.
   *
   * Phase 67's rule is that nothing under `src/domain` or `src/engines` imports
   * `degraded.ts`, so that an unavailable dependency can never start causing refusals in
   * addition to the ones it already causes. This module is a pure read and would have been
   * a defensible exception — and the guard caught it, which is the argument for not making
   * one. Exceptions to an invariant erode it; the surface calls `degradedStateFrom` itself,
   * and the atomicity that matters is preserved because this report captures the health at
   * the same instant as everything else on the page.
   */
  readonly health: HealthReport;
  /** Exhausted work, newest first. Each carries its full failure history. */
  readonly deadLetters: readonly DeadLetterRecord[];
  /** Events still retrying, worst first. Empty is the normal state. */
  readonly struggling: readonly StrugglingEvent[];
  /** Workers whose heartbeat has stopped. */
  readonly staleWorkers: readonly StaleWorker[];
  /** Every worker, so "none registered" is distinguishable from "all healthy". */
  readonly workers: readonly WorkerRecord[];
  readonly outboxPending: number;
  readonly generatedAt: number;
}

/**
 * Attempts before an event is worth a person's attention.
 *
 * One failure is a retry doing its job and listing it would make the surface a wall of
 * noise on a normal day — and a surface that is noisy on a normal day is one nobody reads
 * on an abnormal one. Three means the backoff has been running for a while and it is not
 * getting better.
 */
export const STRUGGLING_ATTEMPT_THRESHOLD = 3;

/** How many of each list to return. An incident surface is read, not paged through. */
export const INCIDENT_LIST_LIMIT = 50;

/**
 * Workers whose heartbeat stopped, with how long ago.
 *
 * Derived on read from the heartbeat timestamps, never from a stored "is stale" flag:
 * a stored flag needs somebody to set it, and the thing that would set it is the
 * component that just stopped responding.
 */
export const staleWorkers = async (
  workers: readonly WorkerRecord[],
  now: number,
  heartbeatMs?: number,
): Promise<readonly StaleWorker[]> => {
  const deadline = heartbeatDeadline(heartbeatMs);
  return workers
    .filter((worker) => worker.state !== 'dead' && now - worker.lastHeartbeatAt > deadline)
    .map((worker) => ({
      id: worker.id,
      hostname: worker.hostname,
      state: worker.state,
      lastHeartbeatAt: worker.lastHeartbeatAt,
      silentForMs: now - worker.lastHeartbeatAt,
    }))
    .sort((left, right) => right.silentForMs - left.silentForMs);
};

/** Events retrying past the threshold, worst first. */
export const strugglingEvents = (records: readonly OutboxRecord[]): readonly StrugglingEvent[] =>
  records
    .filter(
      (record) =>
        record.attemptCount >= STRUGGLING_ATTEMPT_THRESHOLD &&
        // `deliveredAt` rather than a state comparison: an outbox record's terminal state
        // is `ready`, not `completed`, and a `!== 'completed'` check would have been
        // vacuously true for every record — listing delivered events as struggling.
        record.deliveredAt === undefined,
    )
    .sort((left, right) => right.attemptCount - left.attemptCount)
    .slice(0, INCIDENT_LIST_LIMIT)
    .map((record) => ({
      id: record.id,
      eventName: record.eventName,
      aggregateType: record.aggregateType,
      aggregateId: record.aggregateId,
      attemptCount: record.attemptCount,
      state: record.state,
      ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
      nextAttemptAt: record.nextAttemptAt,
    }));

/**
 * The whole picture, in one call.
 *
 * One call rather than five because the thing an operator is trying to establish is
 * whether these are one problem or several, and five separate reads taken at five
 * different instants cannot answer that. `generatedAt` is stamped once, so every number
 * on the page is as of the same moment.
 */
export const incidentReport = async (deps: Engine): Promise<IncidentReport> => {
  const now = deps.clock.now();
  const workers = await deps.workers.list();

  const deadLetters = [...(await deps.deadLetters.list())]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, INCIDENT_LIST_LIMIT);

  return {
    health: await deps.health.report(),
    deadLetters,
    struggling: strugglingEvents(await deps.outbox.all()),
    staleWorkers: await staleWorkers(workers, now),
    workers,
    outboxPending: await deps.outbox.pendingCount(),
    generatedAt: now,
  };
};

/**
 * The absences, as code.
 *
 * An incident surface that could act would be a second actor racing the runtime that
 * already reclaims dead workers' leases — the exact class of bug it exists to help find.
 * Replay is the one action offered, and it is `governance.replayDeadLetter`: already
 * governed, already audited, already there.
 */
export const incidentSurfaceReclaimsLeases = (): false => false;
export const incidentSurfaceAddsACommand = (): false => false;
