import { err, ok, type Result } from './result.ts';
import { internalError, type EngineError } from './errors.ts';
import type { Clock } from './clock.ts';
import type { IdFactory } from './ids.ts';
import type { Logger } from './logger.ts';
import type { Metrics } from './metrics.ts';
import type { DomainEventEnvelope, Outbox, OutboxRecord } from './outbox.ts';
import type { DeadLetterStore } from './deadletter.ts';
import type { RetryPolicy } from './retry.ts';
import type { WorkState } from './work.ts';

export interface ConsumerContext {
  readonly correlationId: string;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly logger: Logger;
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
  readonly state: WorkState;
  readonly attemptCount: number;
  readonly nextAttemptAt: number;
  readonly lastError?: string;
}

export interface DeliveryLedger {
  get(outboxId: string, consumer: string): Promise<DeliveryRecord | undefined>;
  put(record: DeliveryRecord): Promise<void>;
  forOutbox(outboxId: string): Promise<readonly DeliveryRecord[]>;
  all(): Promise<readonly DeliveryRecord[]>;
}

export interface DrainReport {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly skipped: number;
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
}

export interface Orchestrator {
  subscribe(consumer: Consumer): void;
  drain(limit?: number): Promise<DrainReport>;
  /** Drain repeatedly until no progress is made — used by tests and jobs. */
  drainAll(maxRounds?: number): Promise<DrainReport>;
  consumersFor(eventName: string): readonly string[];
}

export const createOrchestrator = (deps: OrchestratorDeps): Orchestrator => {
  const byEvent = new Map<string, Consumer[]>();
  const all: Consumer[] = [];

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

  const deliverOne = async (
    record: OutboxRecord,
    consumer: Consumer,
    report: { delivered: number; retried: number; deadLettered: number; skipped: number },
  ): Promise<{ terminal: boolean; nextAttemptAt: number }> => {
    const now = deps.clock.now();
    const existing = await deps.deliveries.get(record.id, consumer.name);

    if (existing && (existing.state === 'ready' || existing.state === 'dead_letter')) {
      report.skipped += 1;
      return { terminal: true, nextAttemptAt: now };
    }
    if (existing && existing.state === 'failed' && existing.nextAttemptAt > now) {
      return { terminal: false, nextAttemptAt: existing.nextAttemptAt };
    }

    const attempt = (existing?.attemptCount ?? 0) + 1;
    await deps.deliveries.put({
      outboxId: record.id,
      consumer: consumer.name,
      state: 'processing',
      attemptCount: attempt,
      nextAttemptAt: now,
    });

    const event: DomainEventEnvelope = {
      id: record.id,
      aggregateType: record.aggregateType,
      aggregateId: record.aggregateId,
      sequence: record.sequence,
      eventName: record.eventName,
      payload: record.payload,
      correlationId: record.correlationId,
      occurredAt: record.occurredAt,
    };

    let outcome: Result<void, EngineError>;
    try {
      outcome = await consumer.handle(event, {
        correlationId: record.correlationId,
        clock: deps.clock,
        ids: deps.ids,
        logger: deps.logger.child({ consumer: consumer.name, correlationId: record.correlationId }),
      });
    } catch (cause) {
      outcome = err(
        internalError('consumer_threw', `Consumer ${consumer.name} threw`, {
          cause: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }

    if (outcome.ok) {
      await deps.deliveries.put({
        outboxId: record.id,
        consumer: consumer.name,
        state: 'ready',
        attemptCount: attempt,
        nextAttemptAt: now,
      });
      report.delivered += 1;
      deps.metrics.increment('consumer.delivered', { consumer: consumer.name, event: record.eventName });
      return { terminal: true, nextAttemptAt: now };
    }

    const failure = outcome.error;
    const message = `${failure.code}: ${failure.message}`;

    if (deps.retry.shouldRetry(failure, attempt)) {
      const nextAttemptAt = now + deps.retry.backoffMs(attempt);
      await deps.deliveries.put({
        outboxId: record.id,
        consumer: consumer.name,
        state: 'failed',
        attemptCount: attempt,
        nextAttemptAt,
        lastError: message,
      });
      report.retried += 1;
      deps.metrics.increment('consumer.retried', { consumer: consumer.name, event: record.eventName });
      return { terminal: false, nextAttemptAt };
    }

    // Exhausted or non-retryable: dead-letter with the full history preserved.
    const history = [];
    for (let i = 1; i <= attempt; i += 1) {
      history.push({ attempt: i, error: i === attempt ? message : (existing?.lastError ?? message), at: now });
    }
    await deps.deadLetters.record({
      source: consumer.name,
      eventName: record.eventName,
      aggregateType: record.aggregateType,
      aggregateId: record.aggregateId,
      payload: record.payload,
      correlationId: record.correlationId,
      failureHistory: history,
    });
    await deps.deliveries.put({
      outboxId: record.id,
      consumer: consumer.name,
      state: 'dead_letter',
      attemptCount: attempt,
      nextAttemptAt: now,
      lastError: message,
    });
    report.deadLettered += 1;
    deps.metrics.increment('consumer.dead_lettered', { consumer: consumer.name, event: record.eventName });
    deps.logger.error('consumer.dead_lettered', {
      consumer: consumer.name,
      event: record.eventName,
      correlationId: record.correlationId,
      attempts: attempt,
    });
    return { terminal: true, nextAttemptAt: now };
  };

  const drain = async (limit = 50): Promise<DrainReport> => {
    const records = await deps.outbox.claimDue(limit);
    const report = { delivered: 0, retried: 0, deadLettered: 0, skipped: 0 };

    for (const record of records) {
      const consumers = byEvent.get(record.eventName) ?? [];
      if (consumers.length === 0) {
        // No subscriber is a valid state, not a failure: the event is delivered.
        await deps.outbox.markDelivered(record.id);
        continue;
      }
      let allTerminal = true;
      let earliestNext = Number.POSITIVE_INFINITY;
      for (const consumer of consumers) {
        const result = await deliverOne(record, consumer, report);
        if (!result.terminal) {
          allTerminal = false;
          earliestNext = Math.min(earliestNext, result.nextAttemptAt);
        }
      }
      if (allTerminal) await deps.outbox.markDelivered(record.id);
      else await deps.outbox.markFailed(record.id, 'awaiting consumer retry', earliestNext);
    }

    return { claimed: records.length, ...report };
  };

  const drainAll = async (maxRounds = 20): Promise<DrainReport> => {
    const total = { claimed: 0, delivered: 0, retried: 0, deadLettered: 0, skipped: 0 };
    for (let round = 0; round < maxRounds; round += 1) {
      const report = await drain();
      total.claimed += report.claimed;
      total.delivered += report.delivered;
      total.retried += report.retried;
      total.deadLettered += report.deadLettered;
      total.skipped += report.skipped;
      if (report.claimed === 0) break;
      if (report.delivered === 0 && report.deadLettered === 0 && report.skipped === 0) break;
    }
    return total;
  };

  return {
    subscribe,
    drain,
    drainAll,
    consumersFor: (eventName: string) => (byEvent.get(eventName) ?? []).map((c) => c.name).sort(),
  };
};
