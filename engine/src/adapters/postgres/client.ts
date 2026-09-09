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
}

export const createDb = (options: PostgresOptions): Db => {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    // A query that runs forever is an outage, not a slow query.
    statement_timeout: options.statementTimeoutMs ?? 15_000,
  });

  const fromClient = (client: PoolClient): Db => ({
    query: wrap((sql, params) => client.query(sql, params as unknown[])),
    // Nested transactions reuse the outer one: a handler does not get to
    // commit half of an aggregate.
    transaction: async (work) => work(fromClient(client)),
    close: async () => {},
  });

  return {
    query: wrap((sql, params) => pool.query(sql, params as unknown[])),

    transaction: async <T>(work: (tx: Db) => Promise<Result<T, EngineError>>) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const outcome = await work(fromClient(client));
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
