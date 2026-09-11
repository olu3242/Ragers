import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { Client } from 'pg';

/**
 * Migration runner.
 *
 * Applies pending migrations in filename order inside a transaction each, and
 * records a checksum so an already-applied file that has since been edited is a
 * hard error rather than a silent drift.
 */
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'supabase', 'migrations');

const connectionString = process.env['DATABASE_URL'] ?? process.env['RAGERS_TEST_DATABASE_URL'];
if (!connectionString) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(2);
}

const checksum = (contents: string): string => createHash('sha256').update(contents).digest('hex').slice(0, 16);

const client = new Client({ connectionString });
await client.connect();

try {
  await client.query(`
    create table if not exists schema_migrations (
      filename   text primary key,
      checksum   text not null,
      applied_at timestamptz not null default now()
    )
  `);

  // The migration ledger is operator state, not application data: it gets the
  // same treatment as the other worker-owned tables. RLS on with no policies and
  // no client grants means only the service role can see or change it — and it
  // keeps the "every table has RLS" invariant true of the whole schema.
  await client.query('alter table schema_migrations enable row level security');
  await client.query('revoke all on schema_migrations from public');
  for (const role of ['anon', 'authenticated']) {
    await client.query(
      `do $$ begin
         if exists (select 1 from pg_roles where rolname = '${role}') then
           execute 'revoke all on schema_migrations from ${role}';
         end if;
       end $$;`,
    );
  }

  const applied = new Map<string, string>(
    (await client.query<{ filename: string; checksum: string }>('select filename, checksum from schema_migrations'))
      .rows.map((row) => [row.filename, row.checksum]),
  );

  const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  let pending = 0;

  for (const filename of files) {
    const contents = readFileSync(join(migrationsDir, filename), 'utf8');
    const digest = checksum(contents);
    const previous = applied.get(filename);

    if (previous !== undefined) {
      if (previous !== digest) {
        // Editing an applied migration means the database and the repo disagree.
        process.stderr.write(
          `schema drift: ${filename} was applied with checksum ${previous} but is now ${digest}\n`,
        );
        process.exit(1);
      }
      continue;
    }

    process.stdout.write(`applying ${filename}…\n`);
    try {
      await client.query('begin');
      await client.query(contents);
      await client.query('insert into schema_migrations (filename, checksum) values ($1, $2)', [filename, digest]);
      await client.query('commit');
      pending += 1;
    } catch (cause) {
      await client.query('rollback').catch(() => undefined);
      process.stderr.write(`failed applying ${filename}: ${cause instanceof Error ? cause.message : cause}\n`);
      process.exit(1);
    }
  }

  process.stdout.write(pending === 0 ? 'schema up to date\n' : `applied ${pending} migration(s)\n`);
} finally {
  await client.end();
}
