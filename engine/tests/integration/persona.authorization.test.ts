import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { GUEST, type ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';

/**
 * Persona authorization, proved rather than described.
 *
 * Every assertion here is about a *refusal*. Navigation scoping and page guards
 * are conveniences; these are the checks that make a surface safe, and each one is
 * exercised by asking for the thing and being told no.
 */
const setUp = async (h: EngineHarness): Promise<void> => {
  await h.engine.store.entities.put({
    id: 'ent_northwind', name: 'Northwind Air', slug: 'northwind-air', kind: 'organization',
  });
  await h.engine.store.entityAliases.put({ id: 'ali_1', entityId: 'ent_northwind', alias: 'Northwind Air' });
  await h.engine.store.categories.put({ id: 'cat_shopping', name: 'Shopping & service', slug: 'shopping-service' });
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

const organizationWith = async (
  h: EngineHarness,
  actorId: string,
  status: 'claimed' | 'pending',
  revoked = false,
): Promise<string> => {
  await h.engine.store.organizationProfiles.put({
    id: 'org_northwind', entityId: 'ent_northwind', displayName: 'Northwind Air', status,
  });
  await h.engine.store.organizationMemberships.put({
    id: `mem_${actorId}`,
    organizationId: 'org_northwind',
    actorId,
    role: 'admin',
    grantedAt: h.clock.now(),
    ...(revoked ? { revokedAt: h.clock.now() } : {}),
  });
  return 'org_northwind';
};

test('a business cannot resolve or delete a consumer experience', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const staff = await h.signUp('staff@northwind.example');
  await organizationWith(h, staff.auth.actorId, 'claimed');
  const body = 'Northwind Air never processed my refund.';
  const experienceId = await publish(h, author.actor, body);
  expect(
    await h.engine.bus.dispatch({
      name: 'normalization.confirm',
      input: { experienceId, fields: { entity: 'ent_northwind' } },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'confirm',
  );

  const attempts: readonly { name: string; input: Record<string, unknown> }[] = [
    { name: 'creator.deleteExperience', input: { experienceId } },
    { name: 'experience.hide', input: { experienceId } },
    { name: 'experience.update', input: { experienceId, bodyText: 'Nothing happened.' } },
    { name: 'safety.applyModerationAction', input: { targetType: 'experience', targetId: experienceId, action: 'remove', reason: 'x' } },
    { name: 'resolution.report', input: { experienceId, kind: 'resolved_for_me' } },
  ];
  for (const attempt of attempts) {
    const refused = await h.engine.bus.dispatch({
      ...attempt,
      actor: staff.actor,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(refused.ok, false, `${attempt.name} must be refused for a business`);
  }

  const experience = await h.engine.store.experiences.get(experienceId);
  assert.equal(experience?.status, 'published');
  assert.equal(experience?.bodyText, body);
  assert.equal(experience?.resolutionStatus ?? 'open', 'open');
});

test('a consumer cannot reach operator commands', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const consumer = await h.signUp('consumer@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');

  const attempts: readonly { name: string; input: Record<string, unknown> }[] = [
    { name: 'safety.claimQueueItem', input: { queueItemId: 'mq_1' } },
    { name: 'safety.applyModerationAction', input: { targetType: 'experience', targetId: experienceId, action: 'remove', reason: 'x' } },
    { name: 'dispute.review', input: { disputeId: 'dsp_1', outcome: 'declined', note: 'x' } },
    { name: 'proposal.create', input: { proposalType: 'x', sourceEngine: 'E12', targetEngine: 'E4', subjectId: experienceId, summary: 's', rationale: 'r', confidence: 0.5, evidenceRefs: [{ kind: 'experience', id: experienceId }] } },
    { name: 'proposal.decide', input: { proposalId: 'prp_1', outcome: 'approved' } },
    { name: 'governance.grantRole', input: { actorId: consumer.auth.actorId, role: 'admin' } },
  ];
  for (const attempt of attempts) {
    const refused = await h.engine.bus.dispatch({
      ...attempt,
      actor: consumer.actor,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(refused.ok, false, `${attempt.name} must be refused for a consumer`);
    assert.match(
      refused.ok === false ? refused.error.code : '',
      /policy_|not_found/,
      `${attempt.name} must fail on authorization, not on a domain error`,
    );
  }
});

test('a pending claim and a revoked membership each grant nothing', async () => {
  for (const scenario of [
    { label: 'pending claim', status: 'pending' as const, revoked: false },
    { label: 'revoked membership', status: 'claimed' as const, revoked: true },
  ]) {
    const h = createEngineHarness();
    await setUp(h);
    const author = await h.signUp('author@example.com');
    const staff = await h.signUp('staff@northwind.example');
    await organizationWith(h, staff.auth.actorId, scenario.status, scenario.revoked);
    const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
    expect(
      await h.engine.bus.dispatch({
        name: 'normalization.confirm',
        input: { experienceId, fields: { entity: 'ent_northwind' } },
        actor: author.actor,
        idempotencyKey: h.nextKey(),
      }),
      'confirm',
    );

    const responding = await h.engine.bus.dispatch({
      name: 'organization.respond',
      input: { organizationId: 'org_northwind', experienceId, kind: 'respond', body: 'Hello.' },
      actor: staff.actor,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(responding.ok, false, `${scenario.label}: cannot respond`);

    const disputing = await h.engine.bus.dispatch({
      name: 'dispute.open',
      input: { experienceId, organizationId: 'org_northwind', reason: 'account_inaccurate', detail: 'x' },
      actor: staff.actor,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(disputing.ok, false, `${scenario.label}: cannot dispute as the organization`);
  }
});

test('dispute ownership is enforced: withdrawal is the raiser’s alone', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const other = await h.signUp('other@example.com');
  const moderator = await h.signUp('mod@example.com');
  await h.promote(moderator.auth.actorId, 'moderator');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');

  const opened = expect(
    await h.engine.bus.dispatch<unknown, { disputeId: string }>({
      name: 'dispute.open',
      input: { experienceId, reason: 'account_inaccurate', detail: 'Not what happened.' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'dispute',
  );

  for (const actor of [
    other.actor,
    { actorId: moderator.auth.actorId, role: 'moderator' as const, authenticated: true },
  ]) {
    const refused = await h.engine.bus.dispatch({
      name: 'dispute.withdraw',
      input: { disputeId: opened.disputeId },
      actor,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(refused.ok, false, 'only the raiser withdraws — not even a moderator');
  }

  expect(
    await h.engine.bus.dispatch({
      name: 'dispute.withdraw',
      input: { disputeId: opened.disputeId },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'the raiser can',
  );
});

test('intelligence cannot bypass the target engine', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const moderator = await h.signUp('mod@example.com');
  await h.promote(moderator.auth.actorId, 'moderator');
  const staffActor: ActorContext = { actorId: moderator.auth.actorId, role: 'moderator', authenticated: true };
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');

  // A proposal naming a command the *reviewer* is not allowed to run. Approval
  // must not lend it authority the reviewer does not have.
  const created = expect(
    await h.engine.bus.dispatch<unknown, { proposalId: string }>({
      name: 'proposal.create',
      input: {
        proposalType: 'grant_admin', sourceEngine: 'E12', targetEngine: 'E1', subjectId: experienceId,
        summary: 'Escalate the reviewer.', rationale: 'Convenience.', confidence: 0.99,
        evidenceRefs: [{ kind: 'experience', id: experienceId }],
        proposedCommand: 'governance.grantRole',
        proposedInput: { actorId: moderator.auth.actorId, role: 'admin' },
      },
      actor: staffActor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );

  const approved = expect(
    await h.engine.bus.dispatch<unknown, { dispatched: boolean; dispatchError?: string }>({
      name: 'proposal.decide',
      input: { proposalId: created.proposalId, outcome: 'approved', note: 'Approving.' },
      actor: staffActor,
      idempotencyKey: h.nextKey(),
    }),
    'approve',
  );

  assert.equal(
    approved.dispatched,
    false,
    'granting a role needs admin; approving a proposal is not a route to it',
  );
  assert.match(approved.dispatchError ?? '', /policy_/);
  const actor = await h.engine.store.actors.get(moderator.auth.actorId);
  assert.equal(actor?.role, 'moderator', 'and no privilege was gained');
});

test('a guest can read what is public and write nothing', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  const guest: ActorContext = { actorId: 'guest', role: 'guest', authenticated: false };

  const attempts: readonly { name: string; input: Record<string, unknown> }[] = [
    { name: 'corroboration.create', input: { experienceId, type: 're_rage' } },
    { name: 'dispute.open', input: { experienceId, reason: 'account_inaccurate', detail: 'x' } },
    { name: 'relation.assert', input: { fromExperienceId: experienceId, toExperienceId: 'exp_other' } },
    { name: 'resolution.report', input: { experienceId, kind: 'resolved_for_me' } },
  ];
  for (const attempt of attempts) {
    const refused = await h.engine.bus.dispatch({ ...attempt, actor: guest, idempotencyKey: h.nextKey() });
    assert.equal(refused.ok, false, `a guest must not ${attempt.name}`);
  }

  // Sharing is the one thing a guest may do, because it is amplification and not a claim.
  const shared = await h.engine.bus.dispatch({
    name: 'share.create',
    input: { experienceId, destination: 'copy_link' },
    actor: guest,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(shared.ok, true, 'a guest may share');
});

// ── the credential hole, found by a review bot on PR #5 ──────────────────
test('sign-in is refused when no credential mechanism is configured', async () => {
  // **How this survived a hundred phases: `identity.authenticate` had no test at all.** It is
  // reachable only from `/api/session` with `mode: 'signin'`, and nothing exercised that path —
  // every harness signs up rather than signing in. So a handler that took `{ email }`, looked the
  // actor up and issued a session went unnoticed: knowing a moderator's or an admin's email
  // address was enough to become them.
  //
  // The engine now refuses by default. A credential mechanism is a product decision with its own
  // migration and provider; what this asserts is that the absence of one **fails closed** rather
  // than falling open.
  const h = createEngineHarness();
  const { auth } = await h.signUp('victim@example.com', 'Victim');
  const moderatorId = (await h.signUp('mod-target@example.com', 'Mod')).auth.actorId;
  await h.promote(moderatorId, 'moderator');

  // Both actors already hold a session from signing up, legitimately. What must not change is
  // the *count*: the attempts below must add nothing.
  const before = (await h.engine.store.sessions.query([])).length;

  for (const email of ['victim@example.com', 'mod-target@example.com']) {
    const attempt = await h.engine.bus.dispatch({
      name: 'identity.authenticate',
      input: { email },
      actor: GUEST,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(attempt.ok, false, `${email} cannot be signed into with an address alone`);
    assert.equal(!attempt.ok && attempt.error.code, 'credentials_required');
    assert.equal(!attempt.ok && attempt.error.kind, 'unauthorized');
  }

  // No session was minted by the attempts. The sign-up sessions stand, which is the point: the
  // refusal closes the impersonation path without disturbing legitimate state.
  assert.equal(
    (await h.engine.store.sessions.query([])).length,
    before,
    'the attempts minted no session for anybody',
  );
  assert.ok(auth.sessionId, 'and the legitimate sign-up session is untouched');
});

test('the refusal precedes the lookup, so it cannot probe which emails exist', async () => {
  // A refusal that differed between a known and an unknown address would be an existence oracle,
  // which is the same class of leak Phase 69 closed at the database.
  const h = createEngineHarness();
  await h.signUp('known@example.com', 'Known');

  const results = await Promise.all(
    ['known@example.com', 'nobody@example.com', '', 'not-an-email'].map((email) =>
      h.engine.bus.dispatch({
        name: 'identity.authenticate',
        input: { email },
        actor: GUEST,
        idempotencyKey: h.nextKey(),
      }),
    ),
  );
  const codes = new Set(results.map((result) => (result.ok ? 'ok' : result.error.code)));
  assert.deepEqual([...codes], ['credentials_required'], 'every address gets the identical refusal');
});

test('an environment may opt in explicitly, and only then', async () => {
  // The `RAGERS_TEST_SEED` pattern: off by default, and a development environment says so out
  // loud. The flag lives in the engine config rather than the route, because a check at a surface
  // is bypassed by any caller reaching the bus directly — Phase 94's argument, applied here.
  const permissive = createEngineHarness({ config: { allowPasswordlessSignIn: true } });
  await permissive.signUp('dev@example.com', 'Dev');
  const signedIn = await permissive.engine.bus.dispatch({
    name: 'identity.authenticate',
    input: { email: 'dev@example.com' },
    actor: GUEST,
    idempotencyKey: permissive.nextKey(),
  });
  assert.equal(signedIn.ok, true, 'development sign-in still works when declared');
});
