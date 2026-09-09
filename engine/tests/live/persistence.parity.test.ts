import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPostgresHarness,
  liveDatabaseAvailable,
  type PostgresHarness,
} from '../support/postgres-harness.ts';
import { createMemoryStore } from '../../src/adapters/memory/store.ts';
import { eq, type EngineStore } from '../../src/ports/store.ts';
import type { Experience } from '../../src/domain/experience.ts';

/**
 * Adapter parity. The same assertions run against the in-memory adapter and the
 * live Postgres adapter, so "the ports are interchangeable" is demonstrated
 * rather than asserted in a comment.
 */
describe('persistence parity', { skip: liveDatabaseAvailable() ? false : 'no live database configured' }, () => {
  let harness: PostgresHarness;

  before(async () => {
    harness = await createPostgresHarness('parity');
  });

  after(async () => {
    await harness?.destroy();
  });

  const actor = (id: string) => ({
    id,
    email: `${id}@example.com`,
    authProvider: 'password',
    displayName: 'Parity Actor',
    defaultVisibility: 'public' as const,
    role: 'member' as const,
    status: 'active' as const,
    createdAt: 1_700_000_000_000,
    lastActiveAt: 1_700_000_000_000,
  });

  const experience = (id: string, actorId: string, overrides: Partial<Experience> = {}): Experience => ({
    id,
    actorId,
    kind: 'rage',
    creationMode: 'text',
    category: 'Other',
    bodyText: 'A parity observation.',
    status: 'published',
    visibility: 'public',
    correlationId: 'corr_parity',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    publishedAt: 1_700_000_100_000,
    version: 4,
    ...overrides,
  });

  /** Run one body against both adapters and compare the outcomes. */
  const bothAdapters = async (
    body: (store: EngineStore) => Promise<unknown>,
  ): Promise<{ memory: unknown; postgres: unknown }> => ({
    memory: await body(createMemoryStore()),
    postgres: await body(harness.store),
  });

  test('a round-tripped row keeps every field, including timestamps and version', async () => {
    const results = await bothAdapters(async (store) => {
      await store.actors.put(actor('actor_rt'));
      await store.experiences.put(experience('exp_rt', 'actor_rt'));
      return store.experiences.get('exp_rt');
    });

    for (const [adapter, value] of Object.entries(results)) {
      const row = value as Experience | undefined;
      assert.ok(row, `${adapter} returned no row`);
      assert.equal(row?.id, 'exp_rt', adapter);
      assert.equal(row?.actorId, 'actor_rt', adapter);
      assert.equal(row?.kind, 'rage', adapter);
      assert.equal(row?.creationMode, 'text', adapter);
      assert.equal(row?.bodyText, 'A parity observation.', adapter);
      assert.equal(row?.status, 'published', adapter);
      assert.equal(row?.version, 4, adapter);
      assert.equal(row?.createdAt, 1_700_000_000_000, `${adapter} timestamp round-trip`);
      assert.equal(row?.publishedAt, 1_700_000_100_000, `${adapter} nullable timestamp round-trip`);
    }
  });

  test('an absent optional field round-trips as absent, not null', async () => {
    const results = await bothAdapters(async (store) => {
      await store.actors.put(actor('actor_opt'));
      await store.experiences.put(experience('exp_opt', 'actor_opt'));
      const row = await store.experiences.get('exp_opt');
      return { hasAlias: row !== undefined && 'aliasId' in row, deletedAt: row?.deletedAt };
    });

    assert.deepEqual(results.memory, results.postgres, 'both adapters agree on absent fields');
    assert.deepEqual(results.postgres, { hasAlias: false, deletedAt: undefined });
  });

  test('put is an upsert, so consumers can re-apply safely', async () => {
    const results = await bothAdapters(async (store) => {
      await store.actors.put(actor('actor_up'));
      await store.experiences.put(experience('exp_up', 'actor_up'));
      await store.experiences.put(experience('exp_up', 'actor_up', { bodyText: 'Edited.', version: 5 }));
      const rows = await store.experiences.query([eq('actorId', 'actor_up')]);
      return { count: rows.length, bodyText: rows[0]?.bodyText, version: rows[0]?.version };
    });

    assert.deepEqual(results.memory, results.postgres);
    assert.deepEqual(results.postgres, { count: 1, bodyText: 'Edited.', version: 5 });
  });

  test('declarative criteria produce identical results on both adapters', async () => {
    const results = await bothAdapters(async (store) => {
      await store.actors.put(actor('actor_q'));
      await store.experiences.put(experience('exp_q1', 'actor_q', { kind: 'rage', status: 'published' }));
      await store.experiences.put(experience('exp_q2', 'actor_q', { kind: 'rave', status: 'published' }));
      await store.experiences.put(experience('exp_q3', 'actor_q', { kind: 'rave', status: 'removed' }));

      const mine = eq<Experience>('actorId', 'actor_q');
      const published = await store.experiences.query([mine, eq('status', 'published')]);
      const raves = await store.experiences.query([mine, eq('kind', 'rave')]);
      const publishedRaves = await store.experiences.query([mine, eq('kind', 'rave'), eq('status', 'published')]);
      const notRemoved = await store.experiences.query([mine, { field: 'status', op: 'ne', value: 'removed' }]);
      const byVersion = await store.experiences.query([mine, { field: 'version', op: 'gte', value: 4 }]);
      const inKinds = await store.experiences.query([mine, { field: 'kind', op: 'in', value: ['rage', 'rave'] }]);
      const withDeleted = await store.experiences.query([mine, { field: 'deletedAt', op: 'notNull' }]);

      return {
        published: published.length,
        raves: raves.length,
        publishedRaves: publishedRaves.length,
        notRemoved: notRemoved.length,
        byVersion: byVersion.length,
        inKinds: inKinds.length,
        withDeleted: withDeleted.length,
        count: await store.experiences.countWhere([mine, eq('kind', 'rave')]),
        one: (await store.experiences.queryOne([mine, eq('kind', 'rage')]))?.id,
      };
    });

    assert.deepEqual(results.memory, results.postgres, 'criteria semantics must match exactly');
    assert.deepEqual(results.postgres, {
      published: 2,
      raves: 2,
      publishedRaves: 1,
      notRemoved: 2,
      byVersion: 3,
      inKinds: 3,
      withDeleted: 0,
      count: 2,
      one: 'exp_q1',
    });
  });

  test('ordering and limits match on both adapters', async () => {
    const results = await bothAdapters(async (store) => {
      await store.actors.put(actor('actor_o'));
      for (const [index, id] of ['exp_o1', 'exp_o2', 'exp_o3'].entries()) {
        await store.experiences.put(
          experience(id, 'actor_o', { publishedAt: 1_700_000_000_000 + index * 1_000 }),
        );
      }
      const newest = await store.experiences.query([eq('actorId', 'actor_o')], {
        orderBy: { field: 'publishedAt', direction: 'desc' },
        limit: 2,
      });
      return newest.map((row) => row.id);
    });

    assert.deepEqual(results.memory, results.postgres);
    assert.deepEqual(results.postgres, ['exp_o3', 'exp_o2']);
  });

  test('remove deletes exactly one row', async () => {
    const results = await bothAdapters(async (store) => {
      await store.actors.put(actor('actor_d'));
      await store.experiences.put(experience('exp_d1', 'actor_d'));
      await store.experiences.put(experience('exp_d2', 'actor_d'));
      await store.experiences.remove('exp_d1');
      return {
        gone: (await store.experiences.get('exp_d1')) === undefined,
        remaining: (await store.experiences.query([eq('actorId', 'actor_d')])).length,
      };
    });

    assert.deepEqual(results.memory, results.postgres);
    assert.deepEqual(results.postgres, { gone: true, remaining: 1 });
  });

  test('a projection keyed by its aggregate derives its id on read', async () => {
    // feed_entries has no surrogate key: the domain id is the experience id.
    const results = await bothAdapters(async (store) => {
      await store.actors.put(actor('actor_p'));
      await store.experiences.put(experience('exp_p', 'actor_p'));
      await store.feedEntries.put({
        id: 'exp_p',
        experienceId: 'exp_p',
        kind: 'rage',
        creationMode: 'text',
        category: 'Other',
        excerpt: 'An excerpt.',
        identityLabel: 'Parity Actor',
        identityKind: 'public',
        hasVoice: false,
        publishedAt: 1_700_000_100_000,
        rankScore: 1.5,
        suppressed: false,
      });
      const row = await store.feedEntries.get('exp_p');
      return { id: row?.id, experienceId: row?.experienceId, rankScore: row?.rankScore };
    });

    assert.deepEqual(results.memory, results.postgres, 'derived ids must match the in-memory shape');
    assert.deepEqual(results.postgres, { id: 'exp_p', experienceId: 'exp_p', rankScore: 1.5 });
  });

  test('jsonb and array columns round-trip', async () => {
    const results = await bothAdapters(async (store) => {
      await store.actors.put(actor('actor_j'));
      await store.experiences.put(experience('exp_j', 'actor_j'));
      await store.searchDocuments.put({
        id: 'exp_j',
        experienceId: 'exp_j',
        kind: 'rage',
        category: 'Other',
        searchableText: 'redacted text only',
        subjectTerms: ['crosswalk', 'queue'],
        identityLabel: 'Anonymous',
        hasVoice: true,
        publishedAt: 1_700_000_100_000,
      });
      await store.auditEvents.put({
        id: 'audit_j',
        actorId: 'actor_j',
        action: 'test.action',
        resourceType: 'experience',
        resourceId: 'exp_j',
        before: { status: 'published' },
        after: { status: 'removed' },
        correlationId: 'corr_j',
        createdAt: 1_700_000_200_000,
      });
      const document = await store.searchDocuments.get('exp_j');
      const audit = await store.auditEvents.get('audit_j');
      return { terms: document?.subjectTerms, before: audit?.before, after: audit?.after };
    });

    assert.deepEqual(results.memory, results.postgres, 'jsonb and text[] must round-trip identically');
    assert.deepEqual(results.postgres, {
      terms: ['crosswalk', 'queue'],
      before: { status: 'published' },
      after: { status: 'removed' },
    });
  });

  const corroboration = (id: string, experienceId: string, corroboratorId: string, overrides: Record<string, unknown> = {}) => ({
    id,
    experienceId,
    corroboratorId,
    type: 're_rage' as const,
    relationship: 'same_experience' as const,
    visibility: 'public' as const,
    status: 'active' as const,
    retractedAt: undefined,
    correlationId: 'corr_cas',
    createdAt: 1_700_000_000_000,
    ...overrides,
  });

  test('compareAndSet admits exactly one of many simultaneous writers', async () => {
    const results = await bothAdapters(async (store) => {
      await store.actors.put(actor('actor_cas'));
      await store.actors.put(actor('actor_cas2'));
      await store.experiences.put(experience('exp_cas', 'actor_cas'));
      const row = corroboration('exp_cas:actor_cas2', 'exp_cas', 'actor_cas2');

      const attempts = await Promise.all(
        Array.from({ length: 8 }, () => store.corroborations.compareAndSet(row, 'absent')),
      );
      return {
        won: attempts.filter(Boolean).length,
        rows: await store.corroborations.countWhere([eq('experienceId', 'exp_cas')]),
      };
    });

    assert.deepEqual(results.memory, results.postgres, 'both adapters must arbitrate a race identically');
    assert.deepEqual(results.postgres, { won: 1, rows: 1 });
  });

  test('compareAndSet with a precondition writes only while the stored row still matches', async () => {
    const results = await bothAdapters(async (store) => {
      await store.actors.put(actor('actor_pre'));
      await store.actors.put(actor('actor_pre2'));
      await store.experiences.put(experience('exp_pre', 'actor_pre'));
      const id = 'exp_pre:actor_pre2';
      await store.corroborations.put(
        corroboration(id, 'exp_pre', 'actor_pre2', { status: 'retracted', retractedAt: 1_700_000_050_000 }),
      );

      // The precondition holds, so the re-claim lands — and clears the retraction.
      const reclaimed = await store.corroborations.compareAndSet(
        corroboration(id, 'exp_pre', 'actor_pre2'),
        [eq('status', 'retracted')],
      );
      const after = await store.corroborations.get(id);
      // The precondition no longer holds, so a second attempt is refused.
      const again = await store.corroborations.compareAndSet(
        corroboration(id, 'exp_pre', 'actor_pre2'),
        [eq('status', 'retracted')],
      );
      // A precondition on a row that does not exist is a refusal, not an insert.
      const absent = await store.corroborations.compareAndSet(
        corroboration('exp_pre:nobody', 'exp_pre', 'actor_pre2'),
        [eq('status', 'retracted')],
      );

      return {
        reclaimed,
        again,
        absent,
        status: after?.status,
        retractedAt: after?.retractedAt,
        rows: await store.corroborations.countWhere([eq('experienceId', 'exp_pre')]),
      };
    });

    assert.deepEqual(results.memory, results.postgres, 'preconditions must mean the same thing on both adapters');
    assert.deepEqual(results.postgres, {
      reclaimed: true,
      again: false,
      absent: false,
      status: 'active',
      // The optional column is cleared, not left holding a stale date.
      retractedAt: undefined,
      rows: 1,
    });
  });

  test('a database constraint rejects what the domain also rejects', async () => {
    // Text mode requires a body — enforced in the domain and in the schema.
    await harness.store.actors.put(actor('actor_c'));
    await assert.rejects(
      () => harness.store.experiences.put(experience('exp_c', 'actor_c', { bodyText: '' })),
      /text_mode_requires_body/,
      'the schema check constraint must fire',
    );
  });

  test('a transaction rolls back every write on failure', async () => {
    await harness.store.actors.put(actor('actor_tx'));

    const outcome = await harness.db.transaction(async (tx) => {
      await tx.query(
        `insert into experiences (id, actor_id, kind, creation_mode, category, body_text, status, visibility, correlation_id)
         values ('exp_tx', 'actor_tx', 'rage', 'text', 'Other', 'Committed?', 'draft', 'public', 'corr_tx')`,
      );
      return { ok: false as const, error: { kind: 'internal' as const, code: 'deliberate', message: 'fail', retryable: false } };
    });

    assert.equal(outcome.ok, false);
    assert.equal(
      await harness.store.experiences.get('exp_tx'),
      undefined,
      'a rolled-back transaction must leave nothing behind',
    );
  });
});
