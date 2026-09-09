import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import {
  createPostgresHarness,
  liveDatabaseAvailable,
  liveDatabaseUrl,
  type PostgresHarness,
} from '../support/postgres-harness.ts';

/**
 * Backup and restore drill — the gate docs/OPERATIONS.md §6 documents.
 *
 * The drill restores into a scratch database and asserts the properties that
 * make a restore trustworthy: source-of-truth rows survive, undelivered events
 * survive, derived projections can be rebuilt, and RLS is still enabled
 * afterwards. A restore that silently loses RLS is a privacy incident, so it is
 * checked explicitly rather than assumed.
 */
const PG_BIN = process.env['RAGERS_PG_BIN'] ?? '/usr/lib/postgresql/16/bin';

const pg = (tool: string, args: readonly string[]): string =>
  execFileSync(join(PG_BIN, tool), args as string[], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('backup and restore drill', { skip: liveDatabaseAvailable() ? false : 'no live database configured' }, () => {
  let h: PostgresHarness;
  let workDir: string;
  let restoredName: string;
  let restoredUrl: string;

  before(async () => {
    h = await createPostgresHarness('backup');
    workDir = mkdtempSync(join(tmpdir(), 'ragers-backup-'));
    restoredName = `${h.databaseName}_restored`;
    restoredUrl = h.connectionString.replace(h.databaseName, restoredName);

    // Seed source-of-truth rows, an undelivered outbox event, and a projection.
    await h.query(
      `insert into actors (id, email, display_name) values ('actor_b', 'b@example.com', 'Backup Actor')`,
    );
    await h.query(
      `insert into experiences (id, actor_id, kind, creation_mode, category, body_text, status, visibility, correlation_id, published_at)
       values ('exp_b', 'actor_b', 'rave', 'text', 'Other', 'Worth keeping.', 'published', 'public', 'corr_b', now())`,
    );
    await h.query(
      `insert into audit_events (id, actor_id, action, resource_type, resource_id, correlation_id)
       values ('audit_b', 'actor_b', 'experience.publish', 'experience', 'exp_b', 'corr_b')`,
    );
    await h.query(
      `insert into outbox (id, aggregate_type, aggregate_id, sequence, event_name, payload, correlation_id)
       values ('evt_b', 'experience', 'exp_b', 1, 'ExperiencePublished', '{"experienceId":"exp_b"}'::jsonb, 'corr_b')`,
    );
    await h.query(
      `insert into feed_entries (experience_id, kind, creation_mode, category, excerpt, identity_label, identity_kind, published_at)
       values ('exp_b', 'rave', 'text', 'Other', 'Worth keeping.', 'Backup Actor', 'public', now())`,
    );
  });

  after(async () => {
    const base = liveDatabaseUrl();
    if (base) {
      const admin = new Client({ connectionString: base });
      await admin.connect();
      try {
        await admin.query(`drop database if exists ${restoredName} with (force)`);
      } finally {
        await admin.end();
      }
    }
    await h?.destroy();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  test('a custom-format dump can be taken and restored into a scratch database', async () => {
    const dumpPath = join(workDir, 'ragers.dump');
    pg('pg_dump', ['--format=custom', '--file', dumpPath, h.connectionString]);

    const base = liveDatabaseUrl() as string;
    const admin = new Client({ connectionString: base });
    await admin.connect();
    try {
      await admin.query(`create database ${restoredName}`);
    } finally {
      await admin.end();
    }

    // pg_restore reports harmless notices on stderr; a non-zero exit is the failure signal.
    pg('pg_restore', ['--dbname', restoredUrl, '--no-owner', dumpPath]);

    const restored = new Client({ connectionString: restoredUrl });
    await restored.connect();
    try {
      const counts = await restored.query<{ relation: string; count: string }>(`
        select 'actors' as relation, count(*)::text as count from actors
        union all select 'experiences', count(*)::text from experiences
        union all select 'audit_events', count(*)::text from audit_events
      `);
      const byRelation = Object.fromEntries(counts.rows.map((row) => [row.relation, row.count]));
      assert.equal(byRelation['actors'], '1', 'accounts survive the restore');
      assert.equal(byRelation['experiences'], '1', 'content survives the restore');
      assert.equal(byRelation['audit_events'], '1', 'the audit trail survives the restore');
    } finally {
      await restored.end();
    }
  });

  test('undelivered events survive the restore, so nothing in flight is lost', async () => {
    const restored = new Client({ connectionString: restoredUrl });
    await restored.connect();
    try {
      const pending = await restored.query<{ count: string }>(
        `select count(*)::text as count from outbox where state not in ('ready','dead_letter')`,
      );
      assert.equal(pending.rows[0]?.count, '1', 'the undelivered event is still queued after restore');

      const payload = await restored.query<{ payload: Record<string, unknown> }>(
        `select payload from outbox where id = 'evt_b'`,
      );
      assert.deepEqual(payload.rows[0]?.payload, { experienceId: 'exp_b' }, 'and its payload is intact');
    } finally {
      await restored.end();
    }
  });

  test('RLS is still enabled on every table after the restore', async () => {
    const restored = new Client({ connectionString: restoredUrl });
    await restored.connect();
    try {
      const unprotected = await restored.query<{ relname: string }>(`
        select relname from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
      `);
      assert.deepEqual(
        unprotected.rows.map((row) => row.relname),
        [],
        'a restore that loses RLS is a privacy incident, not a configuration detail',
      );

      const policies = await restored.query<{ count: string }>(
        `select count(*)::text as count from pg_policies where schemaname = 'public'`,
      );
      assert.equal(policies.rows[0]?.count, '46', 'every policy is restored');
    } finally {
      await restored.end();
    }
  });

  test('the withheld columns are still withheld after the restore', async () => {
    const restored = new Client({ connectionString: restoredUrl });
    await restored.connect();
    try {
      // Filtered to SELECT deliberately: an author legitimately holds INSERT and
      // UPDATE on media_assets, so the question is only whether they can *read*
      // the original.
      const granted = await restored.query<{ column_name: string; grantee: string }>(`
        select column_name, grantee from information_schema.column_privileges
        where grantee in ('anon','authenticated')
          and column_name in ('original_key','raw_text')
          and privilege_type = 'SELECT'
      `);
      assert.deepEqual(granted.rows, [], 'original_key and raw_text remain unreadable after restore');

      // And the readable columns did survive, so the restore is faithful rather
      // than merely restrictive.
      const readable = await restored.query<{ count: string }>(`
        select count(*)::text as count from information_schema.column_privileges
        where grantee = 'anon' and table_name = 'media_assets' and privilege_type = 'SELECT'
      `);
      assert.ok(Number(readable.rows[0]?.count ?? 0) > 5, 'the protected columns are still granted');
    } finally {
      await restored.end();
    }
  });

  test('derived projections are rebuildable, so they need not be trusted from the backup', async () => {
    const restored = new Client({ connectionString: restoredUrl });
    await restored.connect();
    try {
      // Discard the projection, as a rebuild would, then confirm the source facts
      // are sufficient to reconstruct it.
      await restored.query(`delete from feed_entries`);
      const source = await restored.query<{ id: string; kind: string; body_text: string }>(
        `select id, kind, body_text from experiences where status = 'published'`,
      );
      assert.equal(source.rows.length, 1, 'the source fact survives independently of the projection');

      await restored.query(
        `insert into feed_entries (experience_id, kind, creation_mode, category, excerpt, identity_label, identity_kind, published_at)
         select id, kind, creation_mode, category, body_text, 'Backup Actor', visibility, published_at
         from experiences where status = 'published'`,
      );
      const rebuilt = await restored.query<{ count: string }>(`select count(*)::text as count from feed_entries`);
      assert.equal(rebuilt.rows[0]?.count, '1', 'the projection rebuilds from source facts alone');
    } finally {
      await restored.end();
    }
  });

  test('the migration runner treats an edited applied migration as drift', async () => {
    const restored = new Client({ connectionString: restoredUrl });
    await restored.connect();
    try {
      await restored.query(`
        create table if not exists schema_migrations (
          filename text primary key, checksum text not null, applied_at timestamptz not null default now()
        )
      `);
      await restored.query(`insert into schema_migrations (filename, checksum) values ('0001_engine_core.sql', 'deadbeefdeadbeef')`);

      // The runner must refuse rather than silently reapply or ignore.
      const result = (() => {
        try {
          execFileSync(process.execPath, ['scripts/migrate.ts'], {
            encoding: 'utf8',
            env: { ...process.env, DATABASE_URL: restoredUrl },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          return { failed: false, output: '' };
        } catch (cause) {
          const error = cause as { status?: number; stderr?: string };
          return { failed: (error.status ?? 0) !== 0, output: error.stderr ?? '' };
        }
      })();

      assert.equal(result.failed, true, 'the runner must exit non-zero on schema drift');
      assert.match(result.output, /schema drift/, 'and say so explicitly');
    } finally {
      await restored.end();
    }
  });
});
