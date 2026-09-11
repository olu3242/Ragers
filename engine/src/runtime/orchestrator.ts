import { err, ok, type Result } from './result.ts';
import { internalError, type EngineError } from './errors.ts';
import type { Clock } from './clock.ts';
import type { IdFactory } from './ids.ts';
import type { Logger } from './logger.ts';
import type { Metrics } from './metrics.ts';
import type { DomainEventEnvelope, Outbox, OutboxRecord } from './outbox.ts';
import type { DeadLetterStore } from './deadletter.ts';
import type { RetryPolicy } from './retry.ts';
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_MS,
  heartbeatDeadline,
  isHeldJob,
  type JobHistory,
  type JobState,
  type WorkerRegistry,
} from './jobs.ts';

export interface ConsumerContext {
  readonly correlationId: string;
  /** The event that caused this one, for tracing a chain across engines. */
  readonly causationId?: string;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly logger: Logger;
  /** Progress saved by a previous attempt of this same job, if any. */
  readonly checkpoint: Readonly<Record<string, unknown>>;
  /**
   * Persist partial progress so a retry resumes instead of restarting. The
   * checkpoint is scoped to this (event, consumer) job.
   */
  saveCheckpoint(checkpoint: Readonly<Record<string, unknown>>): Promise<void>;
}

/**
 * Async consumer. Delivery is at-least-once, so every implementation must be
 * idempotent — re-handling an event must not produce a second effect.
 */
export interface Consumer {
  readonly name: string;
  readonly events: readonly string[];
  handle(event: DomainEventEnvelope, ctx: ConsumerContext): Promise<Result<void, EngineError>>;
}

/** Per (event, consumer) delivery state, so one failing consumer cannot block others. */
export interface DeliveryRecord {
  readonly outboxId: string;
  readonly consumer: string;
  readonly state: JobState;
  readonly attemptCount: number;
  readonly nextAttemptAt: number;
  readonly lastError?: string;
  /** Worker currently holding the job, if any. */
  readonly leaseOwner?: string;
  readonly leasedUntil?: number;
  readonly checkpoint?: Readonly<Record<string, unknown>>;
}

export interface DeliveryLedger {
  get(outboxId: string, consumer: string): Promise<DeliveryRecord | undefined>;
  put(record: DeliveryRecord): Promise<void>;
  forOutbox(outboxId: string): Promise<readonly DeliveryRecord[]>;
  all(): Promise<readonly DeliveryRecord[]>;

  /**
   * Atomically take the job for `workerId` until `leasedUntil`. Returns
   * undefined when another worker holds a live lease — that is the mechanism
   * preventing two workers from running the same job.
   */
  claim(
    outboxId: string,
    consumer: string,
    workerId: string,
    leasedUntil: number,
    now: number,
  ): Promise<DeliveryRecord | undefined>;

  /** Return jobs whose lease expired to `queued`, so a dead worker's work resumes. */
  reclaimExpired(now: number): Promise<readonly DeliveryRecord[]>;

  /** Jobs currently held by a worker, for the concurrency limit. */
  countHeldBy(workerId: string): Promise<number>;
}

export interface DrainReport {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly skipped: number;
  /** Jobs whose lease had expired and were returned to the queue. */
  readonly reclaimed: number;
  /** Jobs skipped because another worker holds a live lease. */
  readonly contended: number;
}

export interface OrchestratorDeps {
  readonly outbox: Outbox;
  readonly deliveries: DeliveryLedger;
  readonly deadLetters: DeadLetterStore;
  readonly retry: RetryPolicy;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** Identity of this worker. Defaults to a generated id. */
  readonly workerId?: string;
  readonly hostname?: string;
  readonly workers?: WorkerRegistry;
  readonly history?: JobHistory;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  /** Maximum jobs this worker will hold at once. */
  readonly maxConcurrent?: number;
}

export interface Orchestrator {
  subscribe(consumer: Consumer): void;
  readonly workerId: string;
  /** Register this worker and send a heartbeat. Safe to call repeatedly. */
  announce(): Promise<void>;
  drain(limit?: number): Promise<DrainReport>;
  /** Drain repeatedly until no progress is made — used by tests and jobs. */
  drainAll(maxRounds?: number): Promise<DrainReport>;
  consumersFor(eventName: string): readonly string[];
}

export const createOrchestrator = (deps: OrchestratorDeps): Orchestrator => {
  const byEvent = new Map<string, Consumer[]>();
  const all: Consumer[] = [];

  const workerId = deps.workerId ?? deps.ids.next('worker');
  const hostname = deps.hostname ?? 'local';
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxConcurrent = deps.maxConcurrent ?? 16;
  let announced = false;

  const subscribe = (consumer: Consumer): void => {
    if (all.some((c) => c.name === consumer.name)) {
      throw new Error(`Duplicate consumer: ${consumer.name}`);
    }
    all.push(consumer);
    for (const eventName of consumer.events) {
      const list = byEvent.get(eventName) ?? [];
      list.push(consumer);
      byEvent.set(eventName, list);
    }
  };

  const record = async (
    delivery: DeliveryRecord,
    state: JobState,
    detail?: string,
  ): Promise<void> => {
    await deps.history?.append({
      deliveryId: `${delivery.outboxId}::${delivery.consumer}`,
      attempt: delivery.attemptCount,
      state,
      workerId,
      ...(detail === undefined ? {} : { detail }),
      at: deps.clock.now(),
    });
  };

  const announce = async (): Promise<void> => {
    if (!deps.workers) return;
    if (!announced) {
      await deps.workers.register({ id: workerId, hostname, now: deps.clock.now() });
      announced = true;
    }
    await deps.workers.heartbeat(workerId, deps.clock.now());
  };

  const deliverOne = async (
    outboxRecord: OutboxRecord,
    consumer: Consumer,
    report: { delivered: number; retried: number; deadLettered: number; skipped: number; contended: number },
  ): Promise<{ terminal: boolean; nextAttemptAt: number }> => {
    const now = deps.clock.now();
    const existing = await deps.deliveries.get(outboxRecord.id, consumer.name);

    // Terminal jobs are never re-run: at-least-once delivery relies on this.
    if (existing && (existing.state === 'completed' || existing.state === 'dead_letter')) {
      report.skipped += 1;
      return { terminal: true, nextAttemptAt: now };
    }
    if (existing && existing.state === 'retrying' && existing.nextAttemptAt > now) {
      return { terminal: false, nextAttemptAt: existing.nextAttemptAt };
    }

    // Lease the job. Another worker holding a live lease means we skip it.
    const leased = await deps.deliveries.claim(
      outboxRecord.id,
      consumer.name,
      workerId,
      now + leaseMs,
      now,
    );
    if (!leased) {
      report.contended += 1;
      deps.metrics.increment('job.contended', { consumer: consumer.name });
      return { terminal: false, nextAttemptAt: now + leaseMs };
    }
    await record(leased, 'leased');

    const attempt = leased.attemptCount;
    const running: DeliveryRecord = { ...leased, state: 'running' };
    await deps.deliveries.put(running);
    await record(running, 'running');

    const event: DomainEventEnvelope = {
      id: outboxRecord.id,
      aggregateType: outboxRecord.aggregateType,
      aggregateId: outboxRecord.aggregateId,
      sequence: outboxRecord.sequence,
      eventName: outboxRecord.eventName,
      payload: outboxRecord.payload,
      correlationId: outboxRecord.correlationId,
      occurredAt: outboxRecord.occurredAt,
    };

    let outcome: Result<void, EngineError>;
    try {
      outcome = await consumer.handle(event, {
        correlationId: outboxRecord.correlationId,
        ...(outboxRecord.causationId === undefined ? {} : { causationId: outboxRecord.causationId }),
        clock: deps.clock,
        ids: deps.ids,
        logger: deps.logger.child({
          consumer: consumer.name,
          correlationId: outboxRecord.correlationId,
          workerId,
        }),
        checkpoint: running.checkpoint ?? {},
        saveCheckpoint: async (checkpoint) => {
          const current = await deps.deliveries.get(outboxRecord.id, consumer.name);
          if (current) await deps.deliveries.put({ ...current, checkpoint });
        },
      });
    } catch (cause) {
      outcome = err(
        internalError('consumer_threw', `Consumer ${consumer.name} threw`, {
          cause: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }

    // Re-read: the handler may have written a checkpoint through saveCheckpoint,
    // and rebuilding the record from the pre-run copy would discard it.
    const latest = (await deps.deliveries.get(outboxRecord.id, consumer.name)) ?? running;

    if (outcome.ok) {
      const completed: DeliveryRecord = {
        outboxId: outboxRecord.id,
        consumer: consumer.name,
        state: 'completed',
        attemptCount: attempt,
        nextAttemptAt: now,
        // Retained for traceability: which worker finished this job. `completed`
        // is not a held state, so this does not count against concurrency.
        ...(latest.leaseOwner === undefined ? {} : { leaseOwner: latest.leaseOwner }),
      };
      await deps.deliveries.put(completed);
      await record(completed, 'completed');
      report.delivered += 1;
      deps.metrics.increment('consumer.delivered', { consumer: consumer.name, event: outboxRecord.eventName });
      return { terminal: true, nextAttemptAt: now };
    }

    const failure = outcome.error;
    const message = `${failure.code}: ${failure.message}`;
    const failed: DeliveryRecord = {
      outboxId: outboxRecord.id,
      consumer: consumer.name,
      state: 'failed',
      attemptCount: attempt,
      nextAttemptAt: now,
      lastError: message,
      ...(latest.checkpoint === undefined ? {} : { checkpoint: latest.checkpoint }),
      ...(latest.leaseOwner === undefined ? {} : { leaseOwner: latest.leaseOwner }),
    };
    await deps.deliveries.put(failed);
    await record(failed, 'failed', message);

    if (deps.retry.shouldRetry(failure, attempt)) {
      const nextAttemptAt = now + deps.retry.backoffMs(attempt);
      const retrying: DeliveryRecord = { ...failed, state: 'retrying', nextAttemptAt };
      await deps.deliveries.put(retrying);
      await record(retrying, 'retrying', message);
      report.retried += 1;
      deps.metrics.increment('consumer.retried', { consumer: consumer.name, event: outboxRecord.eventName });
      return { terminal: false, nextAttemptAt };
    }

    // Exhausted or non-retryable: dead-letter with the full history preserved.
    const history = [];
    for (let i = 1; i <= attempt; i += 1) {
      history.push({ attempt: i, error: i === attempt ? message : (existing?.lastError ?? message), at: now });
    }
    await deps.deadLetters.record({
      source: consumer.name,
      eventName: outboxRecord.eventName,
      aggregateType: outboxRecord.aggregateType,
      aggregateId: outboxRecord.aggregateId,
      payload: outboxRecord.payload,
      correlationId: outboxRecord.correlationId,
      failureHistory: history,
    });
    const dead: DeliveryRecord = { ...failed, state: 'dead_letter' };
    await deps.deliveries.put(dead);
    await record(dead, 'dead_letter', message);
    report.deadLettered += 1;
    deps.metrics.increment('consumer.dead_lettered', { consumer: consumer.name, event: outboxRecord.eventName });
    deps.logger.error('consumer.dead_lettered', {
      consumer: consumer.name,
      event: outboxRecord.eventName,
      correlationId: outboxRecord.correlationId,
      attempts: attempt,
      workerId,
    });
    return { terminal: true, nextAttemptAt: now };
  };

  const drain = async (limit = 50): Promise<DrainReport> => {
    await announce();

    // Reclaim first: a worker that died mid-job leaves a lease behind, and its
    // work must resume rather than wait for that process to come back.
    const reclaimed = await deps.deliveries.reclaimExpired(deps.clock.now());
    for (const job of reclaimed) {
      await record(job, 'queued', 'lease expired');
      deps.metrics.increment('job.reclaimed', { consumer: job.consumer });
    }
    if (reclaimed.length > 0) {
      deps.logger.warn('job.reclaimed', { count: reclaimed.length, workerId });
    }

    // Reap workers that stopped heartbeating, so the registry reflects reality.
    await deps.workers?.reapStale(deps.clock.now() - heartbeatDeadline(heartbeatMs));

    const records = await deps.outbox.claimDue(limit);
    const report = { delivered: 0, retried: 0, deadLettered: 0, skipped: 0, contended: 0 };

    for (const outboxRecord of records) {
      const consumers = byEvent.get(outboxRecord.eventName) ?? [];
      if (consumers.length === 0) {
        // No subscriber is a valid state, not a failure: the event is delivered.
        await deps.outbox.markDelivered(outboxRecord.id);
        continue;
      }

      let allTerminal = true;
      let earliestNext = Number.POSITIVE_INFINITY;
      for (const consumer of consumers) {
        // Respect the concurrency limit rather than taking unbounded work.
        if ((await deps.deliveries.countHeldBy(workerId)) >= maxConcurrent) {
          allTerminal = false;
          earliestNext = Math.min(earliestNext, deps.clock.now() + leaseMs);
          break;
        }
        const result = await deliverOne(outboxRecord, consumer, report);
        if (!result.terminal) {
          allTerminal = false;
          earliestNext = Math.min(earliestNext, result.nextAttemptAt);
        }
      }
      if (allTerminal) await deps.outbox.markDelivered(outboxRecord.id);
      else await deps.outbox.markFailed(outboxRecord.id, 'awaiting consumer retry', earliestNext);
    }

    return { claimed: records.length, reclaimed: reclaimed.length, ...report };
  };

  const drainAll = async (maxRounds = 20): Promise<DrainReport> => {
    const total = {
      claimed: 0,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
      skipped: 0,
      reclaimed: 0,
      contended: 0,
    };
    for (let round = 0; round < maxRounds; round += 1) {
      const report = await drain();
      total.claimed += report.claimed;
      total.delivered += report.delivered;
      total.retried += report.retried;
      total.deadLettered += report.deadLettered;
      total.skipped += report.skipped;
      total.reclaimed += report.reclaimed;
      total.contended += report.contended;
      if (report.claimed === 0) break;
      if (report.delivered === 0 && report.deadLettered === 0 && report.skipped === 0 && report.reclaimed === 0) break;
    }
    return total;
  };

  return {
    subscribe,
    workerId,
    announce,
    drain,
    drainAll,
    consumersFor: (eventName: string) => (byEvent.get(eventName) ?? []).map((c) => c.name).sort(),
  };
};
