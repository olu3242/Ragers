import type { Db } from './client.ts';
import type { Clock } from '../../runtime/clock.ts';
import type { IdFactory } from '../../runtime/ids.ts';
import type { EngineError } from '../../runtime/errors.ts';
import type { IdempotencyRecord, IdempotencyStore, ReserveOutcome } from '../../runtime/idempotency.ts';
import type { NewDomainEvent, Outbox, OutboxRecord } from '../../runtime/outbox.ts';
import type { DeadLetterFailure, DeadLetterRecord, DeadLetterStore } from '../../runtime/deadletter.ts';
import type { DeliveryLedger, DeliveryRecord } from '../../runtime/orchestrator.ts';
import type { JobHistory, JobHistoryEntry, JobState, WorkerRecord, WorkerRegistry } from '../../runtime/jobs.ts';
import type { WorkState } from '../../runtime/work.ts';

/**
 * Durable runtime stores.
 *
 * These are what make Phase 21 real: the outbox, the delivery ledger and its
 * leases live in Postgres, so a restarted process rediscovers exactly the work
 * that was in flight rather than starting from an empty map.
 */

const ms = (value: unknown): number =>
  value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : Number(value ?? 0);

const iso = (value: number): string => new Date(value).toISOString();

// ── Idempotency ───────────────────────────────────────────────────────────
interface IdempotencyRow {
  key: string;
  actor_id: string;
  command_name: string;
  state: 'reserved' | 'completed';
  response: unknown;
  error: EngineError | null;
  created_at: Date;
}

const toIdempotency = (row: IdempotencyRow): IdempotencyRecord => ({
  key: row.key,
  actorId: row.actor_id,
  commandName: row.command_name,
  state: row.state,
  ...(row.response === null ? {} : { response: row.response }),
  ...(row.error === null ? {} : { error: row.error }),
  createdAt: ms(row.created_at),
});

export const createPostgresIdempotencyStore = (db: Db): IdempotencyStore => ({
  reserve: async (key, actorId, commandName): Promise<ReserveOutcome> => {
    // One statement decides the race: the insert either wins or tells us who did.
    const inserted = await db.query<IdempotencyRow>(
      `insert into idempotency_keys (key, actor_id, command_name, state)
       values ($1, $2, $3, 'reserved')
       on conflict (key) do nothing
       returning *`,
      [key, actorId, commandName],
    );
    if (inserted.length > 0) return { status: 'reserved' };

    const existing = await db.query<IdempotencyRow>(`select * from idempotency_keys where key = $1`, [key]);
    const row = existing[0];
    if (!row) return { status: 'reserved' };
    return row.state === 'completed'
      ? { status: 'replayed', record: toIdempotency(row) }
      : { status: 'in_flight', record: toIdempotency(row) };
  },

  complete: async (key, response) => {
    await db.query(
      `update idempotency_keys set state = 'completed', response = $2::jsonb where key = $1`,
      [key, JSON.stringify(response ?? null)],
    );
  },

  fail: async (key, error) => {
    await db.query(`update idempotency_keys set state = 'completed', error = $2::jsonb where key = $1`, [
      key,
      JSON.stringify(error),
    ]);
  },

  release: async (key) => {
    await db.query(`delete from idempotency_keys where key = $1`, [key]);
  },

  get: async (key) => {
    const rows = await db.query<IdempotencyRow>(`select * from idempotency_keys where key = $1`, [key]);
    const row = rows[0];
    return row ? toIdempotency(row) : undefined;
  },
});

// ── Outbox ────────────────────────────────────────────────────────────────
interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  sequence: string | number;
  event_name: string;
  payload: Record<string, unknown>;
  correlation_id: string;
  causation_id: string | null;
  state: WorkState;
  attempt_count: number;
  next_attempt_at: Date;
  last_error: string | null;
  occurred_at: Date;
  delivered_at: Date | null;
}

const toOutbox = (row: OutboxRow): OutboxRecord => ({
  id: row.id,
  aggregateType: row.aggregate_type,
  aggregateId: row.aggregate_id,
  sequence: Number(row.sequence),
  eventName: row.event_name,
  payload: row.payload,
  correlationId: row.correlation_id,
  ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
  state: row.state,
  attemptCount: row.attempt_count,
  nextAttemptAt: ms(row.next_attempt_at),
  ...(row.last_error === null ? {} : { lastError: row.last_error }),
  occurredAt: ms(row.occurred_at),
  ...(row.delivered_at === null ? {} : { deliveredAt: ms(row.delivered_at) }),
});

export const createPostgresOutbox = (db: Db, clock: Clock, ids: IdFactory): Outbox => ({
  append: async (events: readonly NewDomainEvent[], correlationId: string) => {
    const appended: OutboxRecord[] = [];
    for (const event of events) {
      // The sequence is allocated from the existing rows, so it stays monotonic
      // per aggregate even under concurrent appends (the unique index is the
      // backstop that turns a race into a retryable conflict).
      const rows = await db.query<OutboxRow>(
        // next_attempt_at is written from the injected clock, never left to the
        // database default: the engine owns time, and mixing the two makes
        // nothing ever look due under a controlled clock.
        `insert into outbox (id, aggregate_type, aggregate_id, sequence, event_name, payload, correlation_id, causation_id, occurred_at, next_attempt_at)
         values (
           $1, $2, $3,
           coalesce((select max(sequence) from outbox where aggregate_type = $2 and aggregate_id = $3), 0) + 1,
           $4, $5::jsonb, $6, $7, $8, $8
         )
         returning *`,
        [
          ids.next('evt'),
          event.aggregateType,
          event.aggregateId,
          event.eventName,
          JSON.stringify(event.payload),
          correlationId,
          event.causationId ?? null,
          iso(clock.now()),
        ],
      );
      const row = rows[0];
      if (row) appended.push(toOutbox(row));
    }
    return appended;
  },

  /**
   * Ordered claim: the earliest pending event per aggregate, and only that one.
   * An aggregate whose head event is backing off therefore holds its own later
   * events — which is what "ordered per aggregate" requires.
   */
  claimDue: async (limit: number) => {
    const rows = await db.query<OutboxRow>(
      `select o.* from outbox o
       where o.state not in ('ready','dead_letter')
         and o.next_attempt_at <= $1
         and o.sequence = (
           select min(i.sequence) from outbox i
           where i.aggregate_type = o.aggregate_type
             and i.aggregate_id = o.aggregate_id
             and i.state not in ('ready','dead_letter')
         )
       order by o.occurred_at, o.sequence
       limit $2`,
      [iso(clock.now()), limit],
    );
    return rows.map(toOutbox);
  },

  markDelivered: async (id) => {
    await db.query(`update outbox set state = 'ready', delivered_at = $2 where id = $1`, [id, iso(clock.now())]);
  },
  markFailed: async (id, error, nextAttemptAt) => {
    await db.query(
      `update outbox set state = 'failed', attempt_count = attempt_count + 1, next_attempt_at = $3, last_error = $2
       where id = $1 and state <> 'ready'`,
      [id, error, iso(nextAttemptAt)],
    );
  },
  markDeadLettered: async (id, error) => {
    await db.query(`update outbox set state = 'dead_letter', last_error = $2 where id = $1`, [id, error]);
  },
  all: async () => (await db.query<OutboxRow>(`select * from outbox order by occurred_at, sequence`)).map(toOutbox),
  pendingCount: async () => {
    const rows = await db.query<{ count: string }>(
      `select count(*)::text as count from outbox where state not in ('ready','dead_letter')`,
    );
    return Number(rows[0]?.count ?? 0);
  },
});

// ── Dead letters ──────────────────────────────────────────────────────────
interface DeadLetterRow {
  id: string;
  source: string;
  event_name: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  correlation_id: string;
  failure_history: DeadLetterFailure[];
  replay_count: number;
  created_at: Date;
}

const toDeadLetter = (row: DeadLetterRow): DeadLetterRecord => ({
  id: row.id,
  source: row.source,
  eventName: row.event_name,
  aggregateType: row.aggregate_type,
  aggregateId: row.aggregate_id,
  payload: row.payload,
  correlationId: row.correlation_id,
  failureHistory: row.failure_history,
  replayCount: row.replay_count,
  createdAt: ms(row.created_at),
});

export const createPostgresDeadLetterStore = (db: Db, clock: Clock, ids: IdFactory): DeadLetterStore => ({
  record: async (entry) => {
    const rows = await db.query<DeadLetterRow>(
      `insert into dead_letters (id, source, event_name, aggregate_type, aggregate_id, payload, correlation_id, failure_history, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9)
       returning *`,
      [
        ids.next('dlq'),
        entry.source,
        entry.eventName,
        entry.aggregateType,
        entry.aggregateId,
        JSON.stringify(entry.payload),
        entry.correlationId,
        JSON.stringify(entry.failureHistory),
        iso(clock.now()),
      ],
    );
    return toDeadLetter(rows[0] as DeadLetterRow);
  },
  list: async () =>
    (await db.query<DeadLetterRow>(`select * from dead_letters order by created_at`)).map(toDeadLetter),
  get: async (id) => {
    const rows = await db.query<DeadLetterRow>(`select * from dead_letters where id = $1`, [id]);
    const row = rows[0];
    return row ? toDeadLetter(row) : undefined;
  },
  markReplayed: async (id) => {
    await db.query(`update dead_letters set replay_count = replay_count + 1 where id = $1`, [id]);
  },
  appendFailure: async (id, failure) => {
    await db.query(
      `update dead_letters set failure_history = failure_history || $2::jsonb where id = $1`,
      [id, JSON.stringify([failure])],
    );
  },
});

// ── Delivery ledger with leases ───────────────────────────────────────────
interface DeliveryRow {
  id: string;
  outbox_id: string;
  consumer: string;
  state: JobState;
  attempt_count: number;
  next_attempt_at: Date;
  last_error: string | null;
  lease_owner: string | null;
  leased_until: Date | null;
  checkpoint: Record<string, unknown>;
}

const toDelivery = (row: DeliveryRow): DeliveryRecord => ({
  outboxId: row.outbox_id,
  consumer: row.consumer,
  state: row.state,
  attemptCount: row.attempt_count,
  nextAttemptAt: ms(row.next_attempt_at),
  ...(row.last_error === null ? {} : { lastError: row.last_error }),
  ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
  ...(row.leased_until === null ? {} : { leasedUntil: ms(row.leased_until) }),
  ...(Object.keys(row.checkpoint ?? {}).length === 0 ? {} : { checkpoint: row.checkpoint }),
});

export const createPostgresDeliveryLedger = (db: Db, ids: IdFactory): DeliveryLedger => ({
  get: async (outboxId, consumer) => {
    const rows = await db.query<DeliveryRow>(
      `select * from event_deliveries where outbox_id = $1 and consumer = $2`,
      [outboxId, consumer],
    );
    const row = rows[0];
    return row ? toDelivery(row) : undefined;
  },

  put: async (record) => {
    await db.query(
      `insert into event_deliveries
         (id, outbox_id, consumer, state, attempt_count, next_attempt_at, last_error, lease_owner, leased_until, checkpoint)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       on conflict (outbox_id, consumer) do update set
         state = excluded.state,
         attempt_count = excluded.attempt_count,
         next_attempt_at = excluded.next_attempt_at,
         last_error = excluded.last_error,
         lease_owner = excluded.lease_owner,
         leased_until = excluded.leased_until,
         checkpoint = excluded.checkpoint`,
      [
        ids.next('del'),
        record.outboxId,
        record.consumer,
        record.state,
        record.attemptCount,
        iso(record.nextAttemptAt),
        record.lastError ?? null,
        record.leaseOwner ?? null,
        record.leasedUntil === undefined ? null : iso(record.leasedUntil),
        JSON.stringify(record.checkpoint ?? {}),
      ],
    );
  },

  /**
   * The atomic claim, and the single-writer guarantee of the whole model.
   *
   * One statement inserts the job or takes it over, but only when nobody holds a
   * live lease and the job is not already terminal. If the `where` on the
   * conflict path rejects, no row comes back and the caller learns it lost.
   */
  claim: async (outboxId, consumer, workerId, leasedUntil, now) => {
    const rows = await db.query<DeliveryRow>(
      `insert into event_deliveries
         (id, outbox_id, consumer, state, attempt_count, next_attempt_at, lease_owner, leased_until)
       values ($1, $2, $3, 'leased', 1, $6, $4, $5)
       on conflict (outbox_id, consumer) do update set
         state = 'leased',
         lease_owner = excluded.lease_owner,
         leased_until = excluded.leased_until,
         attempt_count = event_deliveries.attempt_count + 1
       where event_deliveries.state not in ('completed','dead_letter')
         and (
           event_deliveries.state not in ('leased','running')
           or event_deliveries.leased_until <= $6
           or event_deliveries.lease_owner = excluded.lease_owner
         )
       returning *`,
      [ids.next('del'), outboxId, consumer, workerId, iso(leasedUntil), iso(now)],
    );
    const row = rows[0];
    return row ? toDelivery(row) : undefined;
  },

  reclaimExpired: async (now) => {
    const rows = await db.query<DeliveryRow>(
      `update event_deliveries set state = 'queued', lease_owner = null, leased_until = null
       where state in ('leased','running') and leased_until <= $1
       returning *`,
      [iso(now)],
    );
    return rows.map(toDelivery);
  },

  countHeldBy: async (workerId) => {
    const rows = await db.query<{ count: string }>(
      `select count(*)::text as count from event_deliveries
       where state in ('leased','running') and lease_owner = $1`,
      [workerId],
    );
    return Number(rows[0]?.count ?? 0);
  },

  forOutbox: async (outboxId) =>
    (await db.query<DeliveryRow>(`select * from event_deliveries where outbox_id = $1`, [outboxId])).map(toDelivery),
  all: async () => (await db.query<DeliveryRow>(`select * from event_deliveries`)).map(toDelivery),
});

// ── Workers ───────────────────────────────────────────────────────────────
interface WorkerRow {
  id: string;
  hostname: string;
  started_at: Date;
  last_heartbeat_at: Date;
  state: 'alive' | 'draining' | 'dead';
}

const toWorker = (row: WorkerRow): WorkerRecord => ({
  id: row.id,
  hostname: row.hostname,
  startedAt: ms(row.started_at),
  lastHeartbeatAt: ms(row.last_heartbeat_at),
  state: row.state,
});

export const createPostgresWorkerRegistry = (db: Db): WorkerRegistry => ({
  register: async ({ id, hostname, now }) => {
    await db.query(
      `insert into workers (id, hostname, started_at, last_heartbeat_at, state)
       values ($1, $2, $3, $3, 'alive')
       on conflict (id) do update set
         hostname = excluded.hostname,
         started_at = excluded.started_at,
         last_heartbeat_at = excluded.last_heartbeat_at,
         state = 'alive'`,
      [id, hostname, iso(now)],
    );
  },
  heartbeat: async (workerId, now) => {
    await db.query(
      `update workers set last_heartbeat_at = $2, state = case when state = 'dead' then 'alive' else state end
       where id = $1`,
      [workerId, iso(now)],
    );
  },
  reapStale: async (olderThan) => {
    const rows = await db.query<{ id: string }>(
      `update workers set state = 'dead'
       where state <> 'dead' and last_heartbeat_at < $1
       returning id`,
      [iso(olderThan)],
    );
    return rows.map((row) => row.id);
  },
  drain: async (workerId) => {
    await db.query(`update workers set state = 'draining' where id = $1`, [workerId]);
  },
  get: async (workerId) => {
    const rows = await db.query<WorkerRow>(`select * from workers where id = $1`, [workerId]);
    const row = rows[0];
    return row ? toWorker(row) : undefined;
  },
  list: async () => (await db.query<WorkerRow>(`select * from workers order by started_at`)).map(toWorker),
});

// ── Job history ───────────────────────────────────────────────────────────
export const createPostgresJobHistory = (db: Db, ids: IdFactory): JobHistory => ({
  append: async (entry: JobHistoryEntry) => {
    await db.query(
      `insert into job_history (id, delivery_id, attempt, state, worker_id, detail, at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        ids.next('jh'),
        entry.deliveryId,
        entry.attempt,
        entry.state,
        entry.workerId ?? null,
        entry.detail ?? null,
        iso(entry.at),
      ],
    );
  },
  forDelivery: async (deliveryId) => {
    const rows = await db.query<{
      delivery_id: string;
      attempt: number;
      state: JobState;
      worker_id: string | null;
      detail: string | null;
      at: Date;
    }>(`select * from job_history where delivery_id = $1 order by at, attempt`, [deliveryId]);
    return rows.map((row) => ({
      deliveryId: row.delivery_id,
      attempt: row.attempt,
      state: row.state,
      ...(row.worker_id === null ? {} : { workerId: row.worker_id }),
      ...(row.detail === null ? {} : { detail: row.detail }),
      at: ms(row.at),
    }));
  },
});
