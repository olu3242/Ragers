import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { connectionsOf, relationshipGraphFor } from '../../src/engines/relationship.engine.ts';
import { memoryFor } from '../../src/engines/memory.engine.ts';
import { forbiddenMemoryKeysIn } from '../../src/domain/memory.ts';
import { patternHistoryFor } from '../../src/engines/history.engine.ts';
import { clusterLifecycleFor } from '../../src/engines/lifecycle.engine.ts';
import { reputationEvolutionFor } from '../../src/engines/evolution.engine.ts';
import { conclusionsFor, recommend, recommendationsFor } from '../../src/engines/conclusion.engine.ts';
import { createPlan, executePlan } from '../../src/engines/plan.engine.ts';
import { degreeOf } from '../../src/domain/relationship.ts';
import { resolutionSummaryFor } from '../../src/engines/resolution.engine.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { ExperienceKind } from '../../src/domain/types.ts';

/**
 * Phase 60 — the experience loop, certified end to end, for a Rage and again for a Rave.
 *
 * The lap this band adds to the one Phase 50 already certifies:
 *
 *   a second experience arrives → it is *connected* to the first → the pattern's signal
 *   is live → the organization's history moves → the contributors' reputation evolves →
 *   a conclusion is drawn across the experiences → it is recommended once → a reviewer
 *   approves → a plan executes through the engines that own each step → and the
 *   distinctions all survive.
 *
 * Run twice on purpose. A band that only holds its rules for complaints has not held
 * them: a Rave is corroborated, clustered, measured and concluded about by exactly the
 * same code, and the Rave lap is where an assumption that "a pattern" means "a problem"
 * would show up.
 *
 * What each assertion is defending is named where it is made, because a certification
 * test whose failures cannot be read is a certification test somebody will delete.
 */
const DAY = 86_400_000;

interface Lap {
  readonly h: EngineHarness;
  readonly kind: ExperienceKind;
  readonly clusterId: string;
  readonly experienceIds: readonly string[];
  readonly contributorIds: readonly string[];
  readonly organizationId: string;
  readonly staff: ActorContext;
  readonly staffId: string;
  readonly reviewer: ActorContext;
}

/** One full lap of the loop. Returns what it produced, so assertions read as a narrative. */
const lap = async (kind: ExperienceKind): Promise<Lap> => {
  const h = createEngineHarness();
  await h.engine.store.entities.put({
    id: 'ent_1',
    name: 'Northwind Air',
    slug: 'northwind-air',
    kind: 'organization',
  });
  await h.engine.store.entityAliases.put({ id: 'ali_1', entityId: 'ent_1', alias: 'Northwind Air' });
  await h.engine.store.categories.put({ id: 'cat_1', name: 'Shopping & service', slug: 'shopping-service' });
  await h.engine.store.issueTypes.put({
    id: 'iss_1',
    categoryId: 'cat_1',
    name: kind === 'rage' ? 'Refund not processed' : 'Fixed on the first visit',
    slug: 'the-issue',
  });

  const staffSignUp = await h.signUp(`staff-${kind}@example.com`, 'Staff');
  const reviewer = await h.promote((await h.signUp(`mod-${kind}@example.com`)).auth.actorId, 'moderator');
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

  // Six people, six accounts of one thing — enough to clear the reporting floor, which
  // is what makes every measure in this band expressible at all.
  const experienceIds: string[] = [];
  const contributorIds: string[] = [];
  let clusterId = '';
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const person = await h.signUp(`${name}-${kind}@example.com`, name);
    contributorIds.push(person.auth.actorId);
    const created = expect(
      await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
        name: 'experience.create',
        input: {
          kind,
          creationMode: 'text',
          category: 'Shopping & service',
          bodyText:
            kind === 'rage'
              ? `Account ${name}: the refund was promised and never arrived`
              : `Account ${name}: the engineer stayed late and fixed it properly`,
          visibility: 'public',
        },
        actor: person.actor,
        idempotencyKey: h.nextKey(),
      }),
      'create',
    );
    await h.settle();
    // Structure comes from confirmation, never from extraction — which is what puts
    // these six in one cluster rather than six wordings looking similar.
    expect(
      await h.engine.bus.dispatch({
        name: 'normalization.confirm',
        input: {
          experienceId: created.experienceId,
          fields: { entity: 'ent_1', category: 'cat_1', issueType: 'iss_1' },
        },
        actor: person.actor,
        idempotencyKey: h.nextKey(),
      }),
      'confirm',
    );
    await h.settle();
    experienceIds.push(created.experienceId);
    clusterId = (await h.engine.store.experiences.get(created.experienceId))?.clusterId ?? clusterId;
    h.clock.advance(DAY);
  }

  assert.ok(clusterId, `${kind}: the accounts share a cluster`);
  return {
    h,
    kind,
    clusterId,
    experienceIds,
    contributorIds,
    organizationId: 'org_1',
    staff: staffSignUp.actor,
    staffId: staffSignUp.auth.actorId,
    reviewer,
  };
};

const certifyLoop = async (kind: ExperienceKind): Promise<void> => {
  const it = await lap(kind);
  const { h } = it;
  const first = it.experienceIds[0] as string;

  // ── The second experience is connected to the first ─────────────────────
  const connections = await connectionsOf(h.engine, first);
  assert.equal(connections.length, 5, `${kind}: connected to the other five`);
  assert.ok(
    connections.every((connection) => connection.trustWeight === 0),
    `${kind}: a connection is discovery, never corroboration`,
  );

  // Assert one of the pairs by hand as well. A second route is one more reason, not
  // one more edge — `cluster != signal` has an analogue here: routes are not weight.
  expect(
    await h.engine.bus.dispatch({
      name: 'relation.assert',
      input: { fromExperienceId: first, toExperienceId: it.experienceIds[1], assertion: 'same_pattern' },
      actor: it.reviewer,
      idempotencyKey: h.nextKey(),
    }),
    'relate',
  );
  await h.settle();
  const graph = await relationshipGraphFor(h.engine, first);
  assert.equal(degreeOf(graph, first), 5, `${kind}: the degree did not double`);

  // ── The experience remembers its own history, and names nobody ──────────
  const memory = await memoryFor(h.engine, first);
  assert.ok(memory, `${kind}: there is a memory`);
  assert.deepEqual(forbiddenMemoryKeysIn(memory), [], `${kind}: no person and no prose`);
  const serialisedMemory = JSON.stringify(memory);
  for (const actorId of it.contributorIds) {
    assert.ok(!serialisedMemory.includes(actorId), `${kind}: no contributor is named in a memory`);
  }

  // ── The signal is live, and the lifecycle says so ───────────────────────
  const live = await clusterLifecycleFor(h.engine, it.clusterId);
  assert.equal(live?.lifecycle.state, 'active', `${kind}: people are reporting it`);
  assert.equal(live?.lifecycle.current, true);
  assert.equal(live?.uniqueExperiencers, 6, `${kind}: six people, not six rows`);

  // ── The organization's history has a point in it ────────────────────────
  const history = await patternHistoryFor(h.engine, it.organizationId, { periods: 3 });
  assert.ok(history, `${kind}: the organization has a history`);
  const latestVolume = history.volume.points.at(-1);
  assert.equal(latestVolume?.aggregate.suppressed, false, `${kind}: six people clears the person floor`);

  // ── Reputation evolves, and is still not a score ────────────────────────
  const evolution = await reputationEvolutionFor(h.engine, it.contributorIds[0] as string, { periods: 3 });
  assert.ok(evolution, `${kind}: the contributor has an evolution`);
  assert.equal(
    evolution.counts.find((series) => series.component === 'experiences_published')?.points.at(-1)?.value,
    1,
  );
  assert.ok(
    !JSON.stringify(evolution).includes('score'),
    `${kind}: reputation != popularity, and there is still no single number`,
  );

  // ── A conclusion is drawn across the experiences ────────────────────────
  const conclusions = await conclusionsFor(h.engine, it.clusterId);
  assert.equal(conclusions.length, 1, `${kind}: one conclusion — a recurring pattern`);
  const [conclusion] = conclusions;
  assert.ok(conclusion);
  assert.equal(conclusion.distinctPeople, 6);
  assert.ok(conclusion.basis.length > 0, `${kind}: the conclusion is evidence-backed`);

  // ── Recommended once, however often the sweep runs ──────────────────────
  const recommended = await recommend(h.engine, conclusion, it.reviewer);
  assert.equal(recommended.created, true);
  const again = await recommend(h.engine, conclusion, it.reviewer);
  assert.equal(again.created, false, `${kind}: the same finding is not recommended twice`);
  assert.equal((await recommendationsFor(h.engine, it.clusterId)).length, 1);

  const proposalId = recommended.row.proposalId;
  assert.ok(proposalId, `${kind}: the recommendation produced a proposal`);

  // A recommendation is not a decision: nothing has happened yet.
  const proposal = await h.engine.store.proposals.get(proposalId);
  assert.equal(proposal?.status, 'proposed', `${kind}: recommendation != decision`);

  // ── A reviewer decides, and a decision is not yet an effect ─────────────
  expect(
    await h.engine.bus.dispatch({
      name: 'proposal.decide',
      input: { proposalId, outcome: 'approved' },
      actor: it.reviewer,
      idempotencyKey: h.nextKey(),
    }),
    'approve',
  );
  await h.settle();
  assert.equal(
    await h.engine.store.organizationCases.count(),
    0,
    `${kind}: decision != effect — approving the recommendation opened no case`,
  );

  // ── The plan executes through the engines that own each step ────────────
  const plan = expect(
    await createPlan(
      h.engine,
      {
        proposalId,
        steps: [
          { command: 'case.open', targetEngine: 'E9', input: { organizationId: it.organizationId, experienceId: first } },
          {
            command: 'case.transition',
            targetEngine: 'E9',
            input: { caseId: `case:${it.organizationId}:${first}`, to: 'in_progress' },
          },
        ],
      },
      it.staff,
    ),
    'create plan',
  );
  const executed = expect(await executePlan(h.engine, plan.id, it.staff), 'execute plan');
  assert.equal(executed.plan.status, 'completed', `${kind}: both steps dispatched`);

  // The effect belongs to E9, which is the engine that owns cases.
  const organizationCase = await h.engine.store.organizationCases.get(`case:${it.organizationId}:${first}`);
  assert.equal(organizationCase?.state, 'in_progress', `${kind}: the owning engine did the work`);

  // ── And nothing in the loop resolved anything ──────────────────────────
  const outcome = await resolutionSummaryFor(h.engine, first);
  assert.notEqual(outcome?.status, 'resolved', `${kind}: response != resolution, all the way round the loop`);
  const experience = await h.engine.store.experiences.get(first);
  assert.equal(experience?.status, 'published', `${kind}: and the account is still standing`);

  // ── The loop closes: a seventh account joins the same pattern ──────────
  const late = await h.signUp(`late-${kind}@example.com`, 'Late');
  const seventh = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: {
        kind,
        creationMode: 'text',
        category: 'Shopping & service',
        bodyText:
          kind === 'rage'
            ? 'Account g: the refund was promised and never arrived'
            : 'Account g: the engineer stayed late and fixed it properly',
        visibility: 'public',
      },
      actor: late.actor,
      idempotencyKey: h.nextKey(),
    }),
    'seventh',
  );
  await h.settle();
  expect(
    await h.engine.bus.dispatch({
      name: 'normalization.confirm',
      input: { experienceId: seventh.experienceId, fields: { entity: 'ent_1', category: 'cat_1', issueType: 'iss_1' } },
      actor: late.actor,
      idempotencyKey: h.nextKey(),
    }),
    'confirm seventh',
  );
  await h.settle();

  assert.equal(
    (await h.engine.store.experiences.get(seventh.experienceId))?.clusterId,
    it.clusterId,
    `${kind}: the seventh account joined the same pattern`,
  );
  assert.equal(
    (await connectionsOf(h.engine, seventh.experienceId)).length,
    6,
    `${kind}: and is connected to the six before it`,
  );
  const grown = await clusterLifecycleFor(h.engine, it.clusterId);
  assert.equal(grown?.uniqueExperiencers, 7, `${kind}: seven people now`);
  assert.equal(grown?.lifecycle.state, 'active');

  // The conclusion is now about a different set, so it is a *different* conclusion and
  // recommending it is not a duplicate. This is the line between "say it once" and
  // "never say it again", and getting it wrong in either direction is a real failure.
  const grownConclusions = await conclusionsFor(h.engine, it.clusterId);
  const [grownConclusion] = grownConclusions;
  assert.ok(grownConclusion);
  assert.equal(grownConclusion.distinctPeople, 7);
  const fresh = await recommend(h.engine, grownConclusion, it.reviewer);
  assert.equal(fresh.created, true, `${kind}: a conclusion about seven accounts is a new conclusion`);
  assert.notEqual(fresh.row.id, recommended.row.id);

  // ── Time passes, and the signal stops being current ────────────────────
  h.clock.advance(60 * DAY);
  const stale = await clusterLifecycleFor(h.engine, it.clusterId);
  assert.equal(stale?.lifecycle.current, false, `${kind}: signal != permanent truth`);
  assert.equal(
    stale?.weight.contributionCount,
    grown?.weight.contributionCount,
    `${kind}: and the historical record is all still there`,
  );
};

test('the experience loop closes for a Rage, with every distinction intact', async () => {
  await certifyLoop('rage');
});

test('the experience loop closes for a Rave, with every distinction intact', async () => {
  await certifyLoop('rave');
});

test('nothing in the loop can reach an E1–E11 table except through the bus', async () => {
  // The AI direct-mutation attempt, asserted over the band's own modules rather than
  // one of them: every write in phases 51–59 is either to this band's own two tables or
  // is a command dispatched on the bus. Stated as a structural sweep because the failure
  // mode is a future edit, not today's code.
  const { readFileSync } = await import('node:fs');
  const modules = [
    'src/engines/relationship.engine.ts',
    'src/engines/memory.engine.ts',
    'src/engines/history.engine.ts',
    'src/engines/lifecycle.engine.ts',
    'src/engines/evolution.engine.ts',
    'src/engines/conclusion.engine.ts',
    'src/engines/plan.engine.ts',
  ];
  /** The band's own tables, plus the ledger. Everything else is somebody else's. */
  const OWN_TABLES = new Set(['recommendations', 'actionPlans', 'actionPlanSteps']);

  const violations: string[] = [];
  for (const path of modules) {
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/store\.([A-Za-z]+)\.(put|remove|compareAndSet)\b/g)) {
      const table = match[1] as string;
      if (!OWN_TABLES.has(table)) violations.push(`${path} writes to ${table}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `phases 51–59 write only to their own tables; everything else goes through a command:\n${violations.join('\n')}`,
  );
});
