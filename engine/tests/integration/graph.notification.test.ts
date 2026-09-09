import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { isBlockedBetween, followeesOf } from '../../src/engines/graph.engine.ts';
import { notificationsFor, unreadCountFor } from '../../src/engines/notification.engine.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';

const publish = async (h: EngineHarness, actor: ActorContext) => {
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: 'A thing.', visibility: 'public' },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();
  return created.experienceId;
};

test('a block removes mutual follows and is enforced in both directions', async () => {
  const h = createEngineHarness();
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');

  for (const [actor, targetId] of [
    [a.actor, b.auth.actorId],
    [b.actor, a.auth.actorId],
  ] as const) {
    expect(
      await h.engine.bus.dispatch({
        name: 'graph.follow',
        input: { targetRef: 'actor', targetId },
        actor,
        idempotencyKey: h.nextKey(),
      }),
      'follow',
    );
  }
  assert.deepEqual(await followeesOf(h.engine, a.auth.actorId), [b.auth.actorId]);

  expect(
    await h.engine.bus.dispatch({
      name: 'graph.block',
      input: { targetRef: 'actor', targetId: b.auth.actorId },
      actor: a.actor,
      idempotencyKey: h.nextKey(),
    }),
    'block',
  );
  await h.settle();

  assert.deepEqual(await followeesOf(h.engine, a.auth.actorId), [], 'the blocker no longer follows');
  assert.deepEqual(await followeesOf(h.engine, b.auth.actorId), [], 'the blocked no longer follows back');
  assert.equal(await isBlockedBetween(h.engine, a.auth.actorId, b.auth.actorId), true);
  assert.equal(
    await isBlockedBetween(h.engine, b.auth.actorId, a.auth.actorId),
    true,
    'a block is enforced from either side',
  );
});

test('you cannot follow or block yourself', async () => {
  const h = createEngineHarness();
  const a = await h.signUp('a@example.com');
  for (const command of ['graph.follow', 'graph.block', 'graph.mute']) {
    const result = await h.engine.bus.dispatch({
      name: command,
      input: { targetRef: 'actor', targetId: a.auth.actorId },
      actor: a.actor,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(result.ok, false, `${command} on yourself must be refused`);
    if (!result.ok) assert.equal(result.error.code, 'no_self_edge');
  }
});

test('following is idempotent', async () => {
  const h = createEngineHarness();
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');
  for (let i = 0; i < 3; i += 1) {
    expect(
      await h.engine.bus.dispatch({
        name: 'graph.follow',
        input: { targetRef: 'actor', targetId: b.auth.actorId, on: true },
        actor: a.actor,
        idempotencyKey: h.nextKey(),
      }),
      'follow',
    );
  }
  assert.equal(await h.engine.store.graphEdges.count((row) => row.kind === 'follow'), 1);
});

test('a reaction notifies the author exactly once, even under duplicate delivery', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const reader = await h.signUp('reader@example.com', 'Reader');
  const experienceId = await publish(h, author.actor);

  expect(
    await h.engine.bus.dispatch({
      name: 'reaction.toggle',
      input: { experienceId, reactionType: 'been_there' },
      actor: reader.actor,
      idempotencyKey: h.nextKey(),
    }),
    'react',
  );
  await h.settle();
  await h.settle();
  await h.settle();

  const notifications = await notificationsFor(h.engine, author.auth.actorId);
  assert.equal(notifications.length, 1, 'at-least-once delivery must not duplicate a notification');
  assert.equal(notifications[0]?.kind, 'reaction_received');
  assert.equal(notifications[0]?.actorLabel, 'Reader');
  assert.equal(await unreadCountFor(h.engine, author.auth.actorId), 1);
});

test('nobody is notified about their own action', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor);

  expect(
    await h.engine.bus.dispatch({
      name: 'reaction.toggle',
      input: { experienceId, reactionType: 'same' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'self react',
  );
  await h.settle();
  assert.equal((await notificationsFor(h.engine, author.auth.actorId)).length, 0);
});

test('a blocked actor generates no notification across the boundary', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const blocked = await h.signUp('blocked@example.com', 'Blocked');
  const experienceId = await publish(h, author.actor);

  expect(
    await h.engine.bus.dispatch({
      name: 'graph.block',
      input: { targetRef: 'actor', targetId: blocked.auth.actorId },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'block',
  );
  await h.settle();

  expect(
    await h.engine.bus.dispatch({
      name: 'reaction.toggle',
      input: { experienceId, reactionType: 'disagree' },
      actor: blocked.actor,
      idempotencyKey: h.nextKey(),
    }),
    'react',
  );
  await h.settle();

  assert.equal(
    (await notificationsFor(h.engine, author.auth.actorId)).length,
    0,
    'no notification may cross a block boundary',
  );
  const suppressed = await h.engine.store.notifications.find((row) => row.state === 'suppressed');
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0]?.suppressionReason, 'blocked');
});

test('notification preferences are honoured', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const reader = await h.signUp('reader@example.com');
  const experienceId = await publish(h, author.actor);

  expect(
    await h.engine.bus.dispatch({
      name: 'notification.setPreference',
      input: { kind: 'reaction_received', enabled: false },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'preference',
  );

  expect(
    await h.engine.bus.dispatch({
      name: 'reaction.toggle',
      input: { experienceId, reactionType: 'same' },
      actor: reader.actor,
      idempotencyKey: h.nextKey(),
    }),
    'react',
  );
  await h.settle();

  assert.equal((await notificationsFor(h.engine, author.auth.actorId)).length, 0);
  const row = await h.engine.store.notifications.findOne((r) => r.recipientActorId === author.auth.actorId);
  assert.equal(row?.suppressionReason, 'preference');
});

test('a moderation outcome always reaches the author', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const moderator = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'moderator');
  const experienceId = await publish(h, author.actor);

  expect(
    await h.engine.bus.dispatch({
      name: 'safety.applyModerationAction',
      input: { targetType: 'experience', targetId: experienceId, action: 'remove', reason: 'naming_shaming' },
      actor: moderator,
      idempotencyKey: h.nextKey(),
    }),
    'remove',
  );
  await h.settle();

  const notifications = await notificationsFor(h.engine, author.auth.actorId);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.kind, 'moderation_outcome');
  assert.equal(notifications[0]?.actorLabel, 'Ragers', 'a system outcome names no person');
});

test('a recipient can only read and mark their own notifications', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const reader = await h.signUp('reader@example.com');
  const stranger = await h.signUp('stranger@example.com');
  const experienceId = await publish(h, author.actor);

  expect(
    await h.engine.bus.dispatch({
      name: 'reaction.toggle',
      input: { experienceId, reactionType: 'same' },
      actor: reader.actor,
      idempotencyKey: h.nextKey(),
    }),
    'react',
  );
  await h.settle();

  const notification = (await notificationsFor(h.engine, author.auth.actorId))[0];
  assert.ok(notification);

  const byStranger = await h.engine.bus.dispatch({
    name: 'notification.markRead',
    input: { notificationId: notification?.id ?? '' },
    actor: stranger.actor,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(byStranger.ok, false);
  if (!byStranger.ok) assert.equal(byStranger.error.code, 'policy_not_owner');

  expect(
    await h.engine.bus.dispatch({
      name: 'notification.markRead',
      input: { notificationId: notification?.id ?? '' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'mark read',
  );
  assert.equal(await unreadCountFor(h.engine, author.auth.actorId), 0);
});

test('an anonymous author still receives notifications, and the reactor label is not the author', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com', 'Hidden Author');
  const reader = await h.signUp('reader@example.com', 'Reader');

  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: 'Anon post.', visibility: 'anonymous' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();

  expect(
    await h.engine.bus.dispatch({
      name: 'reaction.toggle',
      input: { experienceId: created.experienceId, reactionType: 'been_there' },
      actor: reader.actor,
      idempotencyKey: h.nextKey(),
    }),
    'react',
  );
  await h.settle();

  const notifications = await notificationsFor(h.engine, author.auth.actorId);
  assert.equal(notifications.length, 1, 'anonymity does not cost the author their own notifications');
  assert.equal(
    JSON.stringify(notifications).includes('Hidden Author'),
    false,
    'the anonymous author is never named in their own notification',
  );
});
