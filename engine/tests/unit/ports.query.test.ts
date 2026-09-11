import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStore } from '../../src/adapters/memory/store.ts';
import { eq, matchesCriteria, matchesCriterion } from '../../src/ports/store.ts';

/**
 * Guard: engines must filter declaratively.
 *
 * A JavaScript predicate cannot be compiled to SQL, so the Postgres adapter has
 * to materialise the table to evaluate one — bounded by a scan limit that would
 * silently truncate results. This test fails if an engine reintroduces that.
 */
const here = dirname(fileURLToPath(import.meta.url));
const enginesDir = join(here, '..', '..', 'src', 'engines');

test('no engine module filters with a JavaScript predicate', () => {
  const offenders: string[] = [];
  for (const file of readdirSync(enginesDir).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(join(enginesDir, file), 'utf8');
    for (const [index, line] of source.split('\n').entries()) {
      // Precise about the receiver on purpose. `findOne` and `count` exist only
      // on the port, so a call to either is always the predicate form; `find`
      // also exists on Array, so it is flagged only when the receiver is a store
      // table — otherwise ordinary array work reads as a full-table scan and the
      // guard trains people to route around it.
      if (/\bstore\.[A-Za-z]+\.find\(/.test(line)) offenders.push(`${file}:${index + 1}`);
      // `count()` with no argument compiles to `select count(*)`, so it is only
      // the predicate form when something is actually passed.
      else if (/\.findOne\(/.test(line) || /\.count\(\s*[^)\s]/.test(line)) {
        offenders.push(`${file}:${index + 1}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these call sites must use query/queryOne/countWhere so they can be pushed down to SQL: ${offenders.join(', ')}`,
  );
});

test('the predicate form still exists for tests, so the guard is about engines only', async () => {
  const store = createMemoryStore();
  await store.actors.put({
    id: 'actor_1',
    email: 'a@example.com',
    authProvider: 'password',
    displayName: 'A',
    defaultVisibility: 'public',
    role: 'member',
    status: 'active',
    createdAt: 1,
    lastActiveAt: 1,
  });
  assert.equal((await store.actors.find((row) => row.email === 'a@example.com')).length, 1);
});

test('every criterion operator behaves as documented', () => {
  const row = { id: 'x', count: 5, flag: true, off: false, name: 'crosswalk', missing: undefined };

  assert.ok(matchesCriterion(row, { field: 'count', op: 'eq', value: 5 }));
  assert.ok(matchesCriterion(row, { field: 'count', op: 'ne', value: 6 }));
  assert.ok(matchesCriterion(row, { field: 'count', op: 'gt', value: 4 }));
  assert.ok(matchesCriterion(row, { field: 'count', op: 'gte', value: 5 }));
  assert.ok(matchesCriterion(row, { field: 'count', op: 'lt', value: 6 }));
  assert.ok(matchesCriterion(row, { field: 'count', op: 'lte', value: 5 }));
  assert.ok(matchesCriterion(row, { field: 'name', op: 'in', value: ['crosswalk', 'queue'] }));
  assert.ok(matchesCriterion(row, { field: 'flag', op: 'isTrue' }));
  assert.ok(matchesCriterion(row, { field: 'off', op: 'isFalse' }));
  assert.ok(matchesCriterion(row, { field: 'missing', op: 'isNull' }));
  assert.ok(matchesCriterion(row, { field: 'name', op: 'notNull' }));

  assert.equal(matchesCriterion(row, { field: 'count', op: 'eq', value: 6 }), false);
  assert.equal(matchesCriterion(row, { field: 'flag', op: 'isFalse' }), false);
  assert.equal(matchesCriterion(row, { field: 'off', op: 'isTrue' }), false, 'false is not null');
  assert.equal(matchesCriterion(row, { field: 'off', op: 'isNull' }), false, 'false is a value');
  assert.equal(matchesCriterion(row, { field: 'name', op: 'in', value: ['other'] }), false);
});

test('criteria combine with AND semantics, and an empty criteria list matches everything', () => {
  const row = { id: 'x', kind: 'rave', status: 'published' };
  assert.ok(matchesCriteria(row, [eq('kind', 'rave'), eq('status', 'published')]));
  assert.equal(matchesCriteria(row, [eq('kind', 'rave'), eq('status', 'removed')]), false);
  assert.ok(matchesCriteria(row, []), 'no criteria is not a filter');
});

test('the memory adapter honours ordering and limits', async () => {
  const store = createMemoryStore();
  for (const [index, id] of ['a', 'b', 'c'].entries()) {
    await store.metricSnapshots.put({
      id,
      metricName: 'test',
      window: 'all',
      value: index,
      computedAt: 1_000 + index,
    });
  }
  const desc = await store.metricSnapshots.query([eq('metricName', 'test')], {
    orderBy: { field: 'computedAt', direction: 'desc' },
    limit: 2,
  });
  assert.deepEqual(desc.map((row) => row.id), ['c', 'b']);

  const asc = await store.metricSnapshots.query([], { orderBy: { field: 'computedAt', direction: 'asc' } });
  assert.deepEqual(asc.map((row) => row.id), ['a', 'b', 'c']);
});
