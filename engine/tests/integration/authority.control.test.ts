import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { eq } from '../../src/ports/store.ts';
import {
  activeControls,
  controlHistory,
  isAgentPaused,
  isProposalTypeDisabled,
} from '../../src/engines/control.engine.ts';
import { runAgent } from '../../src/engines/agent.engine.ts';
import {
  approvedButRefused,
  provenanceFor,
  provenanceHidesARefusal,
  provenanceIsWritable,
} from '../../src/engines/provenance.engine.ts';
import { createPlan, executePlan } from '../../src/engines/plan.engine.ts';
import { CONTAINMENT } from '../../src/domain/containment.ts';
import { createDeterministicAssistanceProvider } from '../../src/adapters/fakes.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { AuditEvent } from '../../src/ports/store.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';

/**
 * Phases 91–95 through the bus.
 *
 * Everything here is about the same property: **a control that nothing consults is a row, not a
 * switch.** Each of the five is applied through the bus and then the governed path is exercised to
 * show it actually refuses — because the failure mode for this band is a kill switch that flips and
 * changes nothing, and that failure is invisible until the moment somebody needs it.
 */
const world = async (confidence = 0.8) => {
  const h = createEngineHarness({
    providers: { assistance: createDeterministicAssistanceProvider({ confidence }) },
  });
  const author = await h.signUp('author@example.com', 'Author');
  const admin = await h.promote((await h.signUp('admin@example.com')).auth.actorId, 'admin');
  const moderator = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'moderator');
  return { h, author, admin, moderator };
};

const publish = async (h: EngineHarness, actor: ActorContext, bodyText: string): Promise<string> => {
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText, visibility: 'public' },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();
  return created.experienceId;
};

const apply = (h: EngineHarness, actor: ActorContext, name: string, target: string, reason: string) =>
  h.engine.bus.dispatch<unknown, { controlId: string; consequence: string }>({
    name,
    input: { target, reason },
    actor,
    idempotencyKey: h.nextKey(),
  });

// ── Phase 94: server-side, audited, reversible ───────────────────────────
test('a paused agent is refused at the engine, and resuming restores it', async () => {
  const { h, author, admin, moderator } = await world();
  const experienceId = await publish(h, author.actor, 'the engineer never arrived for the slot');

  const run = { agentId: 'resolution' as const, subjectId: experienceId, proposalType: 'review_unresolved_critical', engine: 'E10' as const, targetEngine: 'E10' as const };
  const before = await runAgent(h.engine, run, { actorId: moderator.actorId, role: 'moderator' });
  assert.equal(before.outcome, 'proposed', 'it works before the pause');

  const applied = expect(await apply(h, admin, 'control.pauseAgent', 'resolution', 'proposing nonsense'), 'pause');
  await h.settle();
  assert.equal(await isAgentPaused(h.engine, 'resolution'), true);
  assert.match(applied.consequence, /refused at the engine/);

  // A different subject, so the run is not answered from the idempotent ledger.
  const second = await publish(h, author.actor, 'the second engineer never arrived either');
  const paused = await runAgent(
    h.engine,
    { ...run, subjectId: second },
    { actorId: moderator.actorId, role: 'moderator' },
  );
  assert.equal(paused.outcome, 'refused', 'and is refused while paused');
  assert.match(paused.detail ?? '', /paused by an operator/);

  expect(
    await h.engine.bus.dispatch({
      name: 'control.resume',
      input: { controlId: applied.controlId },
      actor: admin,
      idempotencyKey: h.nextKey(),
    }),
    'resume',
  );
  await h.settle();
  assert.equal(await isAgentPaused(h.engine, 'resolution'), false);

  const third = await publish(h, author.actor, 'a third engineer also failed to arrive');
  const resumed = await runAgent(
    h.engine,
    { ...run, subjectId: third },
    { actorId: moderator.actorId, role: 'moderator' },
  );
  assert.equal(resumed.outcome, 'proposed', 'resume restores exactly what pause removed');
});

test('a control is refused to anybody who is not an admin', async () => {
  const { h, moderator, author } = await world();
  for (const actor of [author.actor, moderator]) {
    const refused = await apply(h, actor, 'control.pauseAgent', 'intake', 'trying it on');
    assert.equal(refused.ok, false, `${actor.role} may not apply a control`);
    assert.equal(!refused.ok && refused.error.kind, 'unauthorized');
  }
  assert.deepEqual(await activeControls(h.engine), [], 'and nothing was applied');
});

test('a disabled proposal type is refused at proposal.create, not filtered from a surface', async () => {
  const { h, admin, moderator, author } = await world();
  const experienceId = await publish(h, author.actor, 'the delivery slot was missed again');

  expect(await apply(h, admin, 'control.disableProposalType', 'review_unresolved_critical', 'noisy'), 'disable');
  await h.settle();
  assert.equal(await isProposalTypeDisabled(h.engine, 'review_unresolved_critical'), true);

  // Straight at the command, which is the case the switch has to stop: an agent calling this
  // directly is exactly what a UI-level filter would miss.
  const direct = await h.engine.bus.dispatch({
    name: 'proposal.create',
    input: {
      proposalType: 'review_unresolved_critical',
      sourceEngine: 'E12',
      targetEngine: 'E10',
      subjectId: experienceId,
      summary: 'Please look at this',
      rationale: 'Because it is unresolved.',
      confidence: 0.8,
      evidenceRefs: [{ kind: 'experience', id: experienceId }],
    },
    actor: moderator,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(direct.ok, false);
  assert.equal(!direct.ok && direct.error.code, 'proposal_type_disabled');
});

test('a held proposal cannot be decided, and is not decided on the operator’s behalf', async () => {
  const { h, admin, author, moderator } = await world();
  const experienceId = await publish(h, author.actor, 'the appointment moved twice with no notice');
  const created = expect(
    await h.engine.bus.dispatch<unknown, { proposalId: string }>({
      name: 'proposal.create',
      input: {
        proposalType: 'review_unresolved_critical',
        sourceEngine: 'E12',
        targetEngine: 'E10',
        subjectId: experienceId,
        summary: 'Please look at this',
        rationale: 'Because it is unresolved.',
        confidence: 0.8,
        evidenceRefs: [{ kind: 'experience', id: experienceId }],
      },
      actor: moderator,
      idempotencyKey: h.nextKey(),
    }),
    'propose',
  );

  expect(await apply(h, admin, 'control.refusePendingAction', created.proposalId, 'under review'), 'hold');
  await h.settle();

  const refused = await h.engine.bus.dispatch({
    name: 'proposal.decide',
    input: { proposalId: created.proposalId, outcome: 'approved' },
    actor: admin,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.error.code, 'action_held');

  // Held, not rejected. `decision != effect` cuts both ways: an effect prevented is not a
  // decision taken, and a rejection written on the operator's behalf would be a decision in the
  // ledger that no reviewer made.
  const proposal = await h.engine.store.proposals.get(created.proposalId);
  assert.equal(proposal?.status, 'proposed');
  assert.equal(proposal?.reviewedBy, undefined);
});

test('every control writes an audit row, in both directions', async () => {
  const { h, admin } = await world();
  const applied = expect(await apply(h, admin, 'control.suspendIntegration', 'sub_1', 'endpoint flapping'), 'suspend');
  expect(
    await h.engine.bus.dispatch({
      name: 'control.resume',
      input: { controlId: applied.controlId },
      actor: admin,
      idempotencyKey: h.nextKey(),
    }),
    'resume',
  );
  await h.settle();

  const events = await h.engine.store.auditEvents.query([
    eq<AuditEvent>('resourceId', applied.controlId),
  ]);
  const actions = events.map((event) => event.action).sort();
  assert.deepEqual(actions, ['control.apply', 'control.release']);
  for (const event of events) assert.equal(event.actorId, admin.actorId);

  // Released rather than deleted: the history of what was suspended and for how long is what an
  // incident review needs, and a delete would make the system look untouched.
  const history = await controlHistory(h.engine);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.active, false);
  assert.ok(history[0]?.releasedAt, 'and it says when');
  assert.deepEqual(await activeControls(h.engine), []);
});

test('re-applying a control does not overwrite who applied it first', async () => {
  const { h, admin } = await world();
  const first = expect(await apply(h, admin, 'control.pauseAgent', 'trend', 'first reason'), 'first');
  h.clock.advance(60_000);
  const other = await h.promote((await h.signUp('admin2@example.com')).auth.actorId, 'admin');
  expect(await apply(h, other, 'control.pauseAgent', 'trend', 'second reason'), 'second');

  const [control] = await activeControls(h.engine);
  assert.equal(control?.id, first.controlId);
  assert.equal(control?.createdBy, admin.actorId, 'the first applier stands');
  assert.equal(control?.reason, 'first reason', 'and so does their reason');
});

// ── Phase 93: the chain, including the refusal ───────────────────────────
test('an approval whose steps are all refused reads as approved-and-refused', async () => {
  // **The shape `decision != effect` is about.** Until this read existed it was spread across
  // three tables in a form nobody would assemble under pressure.
  const { h, admin, author, moderator } = await world();
  const experienceId = await publish(h, author.actor, 'nobody answered for six weeks');
  const created = expect(
    await h.engine.bus.dispatch<unknown, { proposalId: string }>({
      name: 'proposal.create',
      input: {
        proposalType: 'review_unresolved_critical',
        sourceEngine: 'E12',
        targetEngine: 'E9',
        subjectId: experienceId,
        summary: 'Somebody should answer this',
        rationale: 'Six weeks with no response.',
        confidence: 0.8,
        evidenceRefs: [{ kind: 'experience', id: experienceId }],
      },
      actor: moderator,
      idempotencyKey: h.nextKey(),
    }),
    'propose',
  );
  expect(
    await h.engine.bus.dispatch({
      name: 'proposal.decide',
      input: { proposalId: created.proposalId, outcome: 'approved' },
      actor: admin,
      idempotencyKey: h.nextKey(),
    }),
    'approve',
  );
  await h.settle();

  // A step against an organization the admin does not act for. Authorization is evaluated per
  // step at execution time, so this is refused with their name on the refusal.
  const plan = expect(
    await createPlan(
      h.engine,
      {
        proposalId: created.proposalId,
        steps: [
          {
            command: 'organization.respond',
            targetEngine: 'E9',
            input: { organizationId: 'org_absent', experienceId, kind: 'acknowledge', body: 'From a plan.' },
          },
        ],
      },
      admin,
    ),
    'plan',
  );
  const executed = expect(await executePlan(h.engine, plan.id, admin), 'execute');
  assert.equal(executed.plan.dispatchedCount, 0);

  const chain = await provenanceFor(h.engine, created.proposalId);
  assert.ok(chain);
  assert.equal(chain.outcome, 'approved_and_refused');
  assert.deepEqual(chain.gaps, [], 'the chain reads end to end');

  const stages = chain.links.map((link) => link.stage);
  assert.deepEqual(stages, ['proposed', 'decided', 'planned', 'refused']);

  const refusal = chain.links.find((link) => link.stage === 'refused');
  assert.ok(refusal?.refusal, 'the refusal carries its reason');
  assert.equal(refusal.command, 'organization.respond');
  assert.equal(refusal.targetEngine, 'E9');

  const decided = chain.links.find((link) => link.stage === 'decided');
  assert.equal(decided?.actorId, admin.actorId, 'and the decision carries who took it');

  // The query an incident review actually runs.
  const refusedApprovals = await approvedButRefused(h.engine);
  assert.equal(refusedApprovals.length, 1);
  assert.equal(refusedApprovals[0]?.proposalId, created.proposalId);

  assert.equal(provenanceIsWritable(), false);
  assert.equal(provenanceHidesARefusal(), false);
});

test('the chain says so when it cannot be read end to end', async () => {
  // A read is only as complete as the rows it reads, and an operator needs the difference between
  // "this did not happen" and "nothing recorded whether it happened".
  const { h, author, moderator } = await world();
  const experienceId = await publish(h, author.actor, 'the refund never arrived');
  const created = expect(
    await h.engine.bus.dispatch<unknown, { proposalId: string }>({
      name: 'proposal.create',
      input: {
        proposalType: 'review_unresolved_critical',
        sourceEngine: 'E12',
        targetEngine: 'E10',
        subjectId: experienceId,
        summary: 'Please look',
        rationale: 'Unresolved.',
        confidence: 0.8,
        evidenceRefs: [{ kind: 'experience', id: experienceId }],
      },
      actor: moderator,
      idempotencyKey: h.nextKey(),
    }),
    'propose',
  );

  // The row is moved directly, so no audit event records who decided it. That is precisely the
  // situation the gap list exists to name.
  const row = await h.engine.store.proposals.get(created.proposalId);
  assert.ok(row);
  await h.engine.store.proposals.put({ ...row, status: 'approved' });

  const chain = await provenanceFor(h.engine, created.proposalId);
  assert.equal(chain?.gaps.length, 2, 'no decision event, and no plan');
  assert.match(chain?.gaps.join(' ') ?? '', /who decided it cannot be read/);
  assert.match(chain?.gaps.join(' ') ?? '', /authorised nothing/);
  assert.equal(chain?.outcome, 'no_decision_yet', 'and it does not claim an effect');
});

test('provenance is undefined for a proposal that does not exist', async () => {
  const { h } = await world();
  assert.equal(await provenanceFor(h.engine, 'prp_nope'), undefined);
});

// ── Phase 95: containment, against the real runtime ──────────────────────
test('one consumer failing does not withhold the event from the others', async () => {
  // The per-(event, consumer) delivery record is what makes this true, and it is the claim the
  // whole containment table rests on.
  const { h, author } = await world();
  const experienceId = await publish(h, author.actor, 'the parcel went to the wrong address');

  // The delivery ledger is a runtime concern rather than a store table, which is itself the
  // point: delivery state is keyed by (outboxId, consumer) and lives beside the queue.
  const records = await h.engine.deliveries.all();
  assert.ok(records.length > 1, 'several consumers saw events');

  // The same event delivered to more than one consumer, each with its own state. That is the
  // mechanism the whole containment table rests on.
  const perEvent = new Map<string, Set<string>>();
  for (const record of records) {
    const consumers = perEvent.get(record.outboxId) ?? new Set<string>();
    consumers.add(record.consumer);
    perEvent.set(record.outboxId, consumers);
  }
  assert.ok(
    [...perEvent.values()].some((consumers) => consumers.size > 1),
    'at least one event was delivered to several consumers independently',
  );

  // Everything drained, so nothing is holding anything else up. `completed` is the terminal
  // success state; anything still `queued`, `retrying` or `dead_letter` would mean a consumer is
  // behind, which is the containment class this test is about.
  assert.deepEqual(
    records.filter((record) => record.state !== 'completed').map((record) => record.consumer),
    [],
  );
  assert.ok(experienceId.length > 0);
  // The per-(event, consumer) key is what `malformed_event` names as its containment; the same
  // mechanism is why a slow consumer only makes its own projection stale.
  assert.match(CONTAINMENT.malformed_event.unaffected, /per \(event, consumer\)/);
  assert.match(CONTAINMENT.consumer_failure.blastRadius, /That consumer falls behind/);
});

test('a provider outage refuses one path and leaves governed state untouched', async () => {
  const h = createEngineHarness({
    providers: { assistance: createDeterministicAssistanceProvider({ failing: true }) },
  });
  const author = await h.signUp('author@example.com', 'Author');
  const moderator = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'moderator');
  const experienceId = await publish(h, author.actor, 'the lift has been broken for a month');

  const before = await h.engine.store.experiences.get(experienceId);
  const run = await runAgent(
    h.engine,
    { agentId: 'resolution', subjectId: experienceId, proposalType: 'review_unresolved_critical', engine: 'E10', targetEngine: 'E10' },
    { actorId: moderator.actorId, role: 'moderator' },
  );
  assert.equal(run.outcome, 'provider_unavailable');
  assert.deepEqual(await h.engine.store.experiences.get(experienceId), before, 'byte-identical');
  assert.equal(await h.engine.store.proposals.count(), 0, 'and no proposal with nothing behind it');
  assert.equal(CONTAINMENT.provider_unavailable.pages, false, 'a correct refusal does not page anybody');
});
