import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { reputationEvolutionFor } from '../../src/engines/evolution.engine.ts';
import {
  conclusionsFor,
  recommend,
  recommendationsFor,
  recommendationMutatesGovernedState,
} from '../../src/engines/conclusion.engine.ts';
import {
  createPlan,
  executePlan,
  planWithSteps,
  planMutatesGovernedState,
} from '../../src/engines/plan.engine.ts';
import { EXPIRES_AFTER_MS } from '../../src/domain/signal-lifecycle.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';

/**
 * Phases 56–59 through the real bus.
 *
 * The pure rules are held in `tests/unit/evolution.conclusion.plan.test.ts`. What is
 * here is everything that only exists once a real command has run: whether the
 * recommendation ledger actually deduplicates under concurrency, whether a plan step
 * faces the *reviewer's* authorization rather than the engine's, and whether any of
 * this can reach an E1–E11 table.
 */
const DAY = 86_400_000;

interface World {
  readonly h: EngineHarness;
  readonly clusterId: string;
  readonly experienceIds: readonly string[];
  readonly author: { readonly actor: ActorContext; readonly actorId: string };
  readonly staff: { readonly actor: ActorContext; readonly actorId: string };
  readonly admin: ActorContext;
}

const seed = async (kind: 'rage' | 'rave' = 'rage'): Promise<World> => {
  const h = createEngineHarness();
  await h.engine.store.entities.put({ id: 'ent_1', name: 'Northwind Air', slug: 'northwind-air', kind: 'organization' });
  await h.engine.store.entityAliases.put({ id: 'ali_e1', entityId: 'ent_1', alias: 'Northwind Air' });
  await h.engine.store.categories.put({ id: 'cat_1', name: 'Shopping & service', slug: 'shopping-service' });
  await h.engine.store.issueTypes.put({
    id: 'iss_1',
    categoryId: 'cat_1',
    name: 'Refund not processed',
    slug: 'refund-not-processed',
  });

  const staffSignUp = await h.signUp('staff@example.com', 'Staff');
  const admin = await h.promote((await h.signUp('boundary-admin@example.com')).auth.actorId, 'admin');
  await h.engine.store.organizationProfiles.put({
    id: 'org_1',
    entityId: 'ent_1',
    displayName: 'Northwind Air',
    claimedBy: staffSignUp.auth.actorId,
    claimedAt: h.clock.now(),
    status: 'claimed',
  });
  await h.engine.store.organizationMemberships.put({
    id: 'mem_1',
    organizationId: 'org_1',
    actorId: staffSignUp.auth.actorId,
    role: 'admin',
    grantedAt: h.clock.now(),
  });

  const experienceIds: string[] = [];
  let author: { actor: ActorContext; actorId: string } | undefined;
  let clusterId = '';
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const person = await h.signUp(`${name}@example.com`, name);
    if (!author) author = { actor: person.actor, actorId: person.auth.actorId };
    const created = expect(
      await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
        name: 'experience.create',
        input: {
          kind,
          creationMode: 'text',
          category: 'Shopping & service',
          bodyText: kind === 'rage' ? `Account ${name}: the refund never arrived` : `Account ${name}: they fixed it same day`,
          visibility: 'public',
        },
        actor: person.actor,
        idempotencyKey: h.nextKey(),
      }),
      'create',
    );
    await h.settle();
    expect(
      await h.engine.bus.dispatch({
        name: 'normalization.confirm',
        input: { experienceId: created.experienceId, fields: { entity: 'ent_1', category: 'cat_1', issueType: 'iss_1' } },
        actor: person.actor,
        idempotencyKey: h.nextKey(),
      }),
      'confirm',
    );
    await h.settle();
    experienceIds.push(created.experienceId);
    clusterId = (await h.engine.store.experiences.get(created.experienceId))?.clusterId ?? clusterId;
  }

  assert.ok(author && clusterId, 'six accounts in one cluster');
  return {
    h,
    clusterId,
    experienceIds,
    author,
    staff: { actor: staffSignUp.actor, actorId: staffSignUp.auth.actorId },
    admin,
  };
};

/** An approved proposal, which is the only thing a plan may be drawn from. */
const approvedProposal = async (world: World): Promise<string> => {
  const created = expect(
    await world.h.engine.bus.dispatch<unknown, { proposalId: string }>({
      name: 'proposal.create',
      input: {
        proposalType: 'recurring_failure',
        sourceEngine: 'E12',
        targetEngine: 'E9',
        subjectId: world.clusterId,
        summary: 'Six accounts from six people describe the same failure',
        rationale: 'They share a confirmed entity and issue type, so this is one failure reported repeatedly.',
        confidence: 0.8,
        evidenceRefs: [{ kind: 'cluster', id: world.clusterId }],
      },
      actor: world.admin,
      idempotencyKey: world.h.nextKey(),
    }),
    'create proposal',
  );
  expect(
    await world.h.engine.bus.dispatch({
      name: 'proposal.decide',
      input: { proposalId: created.proposalId, outcome: 'approved' },
      actor: world.admin,
      idempotencyKey: world.h.nextKey(),
    }),
    'approve',
  );
  await world.h.settle();
  return created.proposalId;
};

// ── P56 evolution ─────────────────────────────────────────────────────────
test('reputation evolution is a series per component, and there is no single number', async () => {
  const world = await seed();
  const { h } = world;

  const evolution = await reputationEvolutionFor(h.engine, world.author.actorId, { periods: 3 });
  assert.ok(evolution);
  assert.deepEqual(
    evolution.counts.map((series) => series.component),
    ['experiences_published', 'corroborated_experiences', 'corroborations_given', 'consistent_evidence'],
  );
  const published = evolution.counts.find((series) => series.component === 'experiences_published');
  assert.equal(published?.points.at(-1)?.value, 1, 'they published one');
  assert.equal(published?.points[0]?.value, 0, 'and had not, two periods ago');
  assert.equal(published?.direction, 'rising');

  // The approval component is the one derived from other people's votes, so it is a
  // Measure and it is withheld here — nobody has voted at all.
  assert.equal(evolution.approval.points.at(-1)?.value.withheld, true);
  assert.equal(evolution.approval.direction, undefined);

  // No field anywhere is a composite. Asserted over the serialised read, so a future
  // addition has to argue with this test.
  const serialised = JSON.stringify(evolution);
  for (const forbidden of ['score', 'shares', 'views', 'reactions', 'followers']) {
    assert.ok(!serialised.includes(forbidden), `no ${forbidden} in a reputation read`);
  }
});

test('an unknown actor has no evolution rather than an empty one', async () => {
  const h = createEngineHarness();
  assert.equal(await reputationEvolutionFor(h.engine, 'actor_missing'), undefined);
});

// ── P57 conclusions ───────────────────────────────────────────────────────
test('a conclusion spans the cluster and points at rows a reviewer can open', async () => {
  const world = await seed();
  const conclusions = await conclusionsFor(world.h.engine, world.clusterId);
  assert.equal(conclusions.length, 1, 'one conclusion: a recurring failure');

  const [conclusion] = conclusions;
  assert.equal(conclusion?.kind, 'recurring_failure');
  assert.equal(conclusion?.distinctPeople, 6);
  assert.equal(conclusion?.acrossExperienceIds.length, 6);
  assert.equal(conclusion?.lifecycleState, 'active');
  // The basis is the cluster and every experience in it, all openable.
  assert.equal(conclusion?.basis.length, 7);
  for (const ref of conclusion?.basis ?? []) {
    const exists =
      ref.kind === 'cluster'
        ? await world.h.engine.store.clusters.get(ref.id)
        : await world.h.engine.store.experiences.get(ref.id);
    assert.ok(exists, `${ref.kind} ${ref.id} is a real row`);
  }
});

test('no conclusion is drawn once the signal has expired', async () => {
  const world = await seed();
  assert.equal((await conclusionsFor(world.h.engine, world.clusterId)).length, 1);

  // Nothing changes except time.
  world.h.clock.advance(EXPIRES_AFTER_MS + DAY);
  assert.deepEqual(
    await conclusionsFor(world.h.engine, world.clusterId),
    [],
    'a present-tense conclusion about last year is not drawn',
  );
});

// ── P58 recommendations ───────────────────────────────────────────────────
test('the same conclusion recommended twice produces one recommendation', async () => {
  // The failure test the phase names: recommendation duplication.
  const world = await seed();
  const [conclusion] = await conclusionsFor(world.h.engine, world.clusterId);
  assert.ok(conclusion);

  const first = await recommend(world.h.engine, conclusion, world.admin);
  assert.equal(first.created, true);
  assert.ok(first.row.proposalId, 'and it produced a proposal');

  const second = await recommend(world.h.engine, conclusion, world.admin);
  assert.equal(second.created, false, 'the second run recommends nothing new');
  assert.equal(second.row.id, first.row.id);

  assert.equal((await recommendationsFor(world.h.engine, world.clusterId)).length, 1);
  const proposals = await world.h.engine.store.proposals.query([{ field: 'subjectId', op: 'eq', value: world.clusterId }]);
  assert.equal(proposals.length, 1, 'and one proposal, not two');
});

test('six sweeps reaching one conclusion at once still produce one recommendation', async () => {
  // Concurrency, which is where the read-then-write version of this would fail: all six
  // would find nothing, all six would create.
  const world = await seed();
  const [conclusion] = await conclusionsFor(world.h.engine, world.clusterId);
  assert.ok(conclusion);

  const results = await Promise.all(
    Array.from({ length: 6 }, () => recommend(world.h.engine, conclusion, world.admin)),
  );
  assert.equal(results.filter((result) => result.created).length, 1, 'exactly one created it');
  assert.equal(new Set(results.map((result) => result.row.id)).size, 1, 'and they all name the same row');
  assert.equal((await recommendationsFor(world.h.engine, world.clusterId)).length, 1);
});

test('recommending writes to no governed table', async () => {
  const world = await seed();
  const { h } = world;
  const [conclusion] = await conclusionsFor(h.engine, world.clusterId);
  assert.ok(conclusion);

  const before = await Promise.all([
    h.engine.store.experiences.count(),
    h.engine.store.corroborations.count(),
    h.engine.store.resolutionEvents.count(),
    h.engine.store.organizationResponses.count(),
    h.engine.store.severities.count(),
  ]);
  await recommend(h.engine, conclusion, world.admin);
  const after = await Promise.all([
    h.engine.store.experiences.count(),
    h.engine.store.corroborations.count(),
    h.engine.store.resolutionEvents.count(),
    h.engine.store.organizationResponses.count(),
    h.engine.store.severities.count(),
  ]);
  assert.deepEqual(after, before, 'E1–E11 is untouched');
  assert.equal(recommendationMutatesGovernedState(), false);
});

// ── P59 action plans ──────────────────────────────────────────────────────
test('a plan needs an approved proposal, and executes each step through the owning engine', async () => {
  const world = await seed();
  const { h } = world;
  const proposalId = await approvedProposal(world);

  const plan = expect(
    await createPlan(
      h.engine,
      {
        proposalId,
        steps: [
          { command: 'case.open', targetEngine: 'E9', input: { organizationId: 'org_1', experienceId: world.experienceIds[0] } },
          {
            command: 'case.transition',
            targetEngine: 'E9',
            input: { caseId: `case:org_1:${world.experienceIds[0]}`, to: 'triaged' },
          },
        ],
      },
      world.staff.actor,
    ),
    'create plan',
  );
  assert.equal(plan.status, 'pending');
  assert.equal(plan.stepCount, 2);

  // Executed as the org staff, who may do both of these.
  const executed = expect(await executePlan(h.engine, plan.id, world.staff.actor), 'execute');
  assert.equal(executed.plan.status, 'completed');
  assert.equal(executed.plan.dispatchedCount, 2);
  assert.ok(executed.outcomes.every((outcome) => outcome.dispatched));

  // And the effect belongs to E9, which actually has the case.
  const organizationCase = await h.engine.store.organizationCases.get(`case:org_1:${world.experienceIds[0]}`);
  assert.equal(organizationCase?.state, 'triaged', 'the owning engine did the work');
});

test('a plan against an unapproved proposal is refused', async () => {
  const world = await seed();
  const created = expect(
    await world.h.engine.bus.dispatch<unknown, { proposalId: string }>({
      name: 'proposal.create',
      input: {
        proposalType: 'recurring_failure',
        sourceEngine: 'E12',
        targetEngine: 'E9',
        subjectId: world.clusterId,
        summary: 'A recommendation nobody has decided',
        rationale: 'Drawn from six accounts sharing a confirmed entity and issue type.',
        confidence: 0.8,
        evidenceRefs: [{ kind: 'cluster', id: world.clusterId }],
      },
      actor: world.admin,
      idempotencyKey: world.h.nextKey(),
    }),
    'create proposal',
  );

  const refused = await createPlan(
    world.h.engine,
    { proposalId: created.proposalId, steps: [{ command: 'case.open', targetEngine: 'E9', input: {} }] },
    world.staff.actor,
  );
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.error.code, 'proposal_not_approved');
});

test('a step the reviewer may not perform is refused, and the plan says so', async () => {
  // The failure test the phase names: unauthorized action step. The plan is approved
  // and its second step is admin-only, so executing as org staff must refuse that step
  // rather than run it under the engine's privilege.
  const world = await seed();
  const { h } = world;
  const proposalId = await approvedProposal(world);

  const plan = expect(
    await createPlan(
      h.engine,
      {
        proposalId,
        steps: [
          { command: 'case.open', targetEngine: 'E9', input: { organizationId: 'org_1', experienceId: world.experienceIds[0] } },
          { command: 'governance.grantRole', targetEngine: 'E4', input: { actorId: world.staff.actorId, role: 'admin' } },
        ],
      },
      world.staff.actor,
    ),
    'create plan',
  );

  const executed = expect(await executePlan(h.engine, plan.id, world.staff.actor), 'execute');
  assert.equal(executed.plan.status, 'partially_completed', 'partial is a normal outcome');
  assert.equal(executed.plan.dispatchedCount, 1);
  assert.equal(executed.outcomes[0]?.dispatched, true);
  assert.equal(executed.outcomes[1]?.dispatched, false);
  assert.match(executed.outcomes[1]?.error ?? '', /policy_insufficient_role/);

  // And the privilege was not granted.
  const staffActor = await h.engine.store.actors.get(world.staff.actorId);
  assert.notEqual(staffActor?.role, 'admin', 'a plan cannot launder privilege past the policy matrix');

  const stored = await planWithSteps(h.engine, plan.id);
  assert.equal(stored?.steps[1]?.dispatched, false);
  assert.ok(stored?.steps[1]?.dispatchError, 'the refusal is recorded verbatim');
});

test('a plan whose every step is refused has failed, and changed nothing', async () => {
  const world = await seed();
  const { h } = world;
  const proposalId = await approvedProposal(world);

  const plan = expect(
    await createPlan(
      h.engine,
      {
        proposalId,
        steps: [
          // The admin is not a member of this organization, so both are refused.
          { command: 'case.open', targetEngine: 'E9', input: { organizationId: 'org_1', experienceId: world.experienceIds[0] } },
          {
            command: 'organization.respond',
            targetEngine: 'E9',
            input: { organizationId: 'org_1', experienceId: world.experienceIds[0], kind: 'acknowledge', body: 'Looking into it' },
          },
        ],
      },
      world.admin,
    ),
    'create plan',
  );

  const executed = expect(await executePlan(h.engine, plan.id, world.admin), 'execute');
  assert.equal(executed.plan.status, 'failed');
  assert.equal(executed.plan.dispatchedCount, 0);
  assert.equal(await h.engine.store.organizationCases.count(), 0, 'no case was opened');
  assert.equal(await h.engine.store.organizationResponses.count(), 0, 'and nothing was said');
});

test('one plan per proposal, and executing it twice does not run it twice', async () => {
  const world = await seed();
  const { h } = world;
  const proposalId = await approvedProposal(world);
  const steps = [
    { command: 'case.open', targetEngine: 'E9', input: { organizationId: 'org_1', experienceId: world.experienceIds[0] } },
  ];

  const plan = expect(await createPlan(h.engine, { proposalId, steps }, world.staff.actor), 'create');
  const second = await createPlan(h.engine, { proposalId, steps }, world.staff.actor);
  assert.equal(second.ok, false, 'one plan per proposal');
  assert.equal(!second.ok && second.error.code, 'plan_exists');

  expect(await executePlan(h.engine, plan.id, world.staff.actor), 'execute');
  const again = await executePlan(h.engine, plan.id, world.staff.actor);
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.error.code, 'plan_already_executed');
});

test('six callers executing one plan at once run its steps once', async () => {
  const world = await seed();
  const { h } = world;
  const proposalId = await approvedProposal(world);
  const plan = expect(
    await createPlan(
      h.engine,
      {
        proposalId,
        steps: [
          { command: 'case.open', targetEngine: 'E9', input: { organizationId: 'org_1', experienceId: world.experienceIds[0] } },
        ],
      },
      world.staff.actor,
    ),
    'create',
  );

  const results = await Promise.all(
    Array.from({ length: 6 }, () => executePlan(h.engine, plan.id, world.staff.actor)),
  );
  assert.equal(results.filter((result) => result.ok).length, 1, 'exactly one caller executed it');
  assert.equal(await h.engine.store.organizationCases.count(), 1, 'and the step ran once');
});

test('a plan writes to no governed table itself', async () => {
  const world = await seed();
  assert.equal(planMutatesGovernedState(), false);
  // The AI direct-mutation attempt, stated structurally: the only way a step becomes a
  // change is a command on the bus, and a command that does not exist changes nothing.
  const proposalId = await approvedProposal(world);
  const plan = expect(
    await createPlan(
      world.h.engine,
      { proposalId, steps: [{ command: 'experiences.update', targetEngine: 'E1', input: { status: 'published' } }] },
      world.admin,
    ),
    'create',
  );
  const executed = expect(await executePlan(world.h.engine, plan.id, world.admin), 'execute');
  assert.equal(executed.plan.status, 'failed');
  assert.match(executed.outcomes[0]?.error ?? '', /command_not_registered/);
});

// ── Phase 89: approval is not a standing authorization ───────────────────
test('a step appended after approval is refused, and the plan runs nothing', async () => {
  // **The assertion Phase 59 was missing.** `createPlan` records `stepCount`, and
  // `executePlan` read the steps from the table at execution time without ever comparing the
  // two — so a row inserted into `action_plan_steps` after approval was simply executed.
  //
  // Not privilege escalation: every step still dispatches as the reviewer, so an appended step
  // faces the same authorization the reviewer would. It is *scope* escalation, which is the
  // thing "approval is not a standing authorization" is a sentence about — a step the reviewer
  // never saw, run under their name, inside their existing rights.
  const world = await seed();
  const { h } = world;
  const proposalId = await approvedProposal(world);
  const plan = expect(
    await createPlan(
      h.engine,
      {
        proposalId,
        steps: [
          { command: 'case.open', targetEngine: 'E9', input: { organizationId: 'org_1', experienceId: world.experienceIds[0] } },
        ],
      },
      world.staff.actor,
    ),
    'create',
  );
  assert.equal(plan.stepCount, 1, 'the approval covered one step');

  await h.engine.store.actionPlanSteps.put({
    id: `${plan.id}:2`,
    planId: plan.id,
    stepOrder: 2,
    command: 'organization.respond',
    input: { organizationId: 'org_1', experienceId: world.experienceIds[0], kind: 'acknowledge', body: 'Appended.' },
    targetEngine: 'E9',
    dispatched: false,
  });

  const executed = await executePlan(h.engine, plan.id, world.staff.actor);
  assert.equal(executed.ok, false, 'the plan is refused whole');
  assert.equal(!executed.ok && executed.error.code, 'plan_steps_changed');

  // Refused *whole*, not partially: running step one and refusing step two would mean the
  // appended row decided that step one happened, which is the tampering having an effect.
  assert.equal(await h.engine.store.organizationCases.count(), 0, 'nothing was dispatched at all');
  const after = await h.engine.store.actionPlans.get(plan.id);
  assert.equal(after?.status, 'pending', 'and the plan is still awaiting a legitimate execution');
});

test('a step removed after approval is refused too, for the same reason', async () => {
  // The count is what is pinned, so removal is caught by the same check. Worth asserting
  // separately: a plan whose steps were *reduced* would otherwise execute a subset and report
  // `succeeded`, which is a plan reporting that it did something it did not do.
  const world = await seed();
  const { h } = world;
  const proposalId = await approvedProposal(world);
  const plan = expect(
    await createPlan(
      h.engine,
      {
        proposalId,
        steps: [
          { command: 'case.open', targetEngine: 'E9', input: { organizationId: 'org_1', experienceId: world.experienceIds[0] } },
          { command: 'case.assign', targetEngine: 'E9', input: { caseId: 'case_absent', assigneeId: world.staff.actorId } },
        ],
      },
      world.staff.actor,
    ),
    'create',
  );
  assert.equal(plan.stepCount, 2);

  await h.engine.store.actionPlanSteps.remove(`${plan.id}:2`);

  const executed = await executePlan(h.engine, plan.id, world.staff.actor);
  assert.equal(executed.ok, false);
  assert.equal(!executed.ok && executed.error.code, 'plan_steps_changed');
  assert.equal(await h.engine.store.organizationCases.count(), 0);
});
