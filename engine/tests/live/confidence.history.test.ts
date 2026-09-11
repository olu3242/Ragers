import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPostgresHarness,
  liveDatabaseAvailable,
  type PostgresHarness,
} from '../support/postgres-harness.ts';
import {
  clusterConfidenceFor,
  confidenceFor,
  confidenceHistoryFor,
  recordConfidencePoint,
} from '../../src/engines/confidence.engine.ts';
import { reliabilityFor, resolutionQualityFor } from '../../src/engines/quality.engine.ts';
import { fixedClock } from '../../src/runtime/clock.ts';
import { sequentialIdFactory } from '../../src/runtime/ids.ts';
import { createMemoryLogger } from '../../src/runtime/logger.ts';
import { createMetrics } from '../../src/runtime/metrics.ts';
import type { EngineDeps } from '../../src/engines/deps.ts';

/**
 * Phases 81–85 against a live database.
 *
 * Migration 0018 makes three promises the in-memory adapter cannot keep and cannot break:
 *
 *   1. `confidence_points` is **append-only**, enforced by a trigger rather than by every
 *      caller remembering. A history that can be edited is not a history.
 *   2. `(subject_id, at)` is unique, so a re-derived boundary collides. This is the property
 *      the whole replay-safety argument rests on, and it is a database constraint — asserting
 *      it in memory would assert something about a `Map`.
 *   3. `recommendation_memory`'s check constraints refuse a row whose outcome and timestamps
 *      disagree. Without them a row could say `dismissed` with no `dismissed_at`, and a series
 *      derived from the timestamps would silently skip it.
 *
 * And one thing only rows can show: that the reads compose over the Postgres adapter with the
 * same answers, since every one of them queries by a non-primary-key column.
 */
describe('phases 81–85 against a live database', { skip: !liveDatabaseAvailable() }, () => {
  let h: PostgresHarness;

  before(async () => {
    h = await createPostgresHarness('confidence');
  });
  after(async () => {
    await h?.destroy();
  });

  /** Engine dependencies over the Postgres store, without the bus or the orchestrator. */
  const depsOver = (harness: PostgresHarness): EngineDeps =>
    ({
      store: harness.store,
      clock: fixedClock(),
      ids: sequentialIdFactory(),
      logger: createMemoryLogger(),
      metrics: createMetrics(),
    }) as unknown as EngineDeps;

  // ── the append-only trigger ────────────────────────────────────────────
  test('a confidence point cannot be updated or deleted', async () => {
    await h.query(
      `insert into confidence_points (id, subject_id, subject_kind, at, band, independent_people, deciding)
       values ('cp_1', 'exp_1', 'experience', to_timestamp(1000), 'moderate', 4, 'four people')`,
    );

    await assert.rejects(
      () => h.query(`update confidence_points set band = 'strong' where id = 'cp_1'`),
      /append-only/,
      'a history that can be edited is not a history',
    );
    await assert.rejects(
      () => h.query(`delete from confidence_points where id = 'cp_1'`),
      /append-only/,
      'and it cannot be quietly removed either',
    );

    const [row] = await h.query<{ band: string }>(`select band from confidence_points where id = 'cp_1'`);
    assert.equal(row?.band, 'moderate', 'the original point stands');
  });

  test('a re-derived boundary collides rather than duplicating', async () => {
    await h.query(
      `insert into confidence_points (id, subject_id, subject_kind, at, band, independent_people, deciding)
       values ('cp_2', 'exp_2', 'experience', to_timestamp(2000), 'limited', 2, 'two people')`,
    );
    // A different id, the same (subject, boundary) — which is what a replay under a different
    // id scheme would produce. The natural key is what refuses it, not the primary key.
    await assert.rejects(
      () =>
        h.query(
          `insert into confidence_points (id, subject_id, subject_kind, at, band, independent_people, deciding)
           values ('cp_2_again', 'exp_2', 'experience', to_timestamp(2000), 'strong', 9, 'nine people')`,
        ),
      /confidence_points_one_per_boundary/,
      'one point per subject per boundary, whatever the id says',
    );
  });

  test('the band is an enum, so a made-up band cannot be stored', async () => {
    await assert.rejects(
      () =>
        h.query(
          `insert into confidence_points (id, subject_id, subject_kind, at, band, independent_people, deciding)
           values ('cp_3', 'exp_3', 'experience', to_timestamp(3000), 'verified', 9, 'nine people')`,
        ),
      /invalid input value for enum/,
      '"verified" is exactly the word Phase 76 forbids, and the type refuses it here too',
    );
  });

  test('independent_people cannot be negative, and there is no score column to store', async () => {
    await assert.rejects(
      () =>
        h.query(
          `insert into confidence_points (id, subject_id, subject_kind, at, band, independent_people, deciding)
           values ('cp_4', 'exp_4', 'experience', to_timestamp(4000), 'limited', -1, 'impossible')`,
        ),
      /independent_people/,
    );

    const columns = await h.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'confidence_points'`,
    );
    const names = columns.map((row) => row.column_name);
    assert.equal(
      names.some((name) => /score|value|weight|rating/.test(name)),
      false,
      'a number invites arithmetic over an ordinal scale — `moderate` minus `limited` is not a quantity',
    );
    assert.equal(
      names.some((name) => /actor|corroborator|author|user/.test(name)),
      false,
      'a series keyed by person would be a reputation history under another name',
    );
  });

  // ── recommendation memory's check constraints ──────────────────────────
  test('a dismissed recommendation must carry when it was dismissed', async () => {
    await h.query(
      `insert into recommendations (id, kind, subject_id, across_experience_ids,
                                    distinct_people, lifecycle_state)
       values ('rec_mem', 'organization_outreach', 'clu_1', array['exp_a', 'exp_b'], 4, 'active')`,
    );

    await assert.rejects(
      () =>
        h.query(
          `insert into recommendation_memory (recommendation_id, outcome) values ('rec_mem', 'dismissed')`,
        ),
      /memory_dismissed_has_time/,
      'otherwise a series derived from the timestamps would silently skip it',
    );

    await h.query(
      `insert into recommendation_memory (recommendation_id, outcome, dismissed_at)
       values ('rec_mem', 'dismissed', now())`,
    );
    const [stored] = await h.query<{ outcome: string }>(
      `select outcome from recommendation_memory where recommendation_id = 'rec_mem'`,
    );
    assert.equal(stored?.outcome, 'dismissed');
  });

  test('acting on a recommendation requires having accepted it first', async () => {
    await h.query(
      `insert into recommendations (id, kind, subject_id, across_experience_ids,
                                    distinct_people, lifecycle_state)
       values ('rec_act', 'organization_outreach', 'clu_2', array['exp_c', 'exp_d'], 4, 'active')`,
    );

    await assert.rejects(
      () =>
        h.query(
          `insert into recommendation_memory (recommendation_id, outcome, acted_on_at)
           values ('rec_act', 'acted_on', now())`,
        ),
      /memory_acted_has_acceptance/,
      'acted on without an acceptance is a decision nobody made',
    );
  });

  test('the memory holds no free text and no actor', async () => {
    const columns = await h.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
        where table_name = 'recommendation_memory'`,
    );
    for (const column of columns) {
      assert.equal(
        /note|reason|detail|comment|why/.test(column.column_name),
        false,
        `${column.column_name}: a dismissal reason becomes a record of one person's judgement about another's situation`,
      );
      assert.equal(
        /actor|user|operator|reviewer|dismissed_by/.test(column.column_name),
        false,
        `${column.column_name}: who dismissed it is what audit_events is for, under a rule that governs what belongs there`,
      );
    }
  });

  test('one memory row per recommendation, not one per operator', async () => {
    const [key] = await h.query<{ column_name: string }>(
      `select a.attname as column_name
         from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
        where i.indrelid = 'recommendation_memory'::regclass and i.indisprimary`,
    );
    assert.equal(
      key?.column_name,
      'recommendation_id',
      'per-operator state would re-offer a dismissed recommendation to somebody else',
    );
  });

  // ── the reads, over the Postgres adapter ───────────────────────────────
  test('the confidence reads compose over rows, and query by non-key columns', async () => {
    const deps = depsOver(h);
    const now = deps.clock.now();
    // The author and the two corroborators need actor rows: `experiences.actor_id` has a
    // foreign key, which is exactly what the in-memory adapter has no way to enforce.
    for (const id of ['act_author', 'act_b', 'act_c']) {
      await h.query(
        `insert into actors (id, email, auth_provider, display_name, default_visibility, role, status)
         values ($1, $2, 'email', $1, 'public', 'member', 'active') on conflict (id) do nothing`,
        [id, `${id}@example.com`],
      );
    }
    await h.store.experiences.put({
      id: 'exp_live',
      actorId: 'act_author',
      kind: 'rage',
      creationMode: 'text',
      status: 'published',
      visibility: 'public',
      category: 'Shopping & service',
      bodyText: 'The refund was never processed.',
      resolutionStatus: 'open',
      resolutionStatusAt: now,
      correlationId: 'cor-live',
      version: 1,
      createdAt: now,
      updatedAt: now,
      publishedAt: now,
    } as never);

    for (const [index, corroboratorId] of ['act_b', 'act_c'].entries()) {
      await h.store.corroborations.put({
        id: `cor_live_${index}`,
        experienceId: 'exp_live',
        corroboratorId,
        type: 're_rage',
        relationship: 'same_experience',
        visibility: 'public',
        status: 'active',
        correlationId: `cor-live-${index}`,
        createdAt: now,
      } as never);
    }

    const confidence = await confidenceFor(deps, 'exp_live');
    assert.equal(confidence?.independentPeople, 2, 'two people');
    assert.equal(confidence?.discarded.duplicates, 0);

    // **What the live schema adds, and it is more than I assumed.** The read discards
    // duplicate rows because they can exist — a backfill, a repaired row, a bug — and the
    // in-memory integration test seeds exactly that. Postgres refuses to hold them in the
    // first place: `(experience_id, corroborator_id)` is unique. So the guarantee is layered,
    // and this asserts the outer layer rather than assuming the read is the only one.
    await assert.rejects(
      () =>
        h.query(
          `insert into experience_corroborations
             (id, experience_id, corroborator_id, type, relationship, visibility, status, correlation_id)
           values ('cor_dupe', 'exp_live', 'act_b', 're_rage', 'same_experience', 'public', 'active', 'cor-dupe')`,
        ),
      /experience_corroborations_experience_id_corroborator_id_key/,
      'one person, one claim, enforced by the database and not only by the command',
    );

    // Recorded through the same `compareAndSet(row, 'absent')` the in-memory adapter uses, so
    // this asserts the Postgres adapter's absence check and the unique constraint agree.
    assert.equal(await recordConfidencePoint(deps, { id: 'exp_live', kind: 'experience' }, confidence!, 5000), true);
    assert.equal(
      await recordConfidencePoint(deps, { id: 'exp_live', kind: 'experience' }, confidence!, 5000),
      false,
      'the adapter absorbs the replay rather than raising',
    );
    assert.equal((await confidenceHistoryFor(deps, 'exp_live')).length, 1);

    assert.equal(await clusterConfidenceFor(deps, 'clu_absent'), undefined);
    assert.equal((await reliabilityFor(deps, 'act_b')).contributions, 1, 'one claim, no publications');
    assert.equal((await resolutionQualityFor(deps, 'exp_live'))?.statusResolved, false);
  });

  test('the series is staff-readable and not member-readable', async () => {
    // The band is publishable and the *history* is not: a reader watching a pattern's
    // credibility move would be watching an argument they cannot see the sides of.
    for (const [id, role] of [['mem_r', 'member'], ['mod_r', 'moderator']] as const) {
      await h.query(
        `insert into actors (id, email, auth_provider, display_name, default_visibility, role, status)
         values ($1, $2, 'email', $1, 'public', $3, 'active') on conflict (id) do nothing`,
        [id, `${id}@example.com`, role],
      );
    }
    await h.query(
      `insert into confidence_points (id, subject_id, subject_kind, at, band, independent_people, deciding)
       values ('cp_rls', 'exp_rls', 'experience', to_timestamp(9000), 'moderate', 4, 'four people')`,
    );

    const asRole = async (actorId: string): Promise<number> => {
      const result = await h.db.transaction(async (tx) => {
        await tx.query('set local role authenticated');
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [actorId]);
        return {
          ok: true as const,
          value: (await tx.query(`select id from confidence_points where id = 'cp_rls'`)).length,
        };
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };

    assert.equal(await asRole('mem_r'), 0, 'a member reads nothing');
    assert.equal(await asRole('mod_r'), 1, 'an operator reads the series');
  });
});
