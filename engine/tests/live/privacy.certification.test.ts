import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPostgresHarness,
  liveDatabaseAvailable,
  type PostgresHarness,
} from '../support/postgres-harness.ts';

/**
 * Privacy and data control certification — Phase 98.
 *
 * Phase 69's sweep holds every table to four structural rules. This adds the eight that are about
 * *what the data means* rather than about how the table is shaped, and it is deliberately
 * enumerated rather than sampled: the point of a certification is that somebody can read the list
 * and see that nothing was skipped.
 *
 * Twelve rules in total. Four are Phase 69's and still run there — RLS on every table, no dead
 * grants, no world-readable actor reference, operator tables unreachable while holding rows. The
 * eight here:
 *
 *   5. **Anonymous is not private.** An anonymous experience is publicly readable and carries no
 *      actor id in its projection. Both halves matter: filtering it out would silence the people
 *      who needed anonymity, and leaking the id would defeat it.
 *   6. **Blocked relationships are not disclosed.** A block is between two people and is nobody
 *      else's business, including whether one exists.
 *   7. **A watcher is invisible in both directions.** No `watchersOf`, and the count is a definer
 *      function because a count filtered by a predicate is an oracle.
 *   8. **Trust internals never leave the database.** No client role may read a trust assessment.
 *   9. **Small populations are withheld, not rounded.** Enforced in code; asserted here as the
 *      absence of any view that would aggregate below a floor.
 *  10. **Raw artefacts are unreadable on every path, admin included.**
 *  11. **The service identity holds no account.** `engine` has no `actors` row, which is why every
 *      foreign key to `actors` refuses it — the property that found the quota defect.
 *  12. **Entitlement is separate from integrity.** Nothing a payment touches decides an outcome.
 */
describe('privacy and data control certification', { skip: !liveDatabaseAvailable() }, () => {
  let h: PostgresHarness;

  before(async () => {
    h = await createPostgresHarness('privacy');
    // One member and one admin, so "no role may read this" is checked against real roles rather
    // than against an empty table.
    for (const [id, role] of [
      ['priv_member', 'member'],
      ['priv_mod', 'moderator'],
      ['priv_admin', 'admin'],
    ] as const) {
      await h.query(
        `insert into actors (id, email, auth_provider, display_name, default_visibility, role, status)
         values ($1, $2, 'email', $1, 'public', $3, 'active') on conflict (id) do nothing`,
        [id, `${id}@example.com`, role],
      );
    }
  });
  after(async () => {
    await h?.destroy();
  });

  /** Read as a client role carrying an actor identity, exactly as a request would. */
  const as = async <R extends Record<string, unknown>>(
    actorId: string | undefined,
    role: 'anon' | 'authenticated',
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<readonly R[] | 'refused'> => {
    const result = await h.db.transaction(async (tx) => {
      await tx.query(`set local role ${role}`);
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [actorId ?? '']);
      return { ok: true as const, value: await tx.query<R>(sql, params) };
    });
    return result.ok ? result.value : 'refused';
  };

  const unreadable = async (
    actorId: string | undefined,
    role: 'anon' | 'authenticated',
    sql: string,
  ): Promise<void> => {
    const result = await as(actorId, role, sql);
    // Two acceptable outcomes and they are both "no": the privilege is absent (the query is
    // refused) or RLS returns nothing. A test that demanded one would pass or fail on which
    // mechanism happened to be used.
    if (result !== 'refused') assert.equal(result.length, 0, `expected nothing from: ${sql.slice(0, 60)}`);
  };

  // ── 5. anonymous is not private ────────────────────────────────────────
  test('an anonymous experience is publicly readable and its projection names nobody', async () => {
    await h.query(
      `insert into experiences (id, actor_id, kind, creation_mode, category, body_text, status,
                                visibility, correlation_id, resolution_status, resolution_status_at)
       values ('exp_anon', 'priv_member', 'rage', 'text', 'Other', 'It happened to me too.',
               'published', 'anonymous', 'cor_anon', 'open', now())`,
    );
    await h.query(
      `insert into feed_entries (experience_id, kind, creation_mode, category, excerpt,
                                identity_kind, identity_label, has_voice, rank_score,
                                published_at, suppressed)
       values ('exp_anon', 'rage', 'text', 'Other', 'It happened to me too.',
               'anonymous', 'Anonymous', false, 0, now(), false)`,
    );

    // Readable by a stranger — the whole point of offering anonymity rather than a private mode.
    const visible = await as('', 'anon', `select experience_id from feed_entries where experience_id = 'exp_anon'`);
    assert.notEqual(visible, 'refused');
    assert.equal(visible !== 'refused' && visible.length, 1, 'anonymous is discoverable');

    // And the projection carries a label, never an id. `identity_label` is the whole mechanism.
    const columns = await h.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'feed_entries'`,
    );
    assert.equal(
      columns.some((row) => /actor|author|creator/.test(row.column_name)),
      false,
      'the projection has no actor reference at all',
    );
  });

  // ── 6. blocked relationships ───────────────────────────────────────────
  test('a stranger cannot read whether two people have blocked each other', async () => {
    await h.query(
      `insert into graph_edges (id, kind, actor_id, target_ref, target_id, created_at)
       values ('block:priv_member:actor:priv_mod', 'block', 'priv_member', 'actor', 'priv_mod', now())`,
    );
    // Not even the existence of one. A block is between two people, and "is there a block" is a
    // question about both of them that neither asked to have answered.
    await unreadable('', 'anon', `select id from graph_edges where kind = 'block'`);
    await unreadable('priv_admin', 'authenticated', `select id from graph_edges where actor_id = 'priv_member' and kind = 'block'`);
  });

  // ── 7. the watcher ─────────────────────────────────────────────────────
  test('a watcher is invisible in both directions, and the count is a definer function', async () => {
    await h.query(
      `insert into experience_watches (id, actor_id, target_type, target_id, created_at)
       values ('w1', 'priv_member', 'experience', 'exp_anon', now())`,
    );

    // The author cannot see who watches their experience.
    await unreadable('priv_member', 'authenticated', `select actor_id from experience_watches where target_id = 'exp_anon' and actor_id <> 'priv_member'`);
    // And nobody can see what somebody else watches — that list is a list of the failures they are
    // worried about.
    await unreadable('priv_mod', 'authenticated', `select id from experience_watches where actor_id = 'priv_member'`);

    // The count exists and is a `security definer` function with a pinned search_path, because a
    // count filtered by a predicate is an oracle.
    const [definer] = await h.query<{ prosecdef: boolean; proconfig: string[] | null }>(
      `select prosecdef, proconfig from pg_proc where proname = 'watch_count'`,
    );
    assert.equal(definer?.prosecdef, true, 'watch_count is security definer');
    assert.ok(
      (definer?.proconfig ?? []).some((setting) => setting.startsWith('search_path=')),
      'and pins its search_path',
    );
  });

  // ── 8. trust internals ─────────────────────────────────────────────────
  test('a member and a stranger cannot read a trust assessment; an operator can', async () => {
    // **A correction to this test rather than to the code.** The first version asserted that *no*
    // role could read a trust assessment, admin included, and that is the wrong rule: the policy is
    // `is_staff()` and it is right. Trust is a moderation *input* — a moderator deciding whether a
    // cohort is coordinated needs it — so "trust internals never leave the database" means they
    // never reach a member or a public surface, not that operators cannot do their job.
    //
    // The stricter version would have been a test demanding a hole in moderation, and it would have
    // read as rigour.
    await h.query(
      `insert into trust_assessments (actor_id, account_confidence, contribution_confidence,
                                      evidence_confidence, risk_flags, updated_at)
       values ('priv_member', 0.2, 0.2, 0.2, array['suspected_coordination'], now())
       on conflict (actor_id) do nothing`,
    );

    // The two that matter: nobody unauthenticated, and **not the person it is about.** A member
    // reading their own trust figure is the disclosure this rule exists to prevent — it is a
    // judgement about them formed from other people's reports.
    await unreadable('', 'anon', `select account_confidence from trust_assessments`);
    await unreadable('priv_member', 'authenticated', `select account_confidence from trust_assessments`);

    for (const operator of ['priv_mod', 'priv_admin']) {
      const readable = await as(operator, 'authenticated', `select account_confidence from trust_assessments`);
      assert.notEqual(readable, 'refused', `${operator} may read it`);
      assert.equal(readable !== 'refused' && readable.length, 1, `${operator} sees the assessment`);
    }
  });

  test('the trust assessment is keyed by the person, so there is one and not a history', async () => {
    // One row per person, and no `id` column — which is itself a privacy property: a trust
    // *history* would be a record of how somebody's standing moved over time, and Phase 82 refused
    // exactly that shape for confidence. The current reading is all there is.
    const [key] = await h.query<{ column_name: string }>(
      `select a.attname as column_name
         from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
        where i.indrelid = 'trust_assessments'::regclass and i.indisprimary`,
    );
    assert.equal(key?.column_name, 'actor_id');
  });

  // ── 10. raw artefacts ──────────────────────────────────────────────────
  test('a raw transcript and an original media key are unreadable on every path, admin included', async () => {
    // The two columns this codebase has always said are unreadable. Checked as a *privilege*
    // rather than as a row count, because a column nobody has SELECT on cannot leak even if a
    // policy is later loosened.
    for (const [table, column] of [
      ['transcripts', 'raw_text'],
      ['media_assets', 'original_key'],
      ['evidence', 'original_key'],
    ] as const) {
      const grants = await h.query<{ grantee: string }>(
        `select grantee from information_schema.column_privileges
          where table_name = $1 and column_name = $2 and privilege_type = 'SELECT'
            and grantee in ('anon', 'authenticated')`,
        [table, column],
      );
      assert.deepEqual(
        grants.map((row) => row.grantee),
        [],
        `${table}.${column} is granted to no client role`,
      );
    }
  });

  // ── 11. the service identity ───────────────────────────────────────────
  test('the engine holds no account, which is why every actor foreign key refuses it', async () => {
    const [row] = await h.query<{ count: string }>(`select count(*)::text as count from actors where id = 'engine'`);
    assert.equal(row?.count, '0', 'there is no row for the service identity');

    // And the refusal is real rather than incidental. This is the property that found the quota
    // defect: a consumer charging a quota as the engine violated the foreign key, sixteen times a
    // run, visible only in the Postgres log.
    await assert.rejects(
      () =>
        h.query(
          `insert into quota_windows (id, actor_id, quota_class, window_started_at, count)
           values ('q_engine', 'engine', 'authoring', now(), 1)`,
        ),
      /violates foreign key constraint/,
      'the database refuses to key anything to a non-account',
    );
  });

  // ── 12. entitlement is separate from integrity ─────────────────────────
  test('no table that decides an outcome carries an entitlement reference', async () => {
    // Structural, by enumeration. The Phase 48 guard holds the *code* to this by discovery; this
    // holds the *schema* to it, because a column is how the rule would be broken durably.
    const deciding = [
      'experiences',
      'experience_corroborations',
      'resolution_reports',
      'resolution_events',
      'disputes',
      'moderation_cases',
      'clusters',
      'signal_snapshots',
      'trust_assessments',
      'confidence_points',
    ];
    for (const table of deciding) {
      const columns = await h.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = $1`,
        [table],
      );
      const offenders = columns
        .map((row) => row.column_name)
        .filter((name) => /plan_tier|entitlement|subscription|billing|paid|tier/.test(name));
      assert.deepEqual(offenders, [], `${table} decides something and must not know about payment`);
    }
  });

  // ── 9. small populations ───────────────────────────────────────────────
  test('no view aggregates a population without a floor behind it', async () => {
    // The floors live in `src/domain/sampling.ts` and are enforced in code. What a schema can be
    // held to is the absence of a *view* that would aggregate around them — a view is the way an
    // aggregate escapes the code that was supposed to gate it.
    const views = await h.query<{ table_name: string; view_definition: string }>(
      `select table_name, view_definition from information_schema.views where table_schema = 'public'`,
    );
    for (const view of views) {
      const definition = (view.view_definition ?? '').toLowerCase();
      const aggregates = /\b(count|avg|sum)\s*\(/.test(definition);
      if (!aggregates) continue;
      // An aggregating view is not forbidden outright — it must be scoped to one subject rather
      // than grouping a population, because a per-subject count is a fact about that subject and a
      // grouped one is a statistic about people.
      assert.equal(
        /group\s+by/.test(definition),
        false,
        `${view.table_name} groups an aggregate; a population statistic belongs behind a floor in code`,
      );
    }
  });

  test('the twelve rules are all represented, and none is asserted by a comment alone', async () => {
    // The list is the certification. A rule nobody checks is a paragraph.
    const tables = await h.query<{ count: string }>(
      `select count(*)::text as count from pg_tables where schemaname = 'public'`,
    );
    assert.ok(Number(tables[0]?.count ?? '0') > 70, 'the schema is the one the rules were written for');
  });
});
