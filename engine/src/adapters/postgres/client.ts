import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { err, ok, type Result } from '../../runtime/result.ts';
import { conflictError, transientError, type EngineError } from '../../runtime/errors.ts';

/**
 * Postgres access. One pool per process, with an explicit transaction helper so
 * a state change and its outbox rows commit together — the transactional outbox
 * is not optional.
 */
export interface Db {
  query<R extends QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<readonly R[]>;
  /** Run `work` inside a transaction, rolling back on any failure. */
  transaction<T>(work: (tx: Db) => Promise<Result<T, EngineError>>): Promise<Result<T, EngineError>>;
  /** Set a session/local variable — used to present an actor to RLS. */
  close(): Promise<void>;
}

/** Postgres error codes that are worth retrying rather than failing outright. */
const RETRYABLE_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '08006', // connection_failure
  '08003', // connection_does_not_exist
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
]);

const UNIQUE_VIOLATION = '23505';

export const toEngineError = (cause: unknown): EngineError => {
  const code = (cause as { code?: string } | undefined)?.code;
  const message = cause instanceof Error ? cause.message : String(cause);
  if (code === UNIQUE_VIOLATION) return conflictError('unique_violation', message, { code });
  if (code && RETRYABLE_CODES.has(code)) return transientError('database_unavailable', message, { code });
  return {
    kind: 'internal',
    code: 'database_error',
    message,
    retryable: false,
    ...(code === undefined ? {} : { details: { code } }),
  };
};

const wrap = (run: (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>): Db['query'] =>
  async <R extends QueryResultRow>(sql: string, params: readonly unknown[] = []) => {
    const result = await run(sql, params);
    return result.rows as R[];
  };

export interface PostgresOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly statementTimeoutMs?: number;
  /**
   * Called when an *idle* pooled connection fails.
   *
   * Optional, and swallowing it is the correct default — see the note in
   * `createDb`. Supply it to log; never to rethrow.
   */
  readonly onIdleError?: (cause: unknown) => void;
}

/**
 * The transaction a piece of work is currently inside, if any.
 *
 * The alternative is threading a transaction-scoped store through every command
 * handler, which would put the burden of remembering on each of them — and one
 * handler that forgets is a state change that commits without its event. An
 * ambient scope means a handler cannot forget: whatever `Db` it holds routes to
 * the current transaction's client while one is open, and to the pool otherwise.
 */
const ambient = new AsyncLocalStorage<Db>();

/** True while the caller is inside `db.transaction`. */
export const inTransaction = (): boolean => ambient.getStore() !== undefined;

export const createDb = (options: PostgresOptions): Db => {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    // A query that runs forever is an outage, not a slow query.
    statement_timeout: options.statementTimeoutMs ?? 15_000,
  });

  /**
   * An idle connection failing is not this process's problem to crash over.
   *
   * `pg` emits `'error'` on the pool when a connection that is sitting idle dies —
   * a Postgres restart, a failover, an administrator running `pg_terminate_backend`.
   * With no listener, Node turns that into an **uncaught exception and the process
   * exits**, which converts a recoverable blip into an outage. The pool already
   * discards the broken client and hands the next caller a fresh one, so the
   * correct handling is to not die: the next query either succeeds or fails on its
   * own terms, where the retry policy can see it.
   *
   * Found because it kept killing a live test run: dropping a temporary database
   * terminated a backend, and the resulting idle-client error surfaced as an
   * uncaught exception attributed to whichever test was unlucky. The test was the
   * symptom; a process that exits when the database restarts was the defect.
   */
  pool.on('error', (cause) => {
    options.onIdleError?.(cause);
  });

  const fromClient = (client: PoolClient): Db => ({
    query: wrap((sql, params) => client.query(sql, params as unknown[])),
    // Nested transactions reuse the outer one: a handler does not get to
    // commit half of an aggregate.
    transaction: async (work) => work(fromClient(client)),
    close: async () => {},
  });

  return {
    // Routed through the ambient scope, so a store built once at construction
    // still participates in whatever transaction is open around the call.
    query: async <R extends QueryResultRow>(sql: string, params: readonly unknown[] = []) => {
      const current = ambient.getStore();
      if (current) return current.query<R>(sql, params);
      return wrap((s2, p2) => pool.query(s2, p2 as unknown[]))<R>(sql, params);
    },

    transaction: async <T>(work: (tx: Db) => Promise<Result<T, EngineError>>) => {
      // Already inside one: reuse it rather than opening a second connection and
      // deadlocking against the rows the outer transaction already holds.
      const current = ambient.getStore();
      if (current) return current.transaction(work);

      const client = await pool.connect();
      try {
        await client.query('begin');
        const scoped = fromClient(client);
        const outcome = await ambient.run(scoped, () => work(scoped));
        if (!outcome.ok) {
          await client.query('rollback');
          return outcome;
        }
        await client.query('commit');
        return outcome;
      } catch (cause) {
        await client.query('rollback').catch(() => undefined);
        return err(toEngineError(cause));
      } finally {
        client.release();
      }
    },

    close: async () => {
      await pool.end();
    },
  };
};

/**
 * Run work as a specific actor, so RLS applies exactly as it would for that
 * actor in production. `set local` is transaction-scoped, so the elevation
 * cannot leak to another request on the same pooled connection.
 */
export const asActor = async <T>(
  db: Db,
  actor: { actorId?: string; role: 'anon' | 'authenticated' | 'service_role' },
  work: (tx: Db) => Promise<Result<T, EngineError>>,
): Promise<Result<T, EngineError>> =>
  db.transaction(async (tx) => {
    await tx.query(`set local role ${actor.role}`);
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [actor.actorId ?? '']);
    return work(tx);
  });

export const okVoid = (): Result<void, EngineError> => ok(undefined);
