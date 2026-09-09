import type { Clock } from '../../runtime/clock.ts';
import type { IdFactory } from '../../runtime/ids.ts';
import type { EngineError } from '../../runtime/errors.ts';
import type {
  IdempotencyRecord,
  IdempotencyStore,
  ReserveOutcome,
} from '../../runtime/idempotency.ts';
import type {
  NewDomainEvent,
  Outbox,
  OutboxRecord,
} from '../../runtime/outbox.ts';
import type {
  DeadLetterFailure,
  DeadLetterRecord,
  DeadLetterStore,
} from '../../runtime/deadletter.ts';
import { isHeldJob } from '../../runtime/jobs.ts';
import type {
  JobHistory,
  JobHistoryEntry,
  WorkerRecord,
  WorkerRegistry,
} from '../../runtime/jobs.ts';
import type { DeliveryLedger, DeliveryRecord } from '../../runtime/orchestrator.ts';

export const createMemoryIdempotencyStore = (clock: Clock): IdempotencyStore => {
  const records = new Map<string, IdempotencyRecord>();
  return {
    reserve: async (key, actorId, commandName): Promise<ReserveOutcome> => {
      const existing = records.get(key);
      if (existing) {
        return existing.state === 'completed'
          ? { status: 'replayed', record: existing }
          : { status: 'in_flight', record: existing };
      }
      records.set(key, { key, actorId, commandName, state: 'reserved', createdAt: clock.now() });
      return { status: 'reserved' };
    },
    complete: async (key, response) => {
      const existing = records.get(key);
      if (!existing) return;
      records.set(key, { ...existing, state: 'completed', response });
    },
    fail: async (key, error: EngineError) => {
      const existing = records.get(key);
      if (!existing) return;
      records.set(key, { ...existing, state: 'completed', error });
    },
    release: async (key) => {
      records.delete(key);
    },
    get: async (key) => records.get(key),
  };
};

export const createMemoryOutbox = (clock: Clock, ids: IdFactory): Outbox => {
  const records: OutboxRecord[] = [];
  const sequences = new Map<string, number>();
  const keyOf = (aggregateType: string, aggregateId: string): string => `${aggregateType}:${aggregateId}`;

  return {
    append: async (events: readonly NewDomainEvent[], correlationId: string) => {
      const appended: OutboxRecord[] = [];
      const now = clock.now();
      for (const event of events) {
        const key = keyOf(event.aggregateType, event.aggregateId);
        const sequence = (sequences.get(key) ?? 0) + 1;
        sequences.set(key, sequence);
        const record: OutboxRecord = {
          id: ids.next('evt'),
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          sequence,
          eventName: event.eventName,
          payload: event.payload,
          correlationId,
          ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
          occurredAt: now,
          state: 'queued',
          attemptCount: 0,
          nextAttemptAt: now,
        };
        records.push(record);
        appended.push(record);
      }
      return appended;
    },

    /**
     * Ordered claim: at most one pending event per aggregate, always the lowest
     * pending sequence. An aggregate whose head event is backing off blocks its
     * own later events — that is what "ordered per aggregate" requires.
     */
    claimDue: async (limit: number) => {
      const now = clock.now();
      const heads = new Map<string, OutboxRecord>();
      for (const record of records) {
        if (record.state === 'ready' || record.state === 'dead_letter') continue;
        const key = keyOf(record.aggregateType, record.aggregateId);
        const current = heads.get(key);
        if (!current || record.sequence < current.sequence) heads.set(key, record);
      }
      return [...heads.values()]
        .filter((record) => record.nextAttemptAt <= now)
        .sort((a, b) => a.occurredAt - b.occurredAt || a.sequence - b.sequence)
        .slice(0, limit);
    },

    markDelivered: async (id) => {
      const index = records.findIndex((r) => r.id === id);
      if (index < 0) return;
      const record = records[index];
      if (!record) return;
      records[index] = { ...record, state: 'ready', deliveredAt: clock.now() };
    },
    markFailed: async (id, error, nextAttemptAt) => {
      const index = records.findIndex((r) => r.id === id);
      if (index < 0) return;
      const record = records[index];
      if (!record) return;
      // Delivery is sticky: a late failure report from a contending worker must
      // not make an already-delivered event look pending again.
      if (record.state === 'ready') return;
      records[index] = {
        ...record,
        state: 'failed',
        attemptCount: record.attemptCount + 1,
        nextAttemptAt,
        lastError: error,
      };
    },
    markDeadLettered: async (id, error) => {
      const index = records.findIndex((r) => r.id === id);
      if (index < 0) return;
      const record = records[index];
      if (!record) return;
      records[index] = { ...record, state: 'dead_letter', lastError: error };
    },
    all: async () => [...records],
    pendingCount: async () =>
      records.filter((r) => r.state !== 'ready' && r.state !== 'dead_letter').length,
  };
};

export const createMemoryDeadLetterStore = (clock: Clock, ids: IdFactory): DeadLetterStore => {
  const records = new Map<string, DeadLetterRecord>();
  return {
    record: async (entry) => {
      const record: DeadLetterRecord = {
        ...entry,
        id: ids.next('dlq'),
        createdAt: clock.now(),
        replayCount: 0,
      };
      records.set(record.id, record);
      return record;
    },
    list: async () => [...records.values()].sort((a, b) => a.createdAt - b.createdAt),
    get: async (id) => records.get(id),
    markReplayed: async (id) => {
      const existing = records.get(id);
      if (!existing) return;
      records.set(id, { ...existing, replayCount: existing.replayCount + 1 });
    },
    appendFailure: async (id, failure: DeadLetterFailure) => {
      const existing = records.get(id);
      if (!existing) return;
      records.set(id, { ...existing, failureHistory: [...existing.failureHistory, failure] });
    },
  };
};

export const createMemoryDeliveryLedger = (): DeliveryLedger => {
  const records = new Map<string, DeliveryRecord>();
  const keyOf = (outboxId: string, consumer: string): string => `${outboxId}::${consumer}`;

  return {
    get: async (outboxId, consumer) => records.get(keyOf(outboxId, consumer)),
    put: async (record) => {
      records.set(keyOf(record.outboxId, record.consumer), record);
    },
    forOutbox: async (outboxId) =>
      [...records.values()].filter((record) => record.outboxId === outboxId),
    all: async () => [...records.values()],

    claim: async (outboxId, consumer, workerId, leasedUntil, now) => {
      const key = keyOf(outboxId, consumer);
      const existing = records.get(key);

      // A live lease held by another worker blocks the claim. This is the
      // single-writer guarantee the whole distributed model rests on.
      if (
        existing &&
        isHeldJob(existing.state) &&
        existing.leaseOwner !== undefined &&
        existing.leaseOwner !== workerId &&
        (existing.leasedUntil ?? 0) > now
      ) {
        return undefined;
      }
      if (existing && (existing.state === 'completed' || existing.state === 'dead_letter')) return undefined;

      const claimed: DeliveryRecord = {
        outboxId,
        consumer,
        state: 'leased',
        attemptCount: (existing?.attemptCount ?? 0) + 1,
        nextAttemptAt: existing?.nextAttemptAt ?? now,
        ...(existing?.lastError === undefined ? {} : { lastError: existing.lastError }),
        ...(existing?.checkpoint === undefined ? {} : { checkpoint: existing.checkpoint }),
        leaseOwner: workerId,
        leasedUntil,
      };
      records.set(key, claimed);
      return claimed;
    },

    reclaimExpired: async (now) => {
      const reclaimed: DeliveryRecord[] = [];
      for (const [key, record] of records) {
        if (!isHeldJob(record.state)) continue;
        if ((record.leasedUntil ?? 0) > now) continue;
        // The holder is gone or stalled; return the job to the queue with its
        // attempt count and checkpoint intact so progress is not lost.
        const requeued: DeliveryRecord = {
          outboxId: record.outboxId,
          consumer: record.consumer,
          state: 'queued',
          attemptCount: record.attemptCount,
          nextAttemptAt: now,
          ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
          ...(record.checkpoint === undefined ? {} : { checkpoint: record.checkpoint }),
        };
        records.set(key, requeued);
        reclaimed.push(requeued);
      }
      return reclaimed;
    },

    countHeldBy: async (workerId) =>
      [...records.values()].filter((record) => isHeldJob(record.state) && record.leaseOwner === workerId).length,
  };
};

export const createMemoryWorkerRegistry = (): WorkerRegistry => {
  const workers = new Map<string, WorkerRecord>();
  return {
    register: async ({ id, hostname, now }) => {
      const existing = workers.get(id);
      workers.set(id, {
        id,
        hostname,
        // A restarted worker keeps its identity but gets a new start time, which
        // is how an operator tells a restart from a long-running process.
        startedAt: now,
        lastHeartbeatAt: now,
        state: 'alive',
        ...(existing === undefined ? {} : {}),
      });
    },
    heartbeat: async (workerId, now) => {
      const existing = workers.get(workerId);
      if (!existing) return;
      workers.set(workerId, { ...existing, lastHeartbeatAt: now, state: existing.state === 'dead' ? 'alive' : existing.state });
    },
    reapStale: async (olderThan) => {
      const reaped: string[] = [];
      for (const [id, worker] of workers) {
        if (worker.state === 'dead') continue;
        if (worker.lastHeartbeatAt >= olderThan) continue;
        workers.set(id, { ...worker, state: 'dead' });
        reaped.push(id);
      }
      return reaped;
    },
    drain: async (workerId) => {
      const existing = workers.get(workerId);
      if (existing) workers.set(workerId, { ...existing, state: 'draining' });
    },
    get: async (workerId) => workers.get(workerId),
    list: async () => [...workers.values()],
  };
};

export const createMemoryJobHistory = (): JobHistory => {
  const entries: JobHistoryEntry[] = [];
  return {
    append: async (entry) => {
      entries.push(entry);
    },
    forDelivery: async (deliveryId) => entries.filter((entry) => entry.deliveryId === deliveryId),
  };
};
