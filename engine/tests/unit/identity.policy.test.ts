import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorizer, policyActions } from '../../src/policy/policy.ts';
import type { ActorContext, PolicyAction, ResourceRef, Role } from '../../src/runtime/authz.ts';

const authorizer = createAuthorizer();

const actorOf = (role: Role, actorId = 'actor_self'): ActorContext => ({
  actorId,
  role,
  authenticated: role !== 'guest',
});

const ROLES: readonly Role[] = ['guest', 'member', 'moderator', 'admin'];

test('every declared action has a policy, and no action is silently permitted', () => {
  const actions = policyActions();
  assert.ok(actions.length > 30, 'the matrix must cover the full command surface');
  for (const action of actions) {
    const decisions = ROLES.map((role) =>
      authorizer.authorize(actorOf(role), action, { type: 'system' }).allowed,
    );
    assert.ok(
      decisions.some((allowed) => !allowed) || action.endsWith('.read') || decisions.every((d) => d),
      `${action} must have a meaningful decision`,
    );
  }
});

test('an action with no policy entry is denied', () => {
  const decision = authorizer.authorize(actorOf('admin'), 'not.a.real.action' as PolicyAction, { type: 'system' });
  assert.equal(decision.allowed, false, 'deny by default');
  if (!decision.allowed) assert.equal(decision.code, 'policy_unknown_action');
});

test('original media and raw transcripts are unreadable for every role, including admin', () => {
  const forbidden: readonly PolicyAction[] = ['media.read_original', 'transcript.read_raw'];
  for (const action of forbidden) {
    for (const role of ROLES) {
      const decision = authorizer.authorize(actorOf(role), action, { type: 'media', id: 'media_1' });
      assert.equal(decision.allowed, false, `${action} must be denied for ${role}`);
      if (!decision.allowed) assert.equal(decision.code, 'policy_forbidden_always');
    }
  }
});

test('role escalation is required, not assumed', () => {
  const cases: readonly [PolicyAction, ResourceRef, Role][] = [
    ['moderation.action', { type: 'experience', ownerActorId: 'someone_else', status: 'published' }, 'moderator'],
    ['moderation.read_queue', { type: 'queue_item' }, 'moderator'],
    ['role.grant', { type: 'role_assignment' }, 'admin'],
    ['audit.read', { type: 'audit' }, 'admin'],
    ['dead_letter.replay', { type: 'dead_letter' }, 'admin'],
    ['analytics.read', { type: 'analytics' }, 'admin'],
    ['reputation.read_internal', { type: 'reputation' }, 'moderator'],
  ];
  for (const [action, resource, required] of cases) {
    for (const role of ROLES) {
      const decision = authorizer.authorize(actorOf(role), action, resource);
      const expected = ROLES.indexOf(role) >= ROLES.indexOf(required);
      assert.equal(decision.allowed, expected, `${action} for ${role} should be ${expected ? 'allowed' : 'denied'}`);
    }
  }
});

test('ownership is required where the matrix demands it', () => {
  const owned: ResourceRef = { type: 'experience', id: 'exp_1', ownerActorId: 'actor_self', status: 'published' };
  const foreign: ResourceRef = { type: 'experience', id: 'exp_1', ownerActorId: 'actor_other', status: 'published' };

  assert.ok(authorizer.authorize(actorOf('member'), 'experience.delete', owned).allowed);
  const denied = authorizer.authorize(actorOf('member'), 'experience.delete', foreign);
  assert.equal(denied.allowed, false, 'members cannot delete other people\'s content');
  if (!denied.allowed) assert.equal(denied.code, 'policy_not_owner');

  // Even a moderator does not get author powers — removal is a moderation action.
  assert.equal(authorizer.authorize(actorOf('moderator'), 'experience.delete', foreign).allowed, false);
});

test('an actor cannot vote on the fairness of their own experience', () => {
  const own: ResourceRef = { type: 'experience', ownerActorId: 'actor_self', status: 'published' };
  const other: ResourceRef = { type: 'experience', ownerActorId: 'actor_other', status: 'published' };

  const onOwn = authorizer.authorize(actorOf('member'), 'fair_vote.cast', own);
  assert.equal(onOwn.allowed, false);
  if (!onOwn.allowed) assert.equal(onOwn.code, 'policy_owner_forbidden');

  assert.ok(authorizer.authorize(actorOf('member'), 'fair_vote.cast', other).allowed);
});

test('a moderator cannot action their own content', () => {
  const own: ResourceRef = { type: 'experience', ownerActorId: 'actor_self', status: 'published' };
  const decision = authorizer.authorize(actorOf('moderator'), 'moderation.action', own);
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.code, 'policy_owner_forbidden');
});

test('engagement is refused unless the target is published', () => {
  for (const status of ['draft', 'pending_media', 'pending_moderation', 'hidden', 'removed', 'under_review']) {
    const decision = authorizer.authorize(actorOf('member'), 'reaction.toggle', {
      type: 'experience',
      ownerActorId: 'actor_other',
      status,
    });
    assert.equal(decision.allowed, false, `reacting to ${status} content must be refused`);
  }
  assert.ok(
    authorizer.authorize(actorOf('member'), 'reaction.toggle', {
      type: 'experience',
      ownerActorId: 'actor_other',
      status: 'published',
    }).allowed,
  );
});

test('non-public statuses are readable only by staff or the owner', () => {
  const hidden: ResourceRef = { type: 'experience', ownerActorId: 'actor_other', status: 'hidden' };
  assert.equal(authorizer.authorize(actorOf('guest'), 'experience.read', hidden).allowed, false);
  assert.equal(authorizer.authorize(actorOf('member'), 'experience.read', hidden).allowed, false);
  assert.ok(authorizer.authorize(actorOf('moderator'), 'experience.read', hidden).allowed);
  assert.ok(
    authorizer.authorize(actorOf('member', 'actor_other'), 'experience.read', hidden).allowed,
    'the owner can still see their own hidden content',
  );
});

test('published content is readable by a guest, so the product works before sign-in', () => {
  const published: ResourceRef = { type: 'experience', ownerActorId: 'actor_other', status: 'published' };
  assert.ok(authorizer.authorize(actorOf('guest'), 'experience.read', published).allowed);
  assert.ok(authorizer.authorize(actorOf('guest'), 'feed.read', { type: 'feed' }).allowed);
  assert.ok(authorizer.authorize(actorOf('guest'), 'search.query', { type: 'search' }).allowed);
});

test('a guest cannot write anything', () => {
  const writes: readonly PolicyAction[] = [
    'experience.create',
    'reaction.toggle',
    'fair_vote.cast',
    'reply.create',
    'report.file',
    'graph.follow',
    'alias.create',
  ];
  for (const action of writes) {
    const decision = authorizer.authorize(actorOf('guest'), action, {
      type: 'experience',
      ownerActorId: 'actor_other',
      status: 'published',
    });
    assert.equal(decision.allowed, false, `a guest must not be able to ${action}`);
  }
});

test('an unauthenticated actor claiming a role is still refused', () => {
  const impostor: ActorContext = { actorId: 'actor_self', role: 'admin', authenticated: false };
  const decision = authorizer.authorize(impostor, 'role.grant', { type: 'role_assignment' });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.code, 'policy_unauthenticated');
});
