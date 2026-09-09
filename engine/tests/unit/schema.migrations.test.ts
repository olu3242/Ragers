import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BODY_MAX_LENGTH, REACTION_TYPES, REJECTED_REACTION_TYPES, VOICE_MAX_BYTES, VOICE_MAX_DURATION_MS, VOICE_MIN_DURATION_MS } from '../../src/domain/types.ts';
import { isJsonColumn, isNumericColumn, isTimestampColumn } from '../../src/adapters/postgres/table.ts';
import { createMemoryStore } from '../../src/adapters/memory/store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', '..', 'supabase', 'migrations');
const core = readFileSync(join(migrations, '0001_engine_core.sql'), 'utf8');
const rls = readFileSync(join(migrations, '0002_rls_policies.sql'), 'utf8');
/** Tables and policies now span several migrations, so relation checks read them all. */
const allMigrations = readdirSync(migrations)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(join(migrations, name), 'utf8'))
  .join('\n');

const tableNames = (sql: string): readonly string[] =>
  [...sql.matchAll(/^create table (\w+) \(/gm)].map((m) => m[1] as string);

/** Strip `--` comments so assertions test the schema, not the prose around it. */
const stripComments = (sql: string): string =>
  sql
    .split('\n')
    .map((line) => {
      const at = line.indexOf('--');
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');

const tableBody = (sql: string, table: string): string => {
  const start = sql.indexOf(`create table ${table} (`);
  assert.notEqual(start, -1, `table ${table} must exist`);
  const end = sql.indexOf('\n);', start);
  return stripComments(sql.slice(start, end));
};

const viewBody = (sql: string, view: string): string => {
  const start = sql.indexOf(`create view ${view}`);
  assert.notEqual(start, -1, `view ${view} must exist`);
  const end = sql.indexOf(';', start);
  return stripComments(sql.slice(start, end));
};

test('every table has row level security enabled', () => {
  const missing = tableNames(allMigrations).filter(
    (table) =>
      !new RegExp(`alter table ${table}\\s+enable row level security`).test(allMigrations),
  );
  assert.deepEqual(missing, [], `tables without RLS: ${missing.join(', ')}`);
});

test('the feed projection has no actor identifier column', () => {
  const body = tableBody(core, 'feed_entries');
  assert.equal(/\bactor_id\b/.test(body), false, 'feed_entries must not have an actor_id column');
  assert.equal(/\balias_id\b/.test(body), false, 'feed_entries must not have an alias_id column');
});

test('the search projection has no actor identifier and no raw transcript column', () => {
  const body = tableBody(core, 'search_documents');
  assert.equal(/\bactor_id\b/.test(body), false, 'search_documents must not have an actor_id column');
  assert.equal(/\braw_text\b/.test(body), false, 'search_documents must not hold raw transcript text');
  assert.ok(/searchable_text/.test(body), 'search_documents holds redacted searchable text');
});

test('analytics rows are pseudonymous and hold no actor foreign key', () => {
  const body = tableBody(core, 'analytics_events');
  assert.ok(/actor_hash/.test(body), 'analytics stores a hash');
  assert.equal(/actor_id/.test(body), false, 'analytics must not store an actor_id');
  assert.equal(/references actors/.test(body), false, 'analytics must not reference actors');
});

test('original media keys and raw transcripts are excluded from the public views', () => {
  const media = viewBody(rls, 'media_assets_public');
  assert.equal(media.includes('original_key'), false, 'the public media view must not expose original_key');
  assert.ok(media.includes('protected_key'), 'the public media view serves the protected derivative');

  const transcripts = viewBody(rls, 'transcripts_public');
  assert.equal(transcripts.includes('raw_text'), false, 'the public transcript view must not expose raw_text');
  assert.ok(transcripts.includes('redacted_text'));
});

test('the public reputation view excludes internal signals', () => {
  const view = viewBody(rls, 'actor_reputation_public');
  assert.equal(view.includes('internal_signals'), false, 'internal signals must not be publicly readable');
  assert.ok(view.includes('approval_rate'), 'the public approval rate is exposed');
});

test('column grants withhold original_key and raw_text from client roles', () => {
  const grants = stripComments(rls.slice(rls.indexOf('Column grants')));
  const mediaGrant = grants.slice(grants.indexOf('on media_assets to'));
  assert.equal(/grant select \([^)]*original_key/.test(grants), false, 'original_key is never granted');
  assert.equal(/grant select \([^)]*raw_text/.test(grants), false, 'raw_text is never granted');
  assert.ok(mediaGrant.length > 0);
  assert.ok(grants.includes('revoke all on ranking_inputs'), 'ranking components stay internal');
  assert.ok(grants.includes('revoke all on analytics_events'), 'analytics stays internal');
});

test('the audit trail is append-only: no update or delete policy exists', () => {
  assert.ok(rls.includes('create policy audit_insert on audit_events for insert'));
  assert.equal(/on audit_events for update/.test(rls), false, 'audit rows must not be updatable');
  assert.equal(/on audit_events for delete/.test(rls), false, 'audit rows must not be deletable');
});

test('experiences cannot be hard-deleted, so deletion always propagates', () => {
  assert.ok(rls.includes('experiences_no_hard_delete on experiences for delete using (false)'));
});

test('the reaction enum is Ragers-native and excludes generic social mechanics', () => {
  const enumLine = core.split('\n').find((line) => line.startsWith('create type reaction_type'));
  assert.ok(enumLine, 'reaction_type enum must exist');
  for (const reaction of REACTION_TYPES) {
    assert.ok(enumLine.includes(`'${reaction}'`), `${reaction} must be in the enum`);
  }
  for (const rejected of REJECTED_REACTION_TYPES) {
    assert.equal(enumLine.includes(`'${rejected}'`), false, `${rejected} must not be in the enum`);
  }
});

test('uniqueness constraints make engagement and notification fan-out idempotent', () => {
  assert.ok(tableBody(core, 'reactions').includes('unique (experience_id, actor_id, reaction_type)'));
  assert.ok(
    tableBody(core, 'fair_votes').includes('unique (experience_id, actor_id)'),
    'one fair vote per actor per experience — a recast updates rather than duplicates',
  );
  assert.ok(
    tableBody(core, 'notifications').includes('unique (recipient_actor_id, dedupe_key)'),
    'notification fan-out must be idempotent under at-least-once delivery',
  );
  assert.ok(core.includes('unique (aggregate_type, aggregate_id, sequence)'), 'outbox sequences are unique per aggregate');
  assert.ok(tableBody(core, 'event_deliveries').includes('unique (outbox_id, consumer)'));
});

test('database constraints agree with the domain limits', () => {
  const experiences = tableBody(core, 'experiences');
  assert.ok(experiences.includes(`char_length(body_text) <= ${BODY_MAX_LENGTH}`), 'body limit must match the domain');
  assert.ok(experiences.includes('text_mode_requires_body'), 'text mode requires a body in the database too');
  assert.ok(experiences.includes('alias_matches_visibility'), 'alias/visibility coupling is enforced in the database');

  const media = tableBody(core, 'media_assets');
  assert.ok(media.includes(`duration_ms between ${VOICE_MIN_DURATION_MS} and ${VOICE_MAX_DURATION_MS}`));
  assert.ok(media.includes(`byte_size <= ${VOICE_MAX_BYTES}`));
  assert.ok(media.includes('protected_requires_key'), 'a protected asset must have a protected key');
});

test('media protection status gates the public media view', () => {
  assert.ok(viewBody(rls, 'media_assets_public').includes("protection_status = 'protected'"));
});

test('the social graph forbids self-edges', () => {
  assert.ok(tableBody(core, 'graph_edges').includes('no_self_edge'));
});

test('every port table has a corresponding relation in the migration', () => {
  const store = createMemoryStore();
  const snakeCase = (name: string): string => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  // Port name -> SQL relation, where the two deliberately differ.
  const overrides: Readonly<Record<string, string>> = {
    counters: 'experience_counters',
    queueItems: 'moderation_queue',
    graphEdges: 'graph_edges',
    reputation: 'actor_reputation',
    notificationPreferences: 'notification_preferences',
    // Experience Signal Engine relations whose SQL name is prefixed.
    corroborations: 'experience_corroborations',
    shares: 'experience_shares',
    clusters: 'experience_clusters',
    clusterMembers: 'experience_cluster_members',
    disputes: 'experience_disputes',
    relations: 'experience_relations',
    responsiveness: 'responsiveness_snapshots',
    proposals: 'intelligence_proposals',
    // Phases 31–35, prefixed for the same reason: they are all about an experience.
    enrichments: 'experience_enrichments',
    severities: 'experience_severities',
    escalations: 'experience_escalations',
  };
  const relations = new Set(tableNames(allMigrations));
  const missing: string[] = [];
  for (const portName of Object.keys(store)) {
    const relation = overrides[portName] ?? snakeCase(portName);
    if (!relations.has(relation)) missing.push(`${portName} -> ${relation}`);
  }
  assert.deepEqual(missing, [], `ports without a table: ${missing.join(', ')}`);
});

test('the adapter recognises every timestamp column the migrations declare', () => {
  // The Postgres adapter converts timestamps by naming convention rather than
  // from a hand-maintained list, because that list was edited once per new
  // column and the first omission wrote epoch milliseconds into a timestamptz.
  // The convention only holds while the schema keeps to it, so assert that here.
  const declared = [...stripComments(allMigrations).matchAll(/^\s+([a-z_]+)\s+timestamptz/gm)].map(
    (match) => match[1] ?? '',
  );
  assert.ok(declared.length > 50, 'the migrations should declare many timestamp columns');
  const unrecognised = [...new Set(declared)].filter((column) => !isTimestampColumn(column));
  assert.deepEqual(
    unrecognised,
    [],
    `timestamptz columns the adapter would not convert: ${unrecognised.join(', ')}`,
  );
});

test('no non-timestamp column is named as though it were one', () => {
  // The converse: a column named `<x>_at` that is not a timestamptz would be
  // converted anyway, and silently corrupted.
  const mistyped = [...stripComments(allMigrations).matchAll(/^\s+([a-z_]+_at)\s+([a-z]+)/gm)]
    .filter((match) => match[2] !== 'timestamptz')
    .map((match) => `${match[1]} ${match[2]}`);
  assert.deepEqual(mistyped, [], `columns named _at but not timestamptz: ${mistyped.join(', ')}`);
});

test('the adapter recognises every jsonb column the migrations declare', () => {
  // node-postgres serializes an object to JSON but an *array* to a Postgres array
  // literal. A jsonb column holding an array of objects therefore fails outright,
  // and — worse — an empty array silently persists as `{}`, a JSON object. A column
  // missing from the adapter's set is a write that fails in production.
  const declared = [...stripComments(allMigrations).matchAll(/^\s+([a-z_]+)\s+jsonb\b/gm)].map(
    (match) => match[1] ?? '',
  );
  assert.ok(declared.length > 5, 'the migrations should declare several jsonb columns');
  const unrecognised = [...new Set(declared)].filter((column) => !isJsonColumn(column));
  assert.deepEqual(
    unrecognised,
    [],
    `jsonb columns the adapter would not serialize: ${unrecognised.join(', ')}`,
  );
});

test('no non-jsonb column is serialized as though it were jsonb', () => {
  // The converse, and the one that would corrupt quietly: a text[] column in the
  // JSON set would be written as a JSON string and read back as one.
  const arrays = [...stripComments(allMigrations).matchAll(/^\s+([a-z_]+)\s+text\[\]/gm)].map(
    (match) => match[1] ?? '',
  );
  const mistyped = [...new Set(arrays)].filter((column) => isJsonColumn(column));
  assert.deepEqual(mistyped, [], `text[] columns treated as jsonb: ${mistyped.join(', ')}`);
});

test('the adapter recognises every numeric column the migrations declare', () => {
  // pg returns numeric and bigint as strings. A column missing from the adapter's
  // set reads back as a string, and arithmetic on it concatenates instead of
  // adding — which is how "1" + 1 becomes a corroboration count of 11.
  const declared = [
    ...stripComments(allMigrations).matchAll(/^\s+([a-z_]+)\s+(?:numeric|bigint)\b/gm),
  ].map((match) => match[1] ?? '');
  assert.ok(declared.length > 10, 'the migrations should declare several numeric columns');
  const unrecognised = [...new Set(declared)].filter((column) => !isNumericColumn(column));
  assert.deepEqual(
    unrecognised,
    [],
    `numeric columns the adapter would return as strings: ${unrecognised.join(', ')}`,
  );
});
