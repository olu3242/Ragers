import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPostgresHarness,
  liveDatabaseAvailable,
  type PostgresHarness,
} from '../support/postgres-harness.ts';
import { createEngine, type Engine } from '../../src/engine.ts';
import { fixedClock, type FixedClock } from '../../src/runtime/clock.ts';
import { uuidIdFactory } from '../../src/runtime/ids.ts';
import { createMemoryLogger } from '../../src/runtime/logger.ts';
import { expect } from '../../src/runtime/result.ts';
import { connectionsOf, relationshipGraphFor } from '../../src/engines/relationship.engine.ts';
import { memoryFor } from '../../src/engines/memory.engine.ts';
import { forbiddenMemoryKeysIn } from '../../src/domain/memory.ts';
import { patternHistoryFor } from '../../src/engines/history.engine.ts';
import { clusterLifecycleFor } from '../../src/engines/lifecycle.engine.ts';
import { degreeOf } from '../../src/domain/relationship.ts';
import { STABILIZING_AFTER_MS } from '../../src/domain/signal-lifecycle.ts';
import { conclusionsFor, recommend, recommendationsFor } from '../../src/engines/conclusion.engine.ts';
import { createPlan, executePlan, planWithSteps } from '../../src/engines/plan.engine.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { AuthResult } from '../../src/engines/identity.engine.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';

/**
 * Phases 51–55 against a real database.
 *
 * These phases add no table, so what Postgres is being asked here is not "does the
 * schema hold" but "do these reads actually see the same rows the in-memory store
 * shows them". That is not a formality: every read below goes through the declarative
 * `Criterion` path, and a criterion that does not translate returns *fewer* rows
 * rather than an error — a graph with edges missing, a history with a period empty,
 * a signal that looks stale because nothing was found.
 */
const DAY = 86_400_000;

describe(
  'the experience loop (live)',
  { skip: liveDatabaseAvailable() ? false : 'no live database configured' },
  () => {
    let h: PostgresHarness;
    let engine: Engine;
    let clock: FixedClock;
    let categoryId = '';
    let keyCounter = 0;

    const nextKey = (): string => {
      keyCounter += 1;
      return `live-loop-${keyCounter}`;
    };

    const signUp = async (email: string): Promise<{ actor: ActorContext; actorId: string }> => {
      const auth = expect(
        await engine.bus.dispatch<unknown, AuthResult>({
          name: 'identity.register',
          input: { email, displayName: 'Live Tester' },
          actor: { actorId: 'guest', role: 'guest', authenticated: false },
          idempotencyKey: nextKey(),
        }),
        `register ${email}`,
      );
      return {
        actorId: auth.actorId,
        actor: { actorId: auth.actorId, role: auth.role, authenticated: true, sessionId: auth.sessionId },
      };
    };

    const settle = async (): Promise<void> => {
      for (let round = 0; round < 12; round += 1) {
        const report = await engine.orchestrator.drain();
        if (report.claimed === 0) break;
        if (report.retried > 0) clock.advance(120_000);
      }
    };

    const publish = async (actor: ActorContext, bodyText: string): Promise<string> => {
      const created = expect(
        await engine.bus.dispatch<unknown, CreateExperienceResult>({
          name: 'experience.create',
          input: { kind: 'rage', creationMode: 'text', category: 'Shopping & service', bodyText, visibility: 'public' },
          actor,
          idempotencyKey: nextKey(),
        }),
        'create',
      );
      await settle();
      return created.experienceId;
    };

    const confirm = async (actor: ActorContext, experienceId: string): Promise<void> => {
      expect(
        await engine.bus.dispatch({
          name: 'normalization.confirm',
          input: { experienceId, fields: { entity: 'ent_1', category: categoryId, issueType: 'iss_1' } },
          actor,
          idempotencyKey: nextKey(),
        }),
        'confirm',
      );
      await settle();
    };

    before(async () => {
      h = await createPostgresHarness('loop');
      clock = fixedClock(1_700_000_000_000);
      engine = createEngine({
        db: h.db,
        clock,
        ids: uuidIdFactory,
        logger: createMemoryLogger(),
        workerId: 'worker_loop',
        retry: { maxAttempts: 3, baseMs: 1_000, factor: 2 },
        leaseMs: 10_000,
      });
      await h.query(`insert into entities (id, name, slug, kind) values
        ('ent_1', 'Northwind Air', 'northwind-air', 'organization')`);
      await h.query(`insert into entity_aliases (id, entity_id, alias) values ('ali_1', 'ent_1', 'Northwind Air')`);
      // Migration 0004 already seeds the category list, so this reads the real row
      // rather than inserting a second one with the same name.
      const [category] = await h.query<{ id: string }>(
        `select id from categories where name = 'Shopping & service'`,
      );
      categoryId = category?.id ?? '';
      await h.query(
        `insert into issue_types (id, category_id, name, slug) values
         ('iss_1', $1, 'Refund not processed', 'refund-not-processed')`,
        [categoryId],
      );
    });

    after(async () => {
      await h?.destroy();
    });

    test('the graph, the memory, the history and the lifecycle all see the real rows', async () => {
      const people = [];
      let clusterId: string | undefined;
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
        const person = await signUp(`${name}@loop.example`);
        const experienceId = await publish(person.actor, `Account ${name}: the refund never arrived`);
        await confirm(person.actor, experienceId);
        const row = await engine.store.experiences.get(experienceId);
        clusterId = row?.clusterId ?? clusterId;
        people.push({ ...person, experienceId });
      }
      const [first, second] = people;
      assert.ok(first && second && clusterId, 'six accounts in one cluster');

      // ── P51. Six accounts in a cluster is five connections from any one of them,
      //    and asserting a pair on top of that adds a reason, not an edge.
      const beforeRelating = await connectionsOf(engine, first.experienceId);
      assert.equal(beforeRelating.length, 5, 'the cluster criterion translated');
      assert.deepEqual(beforeRelating[0]?.reasons, ['same_cluster']);

      expect(
        await engine.bus.dispatch({
          name: 'relation.assert',
          input: { fromExperienceId: first.experienceId, toExperienceId: second.experienceId, assertion: 'same_pattern' },
          actor: first.actor,
          idempotencyKey: nextKey(),
        }),
        'relate',
      );
      await settle();

      const afterRelating = await connectionsOf(engine, first.experienceId);
      assert.equal(afterRelating.length, 5, 'still five connections');
      const toSecond = afterRelating.find((item) => item.experienceId === second.experienceId);
      assert.deepEqual(toSecond?.reasons, ['same_pattern_asserted', 'same_cluster'], 'one more reason');
      assert.equal(toSecond?.assertedByCount, 1);

      const graph = await relationshipGraphFor(engine, first.experienceId);
      assert.equal(degreeOf(graph, first.experienceId), 5, 'the degree did not double');
      assert.equal(graph.trustWeight, 0);

      // ── P52. The enrichment round-trips through jsonb, which is where an array
      //    column has broken before, and the memory must still name nobody.
      expect(
        await engine.bus.dispatch({
          name: 'enrichment.assert',
          input: { experienceId: first.experienceId, dimension: 'money_lost', amount: 640, currency: 'GBP' },
          actor: first.actor,
          idempotencyKey: nextKey(),
        }),
        'assert cost',
      );
      await settle();

      const memory = await memoryFor(engine, first.experienceId);
      assert.ok(memory);
      const kinds = memory.entries.map((entry) => entry.kind);
      assert.ok(kinds.includes('cost_asserted'), 'the jsonb values came back with their timestamps');
      assert.ok(kinds.includes('published'));
      assert.ok(kinds.includes('structure_confirmed'));
      assert.deepEqual(forbiddenMemoryKeysIn(memory), []);
      const serialised = JSON.stringify(memory);
      for (const person of people) {
        assert.ok(!serialised.includes(person.actorId), 'no actor id survives the round trip either');
      }

      // ── P53. A history over a claimed organization, cut into periods.
      await h.query(
        `insert into organization_profiles (id, entity_id, display_name, claimed_by, claimed_at, status)
         values ('org_1', 'ent_1', 'Northwind Air', $1, now(), 'claimed')`,
        [first.actorId],
      );
      const history = await patternHistoryFor(engine, 'org_1', { periods: 3 });
      assert.ok(history, 'the organization resolves');
      assert.equal(history.volume.points.length, 3);
      const latest = history.volume.points.at(-1);
      assert.equal(latest?.aggregate.suppressed, false, 'six people clears the person floor');
      assert.equal(
        latest?.aggregate.suppressed === false && latest.aggregate.measure.withheld === false
          ? latest.aggregate.measure.value
          : undefined,
        6,
        'and the six accounts are all in the latest period',
      );

      // ── P54 + P55. Time passes and nothing else. The signal stops being current
      //    and every row is still there.
      const live = await clusterLifecycleFor(engine, clusterId);
      assert.ok(live);
      assert.equal(live.lifecycle.state, 'active');
      assert.equal(live.uniqueExperiencers, 6);

      clock.advance(STABILIZING_AFTER_MS + DAY);
      const stale = await clusterLifecycleFor(engine, clusterId);
      assert.equal(stale?.lifecycle.state, 'stabilizing');
      assert.equal(stale?.lifecycle.current, false);
      assert.equal(stale?.weight.contributionCount, live.weight.contributionCount, 'no row was read away');
      assert.ok((stale?.weight.weight ?? 0) < live.weight.weight);

      const rows = await h.query<{ count: string }>(`select count(*)::text as count from experiences`);
      assert.equal(rows[0]?.count, '6', 'and the database agrees');
    });

    test('recommendations deduplicate at the primary key, and a plan records each dispatch', async () => {
      // Phases 58–59 are the only two in this band with tables of their own, so this is
      // where Postgres has something to say: the ledger's primary key is what makes
      // concurrent sweeps collide, and the check constraints are what stop a plan
      // claiming completion it did not earn.
      // Its own issue type, so these six form their own cluster rather than joining the
      // one the test above built — the cluster key is (entity, issue type), so sharing it
      // would make this test's assertions depend on the other test having run.
      // Its own entity as well as its own issue type: one organization profile per
      // entity, and the test above already claimed `ent_1`.
      await h.query(`insert into entities (id, name, slug, kind) values
        ('ent_2', 'Southwind Rail', 'southwind-rail', 'organization')`);
      await h.query(`insert into entity_aliases (id, entity_id, alias) values ('ali_2', 'ent_2', 'Southwind Rail')`);
      await h.query(
        `insert into issue_types (id, category_id, name, slug) values
         ('iss_2', $1, 'Callback never made', 'callback-never-made')`,
        [categoryId],
      );
      const people = [];
      let clusterId: string | undefined;
      for (const name of ['g', 'h', 'i', 'j', 'k', 'l']) {
        const person = await signUp(`${name}@plan.example`);
        const experienceId = await publish(person.actor, `Account ${name}: nobody ever called back`);
        expect(
          await engine.bus.dispatch({
            name: 'normalization.confirm',
            input: { experienceId, fields: { entity: 'ent_2', category: categoryId, issueType: 'iss_2' } },
            actor: person.actor,
            idempotencyKey: nextKey(),
          }),
          'confirm',
        );
        await settle();
        clusterId = (await engine.store.experiences.get(experienceId))?.clusterId ?? clusterId;
        people.push({ ...person, experienceId });
      }
      const [owner] = people;
      assert.ok(owner && clusterId);

      const reviewer = await signUp('reviewer@plan.example');
      await h.query(`update actors set role = 'moderator' where id = $1`, [reviewer.actorId]);
      const moderator: ActorContext = { ...reviewer.actor, role: 'moderator' };

      const [conclusion] = await conclusionsFor(engine, clusterId);
      assert.ok(conclusion, 'a conclusion over six people in one cluster');

      // Six concurrent sweeps, one row. Read-then-write would have all six insert and
      // five of them collide with an error they had not earned.
      const results = await Promise.all(
        Array.from({ length: 6 }, () => recommend(engine, conclusion, moderator)),
      );
      assert.equal(results.filter((result) => result.created).length, 1, 'exactly one created it');
      assert.equal((await recommendationsFor(engine, clusterId)).length, 1);
      const ledger = await h.query<{ count: string }>(
        `select count(*)::text as count from recommendations where subject_id = $1`,
        [clusterId],
      );
      assert.equal(ledger[0]?.count, '1', 'and the database agrees');

      // The text[] column round-trips as a list rather than as a Postgres array literal
      // dressed up as JSON — the defect the jsonb convention exists to prevent, in the
      // other direction.
      const stored = await engine.store.recommendations.get(results[0]!.row.id);
      assert.equal(stored?.acrossExperienceIds.length, 6);
      assert.ok(stored?.acrossExperienceIds.includes(owner.experienceId));

      const proposalId = results.find((result) => result.created)?.row.proposalId;
      assert.ok(proposalId, 'the recommendation produced a proposal');
      expect(
        await engine.bus.dispatch({
          name: 'proposal.decide',
          input: { proposalId, outcome: 'approved' },
          actor: moderator,
          idempotencyKey: nextKey(),
        }),
        'approve',
      );

      // A staff member for the organization, so one step dispatches and one does not.
      await h.query(
        `insert into organization_profiles (id, entity_id, display_name, claimed_by, claimed_at, status)
         values ('org_plan', 'ent_2', 'Southwind Rail', $1, now(), 'claimed')`,
        [owner.actorId],
      );
      await h.query(
        `insert into organization_memberships (id, organization_id, actor_id, role, granted_at)
         values ('mem_plan', 'org_plan', $1, 'admin', now())`,
        [owner.actorId],
      );

      const plan = expect(
        await createPlan(
          engine,
          {
            proposalId,
            steps: [
              {
                command: 'case.open',
                targetEngine: 'E9',
                // A nested input, so the jsonb column is exercised with something an
                // array literal would mangle.
                input: { organizationId: 'org_plan', experienceId: owner.experienceId },
              },
              // Admin-only, and this reviewer is staff for the organization but not an
              // admin — so the plan must record a refusal rather than borrow privilege.
              { command: 'governance.grantRole', targetEngine: 'E4', input: { actorId: owner.actorId, role: 'admin' } },
            ],
          },
          owner.actor,
        ),
        'create plan',
      );

      const executed = expect(await executePlan(engine, plan.id, owner.actor), 'execute');
      assert.equal(executed.plan.status, 'partially_completed');
      assert.equal(executed.plan.dispatchedCount, 1);

      const rows = await h.query<{
        step_order: number;
        dispatched: boolean;
        dispatch_error: string | null;
        input: Record<string, unknown>;
      }>(`select step_order, dispatched, dispatch_error, input from action_plan_steps where plan_id = $1 order by step_order`, [
        plan.id,
      ]);
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.dispatched, true);
      assert.equal(rows[0]?.dispatch_error, null);
      assert.deepEqual(rows[0]?.input, { organizationId: 'org_plan', experienceId: owner.experienceId });
      assert.equal(rows[1]?.dispatched, false);
      assert.ok(rows[1]?.dispatch_error, 'the refusal is stored verbatim');

      const readBack = await planWithSteps(engine, plan.id);
      assert.equal(readBack?.steps[0]?.input['organizationId'], 'org_plan', 'jsonb round-trips as an object');

      // The step that dispatched belongs to E9, which has the case.
      const cases = await h.query<{ count: string }>(
        `select count(*)::text as count from organization_cases where organization_id = 'org_plan'`,
      );
      assert.equal(cases[0]?.count, '1');

      // And the privilege the refused step asked for was not granted.
      const actor = await h.query<{ role: string }>(`select role from actors where id = $1`, [owner.actorId]);
      assert.notEqual(actor[0]?.role, 'admin');
    });

    test('the database refuses a plan that claims completion it did not earn', async () => {
      // The constraints, exercised directly. The application will not write these rows,
      // which is exactly why the database has to refuse them: a constraint nothing tests
      // is a comment.
      await h.query(
        `insert into intelligence_proposals
           (id, proposal_type, source_engine, target_engine, subject_id, summary, rationale, confidence,
            evidence_refs, status, proposed_input, correlation_id)
         values ('prp_c', 'recurring_failure', 'E12', 'E9', 'clu_c', 'A summary', 'A rationale', 0.5,
            '[{"kind":"cluster","id":"clu_c"}]'::jsonb, 'proposed', '{}'::jsonb, 'corr_c')`,
      );
      const reviewer = await signUp('constraints@plan.example');
      // Attributed, because `proposal_review_is_attributed` refuses a decided proposal
      // with nobody's name on the decision — which is itself the right constraint.
      await h.query(`update intelligence_proposals set status = 'approved', reviewed_by = $1, reviewed_at = now() where id = 'prp_c'`, [
        reviewer.actorId,
      ]);

      await assert.rejects(
        () =>
          h.query(
            `insert into action_plans (id, proposal_id, subject_id, approved_by, status, step_count, dispatched_count, executed_at)
             values ('plan_bad', 'prp_c', 'clu_c', $1, 'completed', 3, 2, now())`,
            [reviewer.actorId],
          ),
        /plans_completed_is_total/,
        'completed means every step dispatched',
      );

      await assert.rejects(
        () =>
          h.query(
            `insert into action_plans (id, proposal_id, subject_id, approved_by, status, step_count, dispatched_count)
             values ('plan_bad2', 'prp_c', 'clu_c', $1, 'failed', 3, 0)`,
            [reviewer.actorId],
          ),
        /plans_executed_has_time/,
        'a plan that says it ran must say when',
      );

      await h.query(
        `insert into action_plans (id, proposal_id, subject_id, approved_by, status, step_count, dispatched_count)
         values ('plan_ok', 'prp_c', 'clu_c', $1, 'pending', 1, 0)`,
        [reviewer.actorId],
      );
      await assert.rejects(
        () =>
          h.query(
            `insert into action_plan_steps (id, plan_id, step_order, command, target_engine, dispatched, dispatch_error, executed_at)
             values ('step_bad', 'plan_ok', 1, 'case.open', 'E9', true, 'refused', now())`,
          ),
        /steps_not_both/,
        'a step cannot be both dispatched and refused',
      );

      await assert.rejects(
        () =>
          h.query(
            `insert into recommendations (id, kind, subject_id, across_experience_ids, distinct_people, lifecycle_state)
             values ('rec_bad', 'recurring_failure', 'clu_c', array['exp_1'], 2, 'active')`,
          ),
        /recommendations_span_two/,
        'a pattern over one account is not a pattern',
      );
    });
  },
);
