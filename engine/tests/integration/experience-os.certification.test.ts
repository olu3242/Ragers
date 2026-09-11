import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { eq } from '../../src/ports/store.ts';
import { discover, searchContextually } from '../../src/engines/discovery.engine.ts';
import { discoverForActor } from '../../src/engines/relevance.engine.ts';
import { confidenceFor } from '../../src/engines/confidence.engine.ts';
import { resolutionQualityFor } from '../../src/engines/quality.engine.ts';
import { runAgent } from '../../src/engines/agent.engine.ts';
import { createPlan, executePlan } from '../../src/engines/plan.engine.ts';
import { provenanceFor } from '../../src/engines/provenance.engine.ts';
import { answerOperatorQuestions, readiness, OPERATOR_QUESTIONS, ANSWERED_BY } from '../../src/engines/observability.engine.ts';
import { createDeterministicAssistanceProvider } from '../../src/adapters/fakes.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { ExperienceKind } from '../../src/domain/types.ts';

/**
 * Phase 100 — the final Experience OS certification.
 *
 * The whole circle, for a **Rage** and again for a **Rave**:
 *
 * ```
 * experience → capture → declaration → trust → publish → discovery → corroboration → cluster
 *   → signal → response → outcome → quality → intelligence → recommendation → approval
 *   → governed action → effect → follow-up
 * ```
 *
 * Plus the eight scenarios that are each a way the circle could hold in the happy case and break
 * where it matters: a blocked user, a moderation removal, an unavailable provider, degraded mode,
 * an approved-but-refused action, a partial plan failure, a restart with replay, and duplicate-effect
 * prevention.
 *
 * The Rave lap is not symmetry for its own sake. A system that only holds its rules for complaints
 * has not held them, and every band in this codebase has found something in the Rave lap that the
 * Rage lap missed — an assumption that "a pattern" means "a problem", or that "quality" means "how
 * badly it went".
 */
interface World {
  readonly h: EngineHarness;
  readonly authors: readonly { readonly actor: ActorContext; readonly actorId: string }[];
  readonly staff: { readonly actor: ActorContext; readonly actorId: string };
  readonly admin: ActorContext;
  readonly experienceIds: readonly string[];
}

const seed = async (kind: ExperienceKind, confidence = 0.8): Promise<World> => {
  const h = createEngineHarness({
    providers: { assistance: createDeterministicAssistanceProvider({ confidence }) },
  });
  await h.engine.store.entities.put({ id: 'ent_1', name: 'Northwind Air', slug: 'northwind-air', kind: 'organization' });
  await h.engine.store.entityAliases.put({ id: 'ali_1', entityId: 'ent_1', alias: 'Northwind Air' });
  await h.engine.store.categories.put({ id: 'cat_1', name: 'Shopping & service', slug: 'shopping-service' });
  await h.engine.store.issueTypes.put({
    id: 'iss_1',
    categoryId: 'cat_1',
    name: 'Refund not processed',
    slug: 'refund-not-processed',
  });

  const staffSignUp = await h.signUp('staff@example.com', 'Staff');
  const admin = await h.promote((await h.signUp('admin@example.com')).auth.actorId, 'admin');
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

  const authors: { actor: ActorContext; actorId: string }[] = [];
  const experienceIds: string[] = [];
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    const person = await h.signUp(`${name}@example.com`, name);
    authors.push({ actor: person.actor, actorId: person.auth.actorId });
    const created = expect(
      await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
        name: 'experience.create',
        input: {
          kind,
          creationMode: 'text',
          category: 'Shopping & service',
          bodyText:
            kind === 'rage'
              ? `Account ${name}: the refund never arrived`
              : `Account ${name}: they sorted it the same day`,
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
  }

  return { h, authors, staff: { actor: staffSignUp.actor, actorId: staffSignUp.auth.actorId }, admin, experienceIds };
};

for (const kind of ['rage', 'rave'] as const) {
  test(`the whole Experience OS circle closes for a ${kind}`, async () => {
    const world = await seed(kind);
    const { h } = world;
    const subject = world.experienceIds[0]!;
    const author = world.authors[0]!;

    // ── publish → discovery ──────────────────────────────────────────────
    assert.equal((await discover(h.engine)).length, 5, 'five published and discoverable');
    const hits = await searchContextually(h.engine, { text: kind === 'rage' ? 'refund' : 'sorted' });
    assert.ok(hits.length > 0, 'and searchable');
    for (const hit of hits) {
      assert.equal(
        Object.keys(hit).some((key) => /actorId|authorId/.test(key)),
        false,
        'a hit carries what a public page shows and no identity',
      );
    }

    // ── corroboration → confidence, counting people ──────────────────────
    for (const person of world.authors.slice(1, 4)) {
      expect(
        await h.engine.bus.dispatch({
          name: 'corroboration.create',
          input: { experienceId: subject, type: kind === 'rage' ? 're_rage' : 're_rave' },
          actor: person.actor,
          idempotencyKey: h.nextKey(),
        }),
        'corroborate',
      );
      await h.settle();
    }
    const confidence = await confidenceFor(h.engine, subject);
    assert.equal(confidence?.independentPeople, 3, 'people, never rows');
    assert.notEqual(confidence?.band, 'insufficient');

    // ── cluster → signal ─────────────────────────────────────────────────
    const clustered = await h.engine.store.experiences.get(subject);
    assert.ok(clustered?.clusterId, 'confirmation clustered it');
    const snapshots = await h.engine.store.signalSnapshots.query([eq('clusterId', clustered.clusterId!)]);
    assert.ok(snapshots.length > 0, 'and a signal was measured');

    // ── response → outcome → quality ─────────────────────────────────────
    expect(
      await h.engine.bus.dispatch({
        name: 'organization.respond',
        input: {
          organizationId: 'org_1',
          experienceId: subject,
          kind: 'publish_resolution',
          body: 'This has been dealt with.',
        },
        actor: world.staff.actor,
        idempotencyKey: h.nextKey(),
      }),
      'respond',
    );
    await h.settle();
    // A response is not a resolution. Only the people it happened to may say it was fixed.
    assert.notEqual((await h.engine.store.experiences.get(subject))?.resolutionStatus, 'resolved');

    expect(
      await h.engine.bus.dispatch({
        name: 'resolution.report',
        input: { experienceId: subject, kind: 'resolved_for_me' },
        actor: author.actor,
        idempotencyKey: h.nextKey(),
      }),
      'report',
    );
    await h.settle();

    const quality = await resolutionQualityFor(h.engine, subject);
    assert.ok(quality);
    // `resolved` and `well resolved` remain two facts, carried side by side.
    assert.equal(typeof quality.statusResolved, 'boolean');
    assert.ok(quality.band);

    // ── intelligence → recommendation → approval → governed action ───────
    const run = await runAgent(
      h.engine,
      {
        agentId: 'resolution',
        subjectId: subject,
        proposalType: 'review_unresolved_critical',
        engine: 'E10',
        targetEngine: 'E10',
      },
      { actorId: world.admin.actorId, role: 'admin' },
    );
    assert.equal(run.outcome, 'proposed', 'an agent proposes');
    assert.ok(run.proposalId);

    const proposal = await h.engine.store.proposals.get(run.proposalId!);
    assert.equal(proposal?.proposedCommand, undefined, 'and pre-authorises nothing');

    expect(
      await h.engine.bus.dispatch({
        name: 'proposal.decide',
        input: { proposalId: run.proposalId, outcome: 'approved' },
        actor: world.admin,
        idempotencyKey: h.nextKey(),
      }),
      'approve',
    );
    await h.settle();

    // ── approved-but-refused, and `decision != effect` ───────────────────
    //
    // A step against an organization the admin does not act for. Authorization is evaluated per
    // step at execution time, so the approval is real and the effect does not follow.
    const plan = expect(
      await createPlan(
        h.engine,
        {
          proposalId: run.proposalId!,
          steps: [
            {
              command: 'organization.respond',
              targetEngine: 'E9',
              input: { organizationId: 'org_absent', experienceId: subject, kind: 'acknowledge', body: 'From a plan.' },
            },
          ],
        },
        world.admin,
      ),
      'plan',
    );
    const executed = expect(await executePlan(h.engine, plan.id, world.admin), 'execute');
    assert.equal(executed.plan.dispatchedCount, 0, 'the effect did not follow');

    const chain = await provenanceFor(h.engine, run.proposalId!);
    assert.equal(chain?.outcome, 'approved_and_refused', 'and the chain says so');
    assert.ok(chain?.links.some((link) => link.stage === 'refused' && link.refusal), 'with its reason');
    assert.equal((await h.engine.store.proposals.get(run.proposalId!))?.status, 'approved', 'the decision stands');

    // ── duplicate-effect prevention ──────────────────────────────────────
    const again = await executePlan(h.engine, plan.id, world.admin);
    assert.equal(again.ok, false, 'a plan runs once');

    // ── follow-up: a new experience about the same thing ─────────────────
    const later = await h.signUp('later@example.com');
    const followUp = expect(
      await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
        name: 'experience.create',
        input: {
          kind,
          creationMode: 'text',
          category: 'Shopping & service',
          bodyText: kind === 'rage' ? 'It happened again after they said it was fixed' : 'Same good outcome again',
          visibility: 'public',
        },
        actor: later.actor,
        idempotencyKey: h.nextKey(),
      }),
      'follow up',
    );
    await h.settle();
    assert.ok(
      (await discover(h.engine)).some((result) => result.experienceId === followUp.experienceId),
      'and the circle starts again',
    );
  });
}

// ── the eight scenarios ──────────────────────────────────────────────────
test('a blocked author reaches neither the feed nor a search hit', async () => {
  const world = await seed('rage');
  const { h } = world;
  const viewer = world.authors[0]!;
  const blocked = world.authors[1]!;
  expect(
    await h.engine.bus.dispatch({
      name: 'graph.block',
      input: { targetRef: 'actor', targetId: blocked.actorId },
      actor: viewer.actor,
      idempotencyKey: h.nextKey(),
    }),
    'block',
  );
  await h.settle();

  for (const result of await discoverForActor(h.engine, viewer.actorId)) {
    const experience = await h.engine.store.experiences.get(result.experienceId);
    assert.notEqual(experience?.actorId, blocked.actorId);
  }
  for (const hit of await searchContextually(h.engine, { text: 'refund', viewerId: viewer.actorId })) {
    const experience = await h.engine.store.experiences.get(hit.experienceId);
    assert.notEqual(experience?.actorId, blocked.actorId);
  }
});

test('a removed experience is absent everywhere before its consumer has drained', async () => {
  const world = await seed('rage');
  const { h } = world;
  const removed = world.experienceIds[0]!;
  const row = await h.engine.store.experiences.get(removed);
  assert.ok(row);
  await h.engine.store.experiences.put({ ...row, status: 'removed' });
  // Deliberately no settle(): the projections still say published, which is the window.
  assert.equal((await h.engine.store.feedEntries.get(removed))?.suppressed, false);

  assert.equal((await discover(h.engine)).some((result) => result.experienceId === removed), false);
  assert.equal(
    (await searchContextually(h.engine, { text: 'refund' })).some((hit) => hit.experienceId === removed),
    false,
  );
  assert.equal(await confidenceFor(h.engine, removed) !== undefined, true, 'the row is still readable internally');
});

test('an unavailable provider refuses one path and leaves everything else working', async () => {
  const h = createEngineHarness({
    providers: { assistance: createDeterministicAssistanceProvider({ failing: true }) },
  });
  const author = await h.signUp('a@example.com');
  const admin = await h.promote((await h.signUp('admin@example.com')).auth.actorId, 'admin');
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: 'the lift is broken again', visibility: 'public' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();

  const run = await runAgent(
    h.engine,
    { agentId: 'resolution', subjectId: created.experienceId, proposalType: 'review_unresolved_critical', engine: 'E10', targetEngine: 'E10' },
    { actorId: admin.actorId, role: 'admin' },
  );
  assert.equal(run.outcome, 'provider_unavailable');
  // The rest of the product is untouched: publishing, discovery and corroboration all still work.
  assert.equal((await discover(h.engine)).length, 1);
  assert.equal(await h.engine.store.proposals.count(), 0, 'and no proposal with nothing behind it');
});

test('degraded mode changes the reading and no refusal', async () => {
  const world = await seed('rage');
  const { h } = world;
  expect(
    await h.engine.bus.dispatch({
      name: 'control.enterDegradedMode',
      input: { target: 'runtime', reason: 'the model is answering and its answers are wrong' },
      actor: world.admin,
      idempotencyKey: h.nextKey(),
    }),
    'degrade',
  );
  await h.settle();

  // Everything a person can do, they can still do. An operator declaring degraded mode is telling
  // the team something the checks cannot see, not asking for things to start failing.
  assert.equal((await discover(h.engine)).length, 5);
  expect(
    await h.engine.bus.dispatch({
      name: 'corroboration.create',
      input: { experienceId: world.experienceIds[0], type: 're_rage' },
      actor: world.authors[1]!.actor,
      idempotencyKey: h.nextKey(),
    }),
    'still works',
  );

  // And the reading says so, and readiness refuses rotation.
  const answers = await answerOperatorQuestions(h.engine);
  assert.ok(answers.degraded.some((entry) => entry.detail.includes('force_degraded_mode')));
  const ready = await readiness(h.engine);
  assert.equal(ready.ready, false, 'a declared degraded instance is not in rotation');
  assert.ok(ready.checks.some((check) => check.name === 'not_forced_degraded' && !check.ok));
});

test('a partial plan failure stays partial', async () => {
  const world = await seed('rage');
  const { h } = world;
  const subject = world.experienceIds[0]!;
  const created = expect(
    await h.engine.bus.dispatch<unknown, { proposalId: string }>({
      name: 'proposal.create',
      input: {
        proposalType: 'review_unresolved_critical',
        sourceEngine: 'E12',
        targetEngine: 'E9',
        subjectId: subject,
        summary: 'Somebody should look',
        rationale: 'Unresolved for weeks.',
        confidence: 0.8,
        evidenceRefs: [{ kind: 'experience', id: subject }],
      },
      actor: world.admin,
      idempotencyKey: h.nextKey(),
    }),
    'propose',
  );
  expect(
    await h.engine.bus.dispatch({
      name: 'proposal.decide',
      input: { proposalId: created.proposalId, outcome: 'approved' },
      actor: world.admin,
      idempotencyKey: h.nextKey(),
    }),
    'approve',
  );
  await h.settle();

  // One step that works and one that cannot. Partial is a normal outcome, not an error:
  // authorization is evaluated per step at execution time.
  //
  // Executed as the **organization's own member**, not the admin. `case.open` requires membership
  // of the organization — being an admin is not being a member of somebody's business — so an
  // admin-executed plan would have had *both* steps refused and proved nothing about partiality.
  // The refusal is correct and it is the reason this reviewer is the staff member.
  const plan = expect(
    await createPlan(
      h.engine,
      {
        proposalId: created.proposalId,
        steps: [
          { command: 'case.open', targetEngine: 'E9', input: { organizationId: 'org_1', experienceId: subject } },
          { command: 'case.assign', targetEngine: 'E9', input: { caseId: 'case_absent', assigneeId: world.staff.actorId } },
        ],
      },
      world.staff.actor,
    ),
    'plan',
  );
  const executed = expect(await executePlan(h.engine, plan.id, world.staff.actor), 'execute');
  assert.equal(executed.outcomes.filter((outcome) => outcome.dispatched).length, 1, 'one ran');
  assert.equal(executed.outcomes.filter((outcome) => !outcome.dispatched).length, 1, 'one did not');
  assert.equal(executed.plan.status, 'partially_completed');
  assert.equal(await h.engine.store.organizationCases.count(), 1, 'and the step that ran stands');
});

test('a restart replays without duplicating an effect', async () => {
  const world = await seed('rage');
  const { h } = world;
  const subject = world.experienceIds[0]!;
  expect(
    await h.engine.bus.dispatch({
      name: 'corroboration.create',
      input: { experienceId: subject, type: 're_rage' },
      actor: world.authors[1]!.actor,
      idempotencyKey: h.nextKey(),
    }),
    'corroborate',
  );
  await h.settle();

  const countersBefore = await h.engine.store.counters.get(subject);
  const confidenceBefore = await confidenceFor(h.engine, subject);
  const seriesBefore = await h.engine.store.confidencePoints.query([eq('subjectId', subject)]);

  // Re-deliver everything, exactly as a restart with an un-acked queue would. Nothing here may
  // increment, re-decide or append.
  for (const record of await h.engine.deliveries.all()) {
    await h.engine.deliveries.put({ ...record, state: 'queued', attemptCount: 0 });
  }
  await h.settle();

  assert.deepEqual(await h.engine.store.counters.get(subject), countersBefore, 'no counter moved');
  assert.deepEqual(await confidenceFor(h.engine, subject), confidenceBefore, 'confidence is unchanged');
  assert.equal(
    (await h.engine.store.confidencePoints.query([eq('subjectId', subject)])).length,
    seriesBefore.length,
    'and the append-only series gained nothing',
  );
});

test('every operator question is answered by something, and readiness is not health', async () => {
  const world = await seed('rage');
  const { h } = world;
  const answers = await answerOperatorQuestions(h.engine);

  for (const question of OPERATOR_QUESTIONS) {
    assert.ok(ANSWERED_BY[question], `${question} is bound to a field`);
  }
  assert.equal(Object.keys(ANSWERED_BY).length, OPERATOR_QUESTIONS.length, 'and nothing is unbound');
  assert.equal(typeof answers.generatedAt, 'number');

  // A healthy system with a worker registered is ready; health alone would say yes to an instance
  // whose projections nothing advances.
  await h.engine.workers.register({ id: 'w1', hostname: 'test', now: h.clock.now() });
  const ready = await readiness(h.engine);
  assert.equal(ready.ready, true);
  // RC3 added four deployment checks. This call passes no deployment facts, which is how a local
  // process and the test suite are treated — the checks that depend on being hosted report as
  // satisfied while still saying what they found. The list is asserted in full so a check added
  // later has to be considered here rather than appearing silently.
  assert.deepEqual(
    ready.checks.map((check) => check.name).sort(),
    ['not_forced_degraded', 'object_storage', 'persistent_store', 'providers', 'sign_in', 'store', 'worker'],
  );
});
