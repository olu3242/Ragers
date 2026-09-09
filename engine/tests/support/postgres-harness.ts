import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { Client } from 'pg';
import { createDb, type Db } from '../../src/adapters/postgres/client.ts';
import { createPostgresStore } from '../../src/adapters/postgres/store.ts';
import type { EngineStore } from '../../src/ports/store.ts';

/**
 * Live-database harness.
 *
 * Each caller gets its own database so tests cannot see each other's rows, and
 * the real migrations are applied — never a hand-written test schema, because
 * then the test would not be evidence about the shipped migrations.
 *
 * When no database is configured the harness reports unavailable and the live
 * suites skip rather than pass silently.
 */
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'supabase', 'migrations');

export const liveDatabaseUrl = (): string | undefined =>
  process.env['RAGERS_TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];

export const liveDatabaseAvailable = (): boolean => liveDatabaseUrl() !== undefined;

export interface PostgresHarness {
  readonly db: Db;
  readonly store: EngineStore;
  readonly databaseName: string;
  readonly connectionString: string;
  query<R extends Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<readonly R[]>;
  destroy(): Promise<void>;
}

const migrationSql = (): readonly string[] =>
  readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(join(migrationsDir, name), 'utf8'));

export const createPostgresHarness = async (label: string): Promise<PostgresHarness> => {
  const baseUrl = liveDatabaseUrl();
  if (!baseUrl) throw new Error('no live database configured');

  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const databaseName = `ragers_t_${label.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12)}_${suffix}`;

  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    // Client roles must exist for the grants in 0002 to apply.
    await admin.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
    end $$;`);
    await admin.query(`create database ${databaseName}`);
  } finally {
    await admin.end();
  }

  const connectionString = baseUrl.replace(/\/[^/?]*(\?|$)/, `/${databaseName}$1`);

  const setup = new Client({ connectionString });
  await setup.connect();
  try {
    for (const sql of migrationSql()) await setup.query(sql);
    // No grants here on purpose: 0002_rls_policies.sql now installs the full
    // privilege surface itself, so this harness exercises exactly what a
    // deployment gets — and what a pg_restore reproduces.
  } finally {
    await setup.end();
  }

  const db = createDb({ connectionString, max: 4 });

  return {
    db,
    store: createPostgresStore(db),
    databaseName,
    connectionString,
    query: async <R extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
      db.query<R>(sql, params),
    destroy: async () => {
      await db.close();
      const cleanup = new Client({ connectionString: baseUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`drop database if exists ${databaseName} with (force)`);
      } finally {
        await cleanup.end();
      }
    },
  };
};

/** psql-based helpers for the backup/restore drill. */
export const pgTool = (tool: string, args: readonly string[]): string =>
  execFileSync(`/usr/lib/postgresql/16/bin/${tool}`, args as string[], { encoding: 'utf8' });
