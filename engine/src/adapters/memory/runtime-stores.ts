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
  };
};
