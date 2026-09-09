import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { eq } from '../../src/ports/store.ts';
import { disputesFor } from '../../src/engines/dispute.engine.ts';
import { relatedTo } from '../../src/engines/relation.engine.ts';
import { publicResponsivenessFor, MINIMUM_SAMPLE } from '../../src/engines/responsiveness.engine.ts';
import { contributionViewOf } from '../../src/engines/reputation.engine.ts';
import { openProposals } from '../../src/engines/proposal.engine.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { ProposalRow, RelationRow } from '../../src/ports/store.ts';

/**
 * The four contract gaps, end to end through the bus.
 *
 * The properties under test are the boundaries, not the happy paths: a business
 * cannot close a consumer's dispute, relating buys no credibility, an
 * under-sampled record says so, and an approved proposal still has to satisfy the
 * target engine.
 */
const setUp = async (h: EngineHarness): Promise<void> => {
  await h.engine.store.entities.put({
    id: 'ent_northwind', name: 'Northwind Air', slug: 'northwind-air', kind: 'organization',
  });
  await h.engine.store.entityAliases.put({ id: 'ali_1', entityId: 'ent_northwind', alias: 'Northwind Air' });
  await h.engine.store.categories.put({ id: 'cat_shopping', name: 'Shopping & service', slug: 'shopping-service' });
  await h.engine.store.issueTypes.put({
    id: 'iss_refund', categoryId: 'cat_shopping', name: 'Refund not processed', slug: 'refund-not-processed',
  });
};

const claimedOrganization = async (h: EngineHarness, actorId: string): Promise<string> => {
  await h.engine.store.organizationProfiles.put({
    id: 'org_northwind', entityId: 'ent_northwind', displayName: 'Northwind Air',
    claimedBy: actorId, claimedAt: h.clock.now(), status: 'claimed',
  });
  await h.engine.store.organizationMemberships.put({
    id: `mem_${actorId}`, organizationId: 'org_northwind', actorId, role: 'admin', grantedAt: h.clock.now(),
  });
  return 'org_northwind';
};

const publish = async (h: EngineHarness, actor: ActorContext, bodyText: string): Promise<string> => {
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'text', category: 'Shopping & service', bodyText, visibility: 'public' },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();
  return created.experienceId;
};

const confirmEntity = async (h: EngineHarness, actor: ActorContext, experienceId: string): Promise<void> => {
  expect(
    await h.engine.bus.dispatch({
      name: 'normalization.confirm',
      input: { experienceId, fields: { entity: 'ent_northwind', category: 'cat_shopping', issueType: 'iss_refund' } },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'confirm',
  );
  await h.settle();
};

const dispute = (h: EngineHarness, actor: ActorContext, input: Record<string, unknown>) =>
  h.engine.bus.dispatch<unknown, { disputeId: string; contested: boolean }>({
    name: 'dispute.open', input, actor, idempotencyKey: h.nextKey(),
  });

// ── E10 formal dispute ───────────────────────────────────────────────────
test('a bystander has no standing to dispute', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const bystander = await h.signUp('bystander@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');

  const refused = await dispute(h, bystander.actor, { experienceId, reason: 'account_inaccurate' });
  assert.equal(refused.ok === false && refused.error.code, 'no_standing_to_dispute');
});

test('an experiencer and the organization can each dispute, and both are recorded', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const staff = await h.signUp('staff@northwind.example');
  await claimedOrganization(h, staff.auth.actorId);
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  await confirmEntity(h, author.actor, experienceId);

  expect(
    await dispute(h, author.actor, {
      experienceId, reason: 'response_misleading', detail: 'No refund arrived.',
    }),
    'consumer disputes',
  );
  expect(
    await dispute(h, staff.actor, {
      experienceId, organizationId: 'org_northwind', reason: 'account_inaccurate', detail: 'Our records differ.',
    }),
    'organization disputes',
  );

  const view = await disputesFor(h.engine, experienceId);
  assert.equal(view.contested, true);
  assert.deepEqual(view.disputes.map((row) => row.origin).sort(), ['experiencer', 'organization']);
});

test('a business cannot close a consumer dispute — there is no command for it', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const staff = await h.signUp('staff@northwind.example');
  await claimedOrganization(h, staff.auth.actorId);
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  await confirmEntity(h, author.actor, experienceId);

  const opened = expect(
    await dispute(h, author.actor, { experienceId, reason: 'fix_not_delivered', detail: 'Still nothing.' }),
    'consumer disputes',
  );

  // Reviewing requires a moderator role, which organization staff do not have.
  const asBusiness = await h.engine.bus.dispatch({
    name: 'dispute.review',
    input: { disputeId: opened.disputeId, outcome: 'declined', note: 'We disagree.' },
    actor: staff.actor,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(asBusiness.ok, false, 'the disputed party must not decide it');
  assert.match(asBusiness.ok === false ? asBusiness.error.code : '', /policy_/);

  // Withdrawing is the raiser's right alone.
  const alsoRefused = await h.engine.bus.dispatch({
    name: 'dispute.withdraw',
    input: { disputeId: opened.disputeId },
    actor: staff.actor,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(alsoRefused.ok, false);

  assert.equal((await disputesFor(h.engine, experienceId)).contested, true, 'still contested');
});

test('only a moderator decides, and not the one who raised it', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const moderator = await h.signUp('mod@example.com');
  await h.promote(moderator.auth.actorId, 'moderator');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');

  const opened = expect(
    await dispute(h, author.actor, { experienceId, reason: 'account_inaccurate', detail: 'Wrong.' }),
    'dispute',
  );

  const decided = expect(
    await h.engine.bus.dispatch<unknown, { status: string; contested: boolean }>({
      name: 'dispute.review',
      input: { disputeId: opened.disputeId, outcome: 'upheld', note: 'Checked the evidence.' },
      actor: { actorId: moderator.auth.actorId, role: 'moderator', authenticated: true },
      idempotencyKey: h.nextKey(),
    }),
    'review',
  );
  assert.equal(decided.status, 'upheld');
  assert.equal(decided.contested, false, 'a decided dispute stops shading the account');
});

test('one live dispute per person per experience', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');

  expect(await dispute(h, author.actor, { experienceId, reason: 'account_inaccurate', detail: 'a' }), 'first');
  const second = await dispute(h, author.actor, { experienceId, reason: 'fix_not_delivered', detail: 'b' });
  assert.equal(second.ok === false && second.error.code, 'dispute_already_open');
});

test('a dispute leaves publication and the outcome axis untouched', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const body = 'Northwind Air never processed my refund.';
  const experienceId = await publish(h, author.actor, body);
  expect(await dispute(h, author.actor, { experienceId, reason: 'account_inaccurate', detail: 'x' }), 'dispute');
  await h.settle();

  const experience = await h.engine.store.experiences.get(experienceId);
  assert.equal(experience?.status, 'published', 'disputing does not unpublish');
  assert.equal(experience?.bodyText, body, 'nor edit');
  assert.equal(
    experience?.resolutionStatus ?? 'open',
    'open',
    'a dispute is its own axis: it is neither unresolved nor resolved',
  );
});

// ── E6 Relate ────────────────────────────────────────────────────────────
const relate = (h: EngineHarness, actor: ActorContext, input: Record<string, unknown>) =>
  h.engine.bus.dispatch<unknown, { relationId: string; assertedByCount: number; trustWeight: number }>({
    name: 'relation.assert', input, actor, idempotencyKey: h.nextKey(),
  });

test('relating two experiences never touches corroboration or trust', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');
  const observer = await h.signUp('observer@example.com');
  const first = await publish(h, a.actor, 'Northwind Air never processed my refund.');
  const second = await publish(h, b.actor, 'Northwind Air lost my bag last week.');

  const related = expect(
    await relate(h, observer.actor, { fromExperienceId: first, toExperienceId: second }),
    'relate',
  );
  assert.equal(related.trustWeight, 0);
  await h.settle();

  // No corroboration was created, and no experiencer count moved.
  assert.equal(await h.engine.store.corroborations.count(), 0, 'relating is not corroborating');
  const counters = await h.engine.store.counters.get(first);
  assert.equal(counters?.reRageCount ?? 0, 0);
  assert.equal(counters?.corroboratorCount ?? 0, 0);

  // And the observer, who experienced neither, gained nothing.
  const contribution = await contributionViewOf(h.engine, observer.auth.actorId);
  assert.equal(contribution.corroborationsGiven, 0);
  assert.equal(contribution.experiencesPublished, 0);
});

test('relating is one assertion per person per pair, whichever way round', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');
  const observer = await h.signUp('observer@example.com');
  const first = await publish(h, a.actor, 'Northwind Air never processed my refund.');
  const second = await publish(h, b.actor, 'Northwind Air lost my bag last week.');

  expect(await relate(h, observer.actor, { fromExperienceId: first, toExperienceId: second }), 'one way');
  const reversed = await relate(h, observer.actor, { fromExperienceId: second, toExperienceId: first });
  assert.equal(reversed.ok === false && reversed.error.code, 'already_related');
  assert.equal(await h.engine.store.relations.countWhere([eq<RelationRow>('status', 'active')]), 1);
});

test('a relation is retractable, the row survives, and the count follows', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');
  const first = await publish(h, a.actor, 'Northwind Air never processed my refund.');
  const second = await publish(h, b.actor, 'Northwind Air lost my bag last week.');

  const observers = [];
  for (let index = 0; index < 3; index += 1) observers.push(await h.signUp(`o-${index}@example.com`));
  let last = '';
  for (const observer of observers) {
    const result = expect(
      await relate(h, observer.actor, { fromExperienceId: first, toExperienceId: second }),
      'relate',
    );
    last = result.relationId;
  }
  assert.equal((await relatedTo(h.engine, first))[0]?.assertedByCount, 3);

  const retracted = expect(
    await h.engine.bus.dispatch<unknown, { assertedByCount: number }>({
      name: 'relation.retract',
      input: { relationId: last },
      actor: observers[2]!.actor,
      idempotencyKey: h.nextKey(),
    }),
    'retract',
  );
  assert.equal(retracted.assertedByCount, 2);
  assert.equal(await h.engine.store.relations.count(), 3, 'the row survives retraction');
});

// ── E11 responsiveness and contribution ──────────────────────────────────
test('an under-sampled responsiveness record says so and withholds timings', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const staff = await h.signUp('staff@northwind.example');
  await claimedOrganization(h, staff.auth.actorId);
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  await confirmEntity(h, author.actor, experienceId);

  h.clock.advance(60_000);
  expect(
    await h.engine.bus.dispatch({
      name: 'organization.respond',
      input: { organizationId: 'org_northwind', experienceId, kind: 'acknowledge', body: 'We see this.' },
      actor: staff.actor,
      idempotencyKey: h.nextKey(),
    }),
    'respond',
  );
  await h.settle();

  const view = await publicResponsivenessFor(h.engine, 'org_northwind');
  assert.ok(view);
  assert.equal(view?.casesAnswered, 1);
  assert.ok((view?.sampleSize ?? 0) < MINIMUM_SAMPLE);
  assert.equal(view?.insufficientSample, true);
  assert.equal(
    view?.medianFirstResponseMs,
    undefined,
    'a median from one case is withheld, not shown small',
  );
  assert.match(view?.caption ?? '', /Too few cases/);
});

test('answering does not move the confirmed-resolved figure', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const staff = await h.signUp('staff@northwind.example');
  await claimedOrganization(h, staff.auth.actorId);
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  await confirmEntity(h, author.actor, experienceId);

  expect(
    await h.engine.bus.dispatch({
      name: 'organization.respond',
      input: {
        organizationId: 'org_northwind', experienceId, kind: 'publish_resolution', body: 'Fixed.',
      },
      actor: staff.actor,
      idempotencyKey: h.nextKey(),
    }),
    'respond',
  );
  await h.settle();

  const answered = await publicResponsivenessFor(h.engine, 'org_northwind');
  assert.equal(answered?.casesAnswered, 1);
  assert.equal(answered?.casesConfirmedResolved, 0, 'saying it is fixed is not it being fixed');
  assert.equal(answered?.resolutionRate, 0);

  expect(
    await h.engine.bus.dispatch({
      name: 'resolution.report',
      input: { experienceId, kind: 'resolved_for_me' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'report',
  );
  await h.settle();

  const confirmed = await publicResponsivenessFor(h.engine, 'org_northwind');
  assert.equal(confirmed?.casesConfirmedResolved, 1, 'only the experiencer moves it');
});

test('a contribution view exposes no composite score and no internal signal', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  for (let index = 0; index < 3; index += 1) {
    await publish(h, author.actor, `Northwind Air issue number ${index} with the refund.`);
  }
  await h.settle();

  const view = await contributionViewOf(h.engine, author.auth.actorId);
  assert.equal(view.experiencesPublished, 3);
  for (const key of Object.keys(view)) {
    assert.equal(
      /score|trust|risk|confidence|standing|internal|popular/i.test(key),
      false,
      `a contribution view must not expose ${key}`,
    );
  }
  assert.match(view.caption, /Not a score, and not popularity/);
});

// ── E12 governed proposals ───────────────────────────────────────────────
test('a proposal is visible to a moderator and not to a member', async () => {
  const h = createEngineHarness();
  const member = await h.signUp('member@example.com');
  const moderator = await h.signUp('mod@example.com');
  await h.promote(moderator.auth.actorId, 'moderator');
  const staffActor: ActorContext = { actorId: moderator.auth.actorId, role: 'moderator', authenticated: true };

  const refused = await h.engine.bus.dispatch({
    name: 'proposal.create',
    input: {
      proposalType: 'x', sourceEngine: 'E12', targetEngine: 'E4', subjectId: 'exp_1',
      summary: 's', rationale: 'r', confidence: 0.5,
      evidenceRefs: [{ kind: 'experience', id: 'exp_1' }],
    },
    actor: member.actor,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(refused.ok, false, 'a member cannot place a proposal in front of a moderator');

  expect(
    await h.engine.bus.dispatch<unknown, { proposalId: string }>({
      name: 'proposal.create',
      input: {
        proposalType: 'review_cluster', sourceEngine: 'E12', targetEngine: 'E4', subjectId: 'exp_1',
        summary: 'Worth a look.', rationale: 'Burst detected.', confidence: 0.6,
        evidenceRefs: [{ kind: 'risk_event', id: 'risk_1' }],
      },
      actor: staffActor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  assert.equal((await openProposals(h.engine)).length, 1);
});

test('approving dispatches the target engine command and records that it ran', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const moderator = await h.signUp('mod@example.com');
  await h.promote(moderator.auth.actorId, 'moderator');
  const staffActor: ActorContext = { actorId: moderator.auth.actorId, role: 'moderator', authenticated: true };
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');

  const created = expect(
    await h.engine.bus.dispatch<unknown, { proposalId: string }>({
      name: 'proposal.create',
      input: {
        proposalType: 'no_action', sourceEngine: 'E12', targetEngine: 'E4', subjectId: experienceId,
        summary: 'Reviewed, nothing wrong.', rationale: 'The burst was a news cycle.', confidence: 0.8,
        evidenceRefs: [{ kind: 'experience', id: experienceId }],
        proposedCommand: 'safety.applyModerationAction',
        proposedInput: {
          targetType: 'experience', targetId: experienceId, action: 'no_action', reason: 'reviewed via proposal',
        },
      },
      actor: staffActor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );

  const approved = expect(
    await h.engine.bus.dispatch<unknown, { status: string; dispatched: boolean }>({
      name: 'proposal.decide',
      input: { proposalId: created.proposalId, outcome: 'approved', note: 'Agreed.' },
      actor: staffActor,
      idempotencyKey: h.nextKey(),
    }),
    'approve',
  );
  assert.equal(approved.status, 'approved');
  assert.equal(approved.dispatched, true, 'the governed command actually ran');

  const row = await h.engine.store.proposals.get(created.proposalId);
  assert.ok(row?.dispatchedAt, 'and that is recorded on the proposal');
  // The moderation action exists because the *target engine* wrote it.
  assert.ok(
    (await h.engine.store.moderationActions.count()) > 0,
    'the effect came from the target engine, not from the proposal',
  );
});

test('an approved proposal the target engine refuses is not an action that happened', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const moderator = await h.signUp('mod@example.com');
  await h.promote(moderator.auth.actorId, 'moderator');
  const staffActor: ActorContext = { actorId: moderator.auth.actorId, role: 'moderator', authenticated: true };
  // The moderator's own experience: `moderation.action` forbids acting on it.
  const ownExperienceId = await publish(h, staffActor, 'Northwind Air never processed my refund.');

  const created = expect(
    await h.engine.bus.dispatch<unknown, { proposalId: string }>({
      name: 'proposal.create',
      input: {
        proposalType: 'remove', sourceEngine: 'E12', targetEngine: 'E4', subjectId: ownExperienceId,
        summary: 'Remove it.', rationale: 'Flagged.', confidence: 0.9,
        evidenceRefs: [{ kind: 'experience', id: ownExperienceId }],
        proposedCommand: 'safety.applyModerationAction',
        proposedInput: {
          targetType: 'experience', targetId: ownExperienceId, action: 'remove', reason: 'via proposal',
        },
      },
      actor: staffActor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );

  const approved = expect(
    await h.engine.bus.dispatch<unknown, { status: string; dispatched: boolean; dispatchError?: string }>({
      name: 'proposal.decide',
      input: { proposalId: created.proposalId, outcome: 'approved', note: 'Approving.' },
      actor: staffActor,
      idempotencyKey: h.nextKey(),
    }),
    'approve',
  );

  assert.equal(approved.status, 'approved', 'the decision is recorded');
  assert.equal(
    approved.dispatched,
    false,
    'but the governed engine refused it — approval is not a bypass of ownership rules',
  );
  assert.match(approved.dispatchError ?? '', /policy_/);

  const experience = await h.engine.store.experiences.get(ownExperienceId);
  assert.equal(experience?.status, 'published', 'and nothing was removed');
  const row = await h.engine.store.proposals.get(created.proposalId);
  assert.equal(row?.dispatchedAt, undefined, 'an approval that did not take effect is distinguishable');
  assert.ok(row?.dispatchError);
});

test('proposals emit events naming whether the governed action ran', async () => {
  const h = createEngineHarness();
  const moderator = await h.signUp('mod@example.com');
  await h.promote(moderator.auth.actorId, 'moderator');
  const staffActor: ActorContext = { actorId: moderator.auth.actorId, role: 'moderator', authenticated: true };

  const created = expect(
    await h.engine.bus.dispatch<unknown, { proposalId: string }>({
      name: 'proposal.create',
      input: {
        proposalType: 'observe', sourceEngine: 'E12', targetEngine: 'E8', subjectId: 'clu_1',
        summary: 'Watch this pattern.', rationale: 'Growth is accelerating.', confidence: 0.55,
        evidenceRefs: [{ kind: 'cluster', id: 'clu_1' }],
      },
      actor: staffActor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  expect(
    await h.engine.bus.dispatch({
      name: 'proposal.decide',
      input: { proposalId: created.proposalId, outcome: 'rejected', note: 'Already tracked.' },
      actor: staffActor,
      idempotencyKey: h.nextKey(),
    }),
    'reject',
  );

  const names = (await h.engine.outbox.all()).map((event) => event.eventName);
  assert.ok(names.includes('IntelligenceProposalCreated'));
  assert.ok(names.includes('IntelligenceProposalRejected'));

  const rejected = (await h.engine.outbox.all()).find(
    (event) => event.eventName === 'IntelligenceProposalRejected',
  );
  assert.equal(rejected?.payload['dispatched'], false, 'a rejection dispatches nothing');
});

test('a proposal with no command approves without touching anything', async () => {
  const h = createEngineHarness();
  const moderator = await h.signUp('mod@example.com');
  await h.promote(moderator.auth.actorId, 'moderator');
  const staffActor: ActorContext = { actorId: moderator.auth.actorId, role: 'moderator', authenticated: true };

  const created = expect(
    await h.engine.bus.dispatch<unknown, { proposalId: string }>({
      name: 'proposal.create',
      input: {
        proposalType: 'advice', sourceEngine: 'E12', targetEngine: 'E9', subjectId: 'org_1',
        summary: 'Consider replying sooner.', rationale: 'Median first response is long.', confidence: 0.5,
        evidenceRefs: [{ kind: 'signal_snapshot', id: 'sig_1' }],
      },
      actor: staffActor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  const approved = expect(
    await h.engine.bus.dispatch<unknown, { dispatched: boolean }>({
      name: 'proposal.decide',
      input: { proposalId: created.proposalId, outcome: 'approved', note: 'Noted.' },
      actor: staffActor,
      idempotencyKey: h.nextKey(),
    }),
    'approve',
  );
  assert.equal(approved.dispatched, false, 'advice with no command changes no governed state');

  const proposals = await h.engine.store.proposals.query([eq<ProposalRow>('status', 'approved')]);
  assert.equal(proposals.length, 1);
});
