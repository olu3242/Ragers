import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPostgresHarness,
  liveDatabaseAvailable,
  type PostgresHarness,
} from '../support/postgres-harness.ts';

/**
 * Phase 69 — the tenant isolation sweep.
 *
 * The existing RLS certification proves twenty-seven specific things about specific
 * tables. This is the other kind of test: it enumerates the schema and holds **every**
 * table to a stated rule, so a table added next month is covered next month without
 * anybody remembering. Same reasoning that replaced the Phase 48 filename list with
 * discovery — a hand-maintained list of tables to check is a list that stops being
 * complete on the day somebody adds a table, and it goes on reading like coverage.
 *
 * Four rules, each stated as a query over `pg_catalog` and
 * `information_schema.column_privileges` rather than as a list of table names:
 *
 * 1. Row-level security is enabled on every table. No exceptions, including the runtime
 *    tables — RLS on with no policy denies everything to a non-owner, which is the
 *    correct posture for a queue only the worker drains.
 * 2. A table with no policies grants nothing to a client role. A grant with no policy
 *    behind it is a dead grant that reads like access, and the next person to add a
 *    policy inherits it.
 * 3. **No table a stranger can read exposes an actor identity.** This is the rule that
 *    found something.
 * 4. The operator-only tables are unreachable by a member even when they hold rows,
 *    which is the part an empty table would fake.
 *
 * ## What rule 3 found
 *
 * Four columns readable by `anon` — an unauthenticated visitor — on tables whose read
 * policy is `using (true)`:
 *
 *   - `reactions.actor_id`. Anyone could enumerate every experience a given account had
 *     reacted to. On this product that is the worst of the four: a `been_there` reaction
 *     is somebody saying *this happened to me as well*, which is a claim about their own
 *     life, and it was world-readable with their account id attached. The corroboration
 *     table — the same claim, made deliberately — has four scoped policies. Reactions are
 *     the older table and were never revisited.
 *   - `experience_shares.actor_id`. Who shared what, and where to.
 *   - `resolution_events.actor_id`. Who moved a resolution status.
 *   - `organization_profiles.claimed_by`. Which personal account claimed which business,
 *     which links a named person to a company for anybody who asks.
 *
 * None of it was reachable through the product, because every read goes through the engine
 * on the owner connection and no browser client exists yet. That is exactly why it was
 * worth finding now: the hole opens the day somebody adds a direct client, and on that day
 * nobody would be looking at the grants from 0002.
 */
describe(
  'tenant isolation sweep',
  { skip: liveDatabaseAvailable() ? false : 'no live database configured' },
  () => {
    let h: PostgresHarness;

    const MEMBER = 'iso_member';
    const OTHER = 'iso_other';
    const STAFF_A = 'iso_staff_a';
    const STAFF_B = 'iso_staff_b';

    /** Read as a client role carrying an actor identity, exactly as a request would. */
    const as = async <R extends Record<string, unknown>>(
      actorId: string | undefined,
      role: 'anon' | 'authenticated',
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<readonly R[]> => {
      const result = await h.db.transaction(async (tx) => {
        await tx.query(`set local role ${role}`);
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [actorId ?? '']);
        return { ok: true as const, value: await tx.query<R>(sql, params) };
      });
      if (!result.ok) throw new Error(`query failed: ${result.error.message}`);
      return result.value;
    };

    /** No access by either mechanism: the privilege is absent, or RLS returns nothing. */
    const expectNoRows = async (
      actorId: string | undefined,
      role: 'anon' | 'authenticated',
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<void> => {
      const result = await h.db.transaction(async (tx) => {
        await tx.query(`set local role ${role}`);
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [actorId ?? '']);
        return { ok: true as const, value: (await tx.query(sql, params)).length };
      });
      if (result.ok) assert.equal(result.value, 0, `expected no rows: ${sql.slice(0, 70)}`);
    };

    before(async () => {
      h = await createPostgresHarness('tenant');

      for (const [id, role] of [
        [MEMBER, 'member'],
        [OTHER, 'member'],
        [STAFF_A, 'member'],
        [STAFF_B, 'member'],
      ] as const) {
        await h.query(`insert into actors (id, email, display_name, role) values ($1, $2, 'Iso', $3)`, [
          id,
          `${id}@example.com`,
          role,
        ]);
      }

      await h.query(
        `insert into experiences (id, actor_id, kind, creation_mode, category, body_text, status, visibility, correlation_id, published_at)
         values ('iso_exp', $1, 'rage', 'text', 'Other', 'The queue was two hours long.', 'published', 'public', 'corr', now())`,
        [MEMBER],
      );

      // The identity-bearing rows rule 3 is about. Present so a stranger's read is a real
      // read rather than an empty table pretending to be a pass.
      await h.query(
        `insert into reactions (id, experience_id, actor_id, reaction_type) values ('iso_rx', 'iso_exp', $1, 'same')`,
        [OTHER],
      );
      await h.query(
        `insert into experience_shares (id, experience_id, actor_id, destination) values ('iso_share', 'iso_exp', $1, 'copy_link')`,
        [OTHER],
      );
      await h.query(
        `insert into resolution_events (id, experience_id, from_status, to_status, source, actor_id, correlation_id)
         values ('iso_res', 'iso_exp', 'open', 'acknowledged', 'organization', $1, 'corr')`,
        [STAFF_A],
      );

      // Two organizations, so "another tenant's rows" is a real question.
      for (const [entity, org, staff] of [
        ['iso_ent_a', 'iso_org_a', STAFF_A],
        ['iso_ent_b', 'iso_org_b', STAFF_B],
      ] as const) {
        await h.query(`insert into entities (id, name, slug, kind) values ($1, $1, $1, 'organization')`, [entity]);
        await h.query(
          `insert into organization_profiles (id, entity_id, display_name, claimed_by, status)
           values ($1, $2, 'Iso Org', $3, 'claimed')`,
          [org, entity, staff],
        );
        await h.query(
          `insert into organization_memberships (id, organization_id, actor_id, role) values ($1, $2, $3, 'admin')`,
          [`mem_${org}`, org, staff],
        );
        await h.query(
          `insert into organization_cases (id, organization_id, experience_id, state, correlation_id)
           values ($1, $2, 'iso_exp', 'new', 'corr')`,
          [`case_${org}`, org],
        );
        // Keyed by the organization it belongs to, so the id *is* the organization.
        await h.query(
          `insert into organization_entitlements (organization_id, tier, features) values ($1, 'professional', array['benchmark_reports'])`,
          [org],
        );
      }

      // Operator-only rows, so rule 4 is exercised against real data. A recommendation spans
      // at least two experiences by constraint, which is the domain rule showing up here.
      await h.query(
        `insert into experiences (id, actor_id, kind, creation_mode, category, body_text, status, visibility, correlation_id, published_at)
         values ('iso_exp2', $1, 'rage', 'text', 'Other', 'And again the following week.', 'published', 'public', 'corr', now())`,
        [OTHER],
      );
      await h.query(
        `insert into recommendations (id, kind, subject_id, across_experience_ids, distinct_people, lifecycle_state)
         values ('iso_rec', 'repeat_pattern', 'iso_ent_a', array['iso_exp','iso_exp2'], 2, 'active')`,
      );
      await h.query(
        `insert into intelligence_proposals (id, proposal_type, source_engine, target_engine, subject_id, summary, rationale, confidence, correlation_id)
         values ('iso_prop', 'open_review', 'E8', 'E9', 'iso_ent_a', 'A situation', 'Because of the rows', 0.8, 'corr')`,
      );
      await h.query(
        `insert into action_plans (id, proposal_id, subject_id, approved_by, status, step_count)
         values ('iso_plan', 'iso_prop', 'iso_ent_a', $1, 'pending', 1)`,
        [STAFF_A],
      );
      await h.query(
        `insert into action_plan_steps (id, plan_id, step_order, command, target_engine)
         values ('iso_step', 'iso_plan', 1, 'case.open', 'E9')`,
      );
      await h.query(
        `insert into retention_sweeps (subject_id, retention_class, verdict, expires_at, reason)
         values ('iso_media', 'original_media', 'within_ceiling', now() + interval '30 days', 'A stated ceiling with its reason.')`,
      );
    });

    after(async () => {
      await h?.destroy();
    });

    test('row-level security is enabled on every table, with no exceptions', async () => {
      // Enumerated, not listed. A table added without RLS fails here on the day it is added,
      // which is the only time the failure is cheap.
      const unprotected = await h.query<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
         order by c.relname`,
      );
      assert.deepEqual(
        unprotected.map((row) => row.relname),
        [],
        'every table has RLS enabled',
      );
    });

    test('the sweep covers every table, so nobody can add one outside it', async () => {
      const tables = await h.query<{ count: string }>(
        `select count(*)::text as count from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'`,
      );
      // A floor rather than an exact number: the point is that the count comes from the
      // database rather than from a constant somebody would have to remember to raise.
      assert.ok(Number(tables[0]?.count ?? 0) >= 78, `the schema has its tables (${tables[0]?.count})`);
    });

    test('a table with no policies grants nothing to a client role', async () => {
      // RLS with no policy denies everything, so such a table is safe — but a *grant* on it
      // reads like access to the next person, and they will add a policy on top of it.
      //
      // Restricted to `relkind = 'r'`. The first version of this joined
      // `information_schema.tables`, which includes views — and the four `_public` views
      // exist precisely so a client role can read a subset of a protected table, so they
      // have grants and no policies of their own by design. Flagging them made the rule
      // look violated by the mechanism that enforces it.
      const dead = await h.query<{ table_name: string; grantee: string }>(
        `select distinct p.table_name, p.grantee
         from information_schema.table_privileges p
         join pg_class c on c.relname = p.table_name and c.relkind = 'r'
         join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
         where p.table_schema = 'public'
           and p.grantee in ('anon', 'authenticated')
           and not exists (select 1 from pg_policy pol where pol.polrelid = c.oid)
         order by 1, 2`,
      );
      assert.deepEqual(dead, [], 'no grant stands on a table with no policy behind it');
    });

    test('no table a stranger can read exposes an actor identity', async () => {
      // The rule that found four columns. `anon` is an unauthenticated visitor, and a read
      // policy of `using (true)` plus a column grant is world-readable — no login, no rate
      // limit, no trace.
      //
      // Matched by shape rather than by a list of column names, so a future
      // `submitted_by` or `raised_by` on a public table is caught the same way.
      const exposed = await h.query<{ table_name: string; column_name: string; grantee: string }>(
        `with world_readable as (
           select distinct c.relname
           from pg_policy p
           join pg_class c on c.oid = p.polrelid
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public'
             and p.polcmd in ('r', '*')
             and (pg_get_expr(p.polqual, p.polrelid) is null or pg_get_expr(p.polqual, p.polrelid) = 'true')
         )
         select cp.table_name, cp.column_name, cp.grantee
         from information_schema.column_privileges cp
         join world_readable w on w.relname = cp.table_name
         where cp.table_schema = 'public'
           and cp.grantee in ('anon', 'authenticated')
           and cp.privilege_type = 'SELECT'
           and (
             cp.column_name ~ '(^|_)actor_id$'
             or cp.column_name in ('submitted_by', 'raised_by', 'claimed_by', 'granted_by',
                                   'moderator_id', 'reviewed_by', 'assessed_by', 'assignee_id',
                                   'claimed_by_actor_id', 'recipient_actor_id', 'created_by')
           )
         order by 1, 2, 3`,
      );
      assert.deepEqual(
        exposed,
        [],
        'a world-readable table must not carry a readable actor reference',
      );
    });

    test('a stranger cannot learn who reacted, shared, or moved a resolution', async () => {
      // The same rule again, executed rather than inspected. The rows exist — the seed put
      // them there — so a zero result is a refusal and not an empty table.
      for (const table of ['reactions', 'experience_shares', 'resolution_events']) {
        await expectNoRows(undefined, 'anon', `select actor_id from ${table}`);
        await expectNoRows(MEMBER, 'authenticated', `select actor_id from ${table}`);
      }
      await expectNoRows(undefined, 'anon', `select claimed_by from organization_profiles`);

      // And the non-identity columns still read, because withholding the identity must not
      // take the counts and the public business page with it.
      const reactions = await as(undefined, 'anon', `select reaction_type from reactions`);
      assert.equal(reactions.length, 1, 'the reaction is still visible as a reaction');
      const profiles = await as(undefined, 'anon', `select id, display_name, status from organization_profiles`);
      assert.equal(profiles.length, 2, 'and a claimed business is still a public page');
    });

    test('the operator tables phases 58, 59 and 65 added are unreachable by a member', async () => {
      // Named because the roadmap named them, but exercised against real rows: an empty
      // table refuses everybody and proves nothing.
      for (const table of ['recommendations', 'action_plans', 'action_plan_steps', 'retention_sweeps']) {
        const count = await h.query<{ count: string }>(`select count(*)::text as count from ${table}`);
        assert.equal(count[0]?.count, '1', `${table} has a row to be refused`);
        await expectNoRows(MEMBER, 'authenticated', `select * from ${table}`);
        await expectNoRows(undefined, 'anon', `select * from ${table}`);
      }
    });

    test('a hostile tenant reads none of another organization\'s rows', async () => {
      // Two organizations, each with a case and an entitlement. Staff of one must see
      // exactly their own — not zero, which would prove only that the policy is broken in
      // the other direction.
      const ownCases = await as<{ id: string }>(
        STAFF_A,
        'authenticated',
        `select id from organization_cases order by id`,
      );
      assert.deepEqual(
        ownCases.map((row) => row.id),
        ['case_iso_org_a'],
        'staff see their own case and only their own',
      );

      const ownEntitlements = await as<{ organization_id: string }>(
        STAFF_B,
        'authenticated',
        `select organization_id from organization_entitlements order by organization_id`,
      );
      assert.deepEqual(
        ownEntitlements.map((row) => row.organization_id),
        ['iso_org_b'],
        'and their own entitlement',
      );

      // A member who acts for no organization sees neither.
      await expectNoRows(MEMBER, 'authenticated', `select id from organization_cases`);
      await expectNoRows(MEMBER, 'authenticated', `select organization_id from organization_entitlements`);
    });

    test('every security-definer function pins its search path', async () => {
      // Added when Phase 78 introduced `watch_count`, which is `security definer` so it can
      // count rows the caller cannot select — the only way to publish a watcher count without
      // publishing the watchers.
      //
      // A definer function runs with the owner's privileges, so a mutable `search_path` is a
      // privilege escalation waiting for somebody to create a table or operator with the right
      // name in a schema that resolves first. The four identity helpers in 0002 pin it and the
      // convention was written down in a comment; this makes it a rule, because the next
      // definer function will be written by somebody who did not read that comment.
      const unpinned = await h.query<{ proname: string; config: string | null }>(
        `select p.proname, array_to_string(p.proconfig, ',') as config
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prosecdef
           and (p.proconfig is null or not exists (
             select 1 from unnest(p.proconfig) as c where c like 'search_path=%'
           ))
         order by p.proname`,
      );
      assert.deepEqual(
        unpinned,
        [],
        'a security definer function without a pinned search_path is a privilege escalation',
      );

      // And the sweep is looking at something. The floor is 2 rather than the 4 I first
      // assumed: of the four identity helpers in 0002, only `current_actor_role` is
      // `security definer` — the other three are plain functions that read a setting, so they
      // need no elevated privilege and correctly do not ask for one. `watch_count` is the
      // second. Asserting the real number rather than the expected one, because a floor
      // nobody checked is a floor that passes by accident.
      const definers = await h.query<{ proname: string }>(
        `select p.proname from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prosecdef
         order by p.proname`,
      );
      assert.deepEqual(
        definers.map((row) => row.proname),
        ['current_actor_role', 'watch_count'],
        'the definer functions are exactly the two that need to be, and both are checked above',
      );
    });

    test('a watcher is invisible at the database, in both directions', async () => {
      // Phase 78's rule, held by RLS rather than by the engine. Seeded through the store so
      // the rows are real, then read as two different people.
      await h.query(
        `insert into experience_watches (id, actor_id, target_type, target_id)
         values ('w_iso_1', $1, 'experience', 'iso_exp')`,
        [OTHER],
      );

      // The author of the watched experience cannot see who is watching it.
      await expectNoRows(MEMBER, 'authenticated', `select actor_id from experience_watches`);
      // Nor can anybody else, including a signed-out visitor.
      await expectNoRows(undefined, 'anon', `select * from experience_watches`);
      // The watcher sees their own row and only their own.
      const own = await as<{ id: string }>(
        OTHER,
        'authenticated',
        `select id from experience_watches order by id`,
      );
      assert.deepEqual(own.map((row) => row.id), ['w_iso_1'], 'a watcher reads their own watch');

      // And the count is available to anybody, through the definer function, without the rows
      // being. This is the whole reason it is a function rather than a permissive policy: a
      // count filtered by a predicate is an oracle, and this one takes no predicate.
      const counted = await as<{ watch_count: number }>(
        undefined,
        'anon',
        `select watch_count('experience'::watch_target, 'iso_exp') as watch_count`,
      );
      assert.equal(counted[0]?.watch_count, 1, 'a stranger may count and may not enumerate');
    });

    test('no policy grants every command without scoping it to somebody', async () => {
      // `for all` is legitimate and used throughout: "you may do anything to your own rows"
      // (`actor_id = current_actor_id()`) and "staff own this table" (`is_staff()`) are both
      // correctly expressed that way, and the first version of this rule wrongly flagged
      // them. The actual hazard is narrower and worth a rule of its own: a `for all` policy
      // whose qualifier scopes to *nobody* grants insert, update and delete to everyone, and
      // it looks identical to a read policy at a glance.
      //
      // Swept across every table rather than a list of five, because the table this catches
      // is the one nobody thought to list.
      const unscoped = await h.query<{ relname: string; polname: string; qual: string | null }>(
        `select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) as qual
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
         where p.polcmd = '*'
           -- The scoping vocabulary is the four identity helpers 0002 defines plus a
           -- membership lookup. Anything else governing every command is scoped to nobody.
           and coalesce(pg_get_expr(p.polqual, p.polrelid), 'true')
                 !~ 'current_actor_id|current_actor_role|is_staff|is_admin|organization_membership'
         order by 1, 2`,
      );
      assert.deepEqual(unscoped, [], 'a policy governing every command names who it applies to');

      // And the vocabulary itself is real: a typo in the pattern above would make this rule
      // pass by matching nothing, so assert the helpers exist rather than trusting the names.
      const helpers = await h.query<{ proname: string }>(
        `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and proname = any(array['current_actor_id','is_staff','is_admin'])
         order by proname`,
      );
      assert.deepEqual(
        helpers.map((row) => row.proname),
        ['current_actor_id', 'is_admin', 'is_staff'],
        'the scoping helpers this rule names all exist',
      );
    });
  },
);
