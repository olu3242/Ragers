import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { MAX_REPLY_DEPTH } from '../../src/ports/store.ts';
import { resolveIdentity } from '../../src/domain/projection.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';

const publishText = async (h: EngineHarness, actor: ActorContext) => {
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rave', creationMode: 'text', category: 'Other', bodyText: 'Nice thing.', visibility: 'public' },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();
  return created.experienceId;
};

const reply = async (
  h: EngineHarness,
  actor: ActorContext,
  input: Record<string, unknown>,
) =>
  h.engine.bus.dispatch<unknown, { replyId: string; depth: number; status: string }>({
    name: 'conversation.createReply',
    input,
    actor,
    idempotencyKey: h.nextKey(),
  });

test('a text reply publishes and increments the reply count', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const replier = await h.signUp('replier@example.com', 'Replier');
  const experienceId = await publishText(h, author.actor);

  const created = expect(
    await reply(h, replier.actor, { experienceId, creationMode: 'text', bodyText: 'Agreed.', visibility: 'public' }),
    'reply',
  );
  assert.equal(created.depth, 0);
  assert.equal(created.status, 'published');
  await h.settle();

  assert.equal((await h.engine.store.counters.get(experienceId))?.replyCount, 1);
});

test('reply nesting is capped', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const replier = await h.signUp('replier@example.com');
  const experienceId = await publishText(h, author.actor);

  let parentReplyId: string | undefined;
  for (let depth = 0; depth <= MAX_REPLY_DEPTH; depth += 1) {
    const created = expect(
      await reply(h, replier.actor, {
        experienceId,
        ...(parentReplyId === undefined ? {} : { parentReplyId }),
        creationMode: 'text',
        bodyText: `depth ${depth}`,
        visibility: 'public',
      }),
      `reply at depth ${depth}`,
    );
    assert.equal(created.depth, depth);
    parentReplyId = created.replyId;
  }

  const tooDeep = await reply(h, replier.actor, {
    experienceId,
    parentReplyId,
    creationMode: 'text',
    bodyText: 'one too far',
    visibility: 'public',
  });
  assert.equal(tooDeep.ok, false);
  if (!tooDeep.ok) assert.equal(tooDeep.error.code, 'reply_depth_exceeded');
});

test('a voice reply waits for its media, exactly like an experience', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const replier = await h.signUp('replier@example.com');
  const experienceId = await publishText(h, author.actor);

  const created = expect(
    await reply(h, replier.actor, { experienceId, creationMode: 'voice', visibility: 'anonymous' }),
    'voice reply',
  );
  assert.equal(created.status, 'pending_media', 'a voice reply is not published before its audio is handled');
  await h.settle();
  assert.equal((await h.engine.store.counters.get(experienceId))?.replyCount ?? 0, 0);
});

test('an anonymous reply exposes no identity', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const replier = await h.signUp('replier@example.com', 'Real Name');
  const experienceId = await publishText(h, author.actor);

  const created = expect(
    await reply(h, replier.actor, {
      experienceId,
      creationMode: 'text',
      bodyText: 'Anonymously agreed.',
      visibility: 'anonymous',
    }),
    'reply',
  );
  const stored = await h.engine.store.replies.get(created.replyId);
  assert.ok(stored);
  // The stored row retains attribution for safety; the projection does not.
  const identity = resolveIdentity(stored?.visibility ?? 'public', 'Real Name', undefined);
  assert.equal(identity.label, 'Anonymous');
});

test('deleting a reply is idempotent and decrements the count', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const replier = await h.signUp('replier@example.com');
  const experienceId = await publishText(h, author.actor);

  const created = expect(
    await reply(h, replier.actor, { experienceId, creationMode: 'text', bodyText: 'Oops.', visibility: 'public' }),
    'reply',
  );
  await h.settle();
  assert.equal((await h.engine.store.counters.get(experienceId))?.replyCount, 1);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const deleted = await h.engine.bus.dispatch({
      name: 'conversation.deleteReply',
      input: { replyId: created.replyId },
      actor: replier.actor,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(deleted.ok, true, 'deleting twice is not an error');
  }
  await h.settle();
  assert.equal((await h.engine.store.counters.get(experienceId))?.replyCount, 0);
});

test('another actor cannot delete your reply', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const replier = await h.signUp('replier@example.com');
  const stranger = await h.signUp('stranger@example.com');
  const experienceId = await publishText(h, author.actor);

  const created = expect(
    await reply(h, replier.actor, { experienceId, creationMode: 'text', bodyText: 'Mine.', visibility: 'public' }),
    'reply',
  );

  const attempt = await h.engine.bus.dispatch({
    name: 'conversation.deleteReply',
    input: { replyId: created.replyId },
    actor: stranger.actor,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(attempt.ok, false);
  if (!attempt.ok) assert.equal(attempt.error.code, 'policy_not_owner');
});

test('removing a parent experience cascades to its replies', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const replier = await h.signUp('replier@example.com');
  const moderator = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'moderator');
  const experienceId = await publishText(h, author.actor);

  const created = expect(
    await reply(h, replier.actor, { experienceId, creationMode: 'text', bodyText: 'Thread.', visibility: 'public' }),
    'reply',
  );

  expect(
    await h.engine.bus.dispatch({
      name: 'safety.applyModerationAction',
      input: { targetType: 'experience', targetId: experienceId, action: 'remove', reason: 'harassment' },
      actor: moderator,
      idempotencyKey: h.nextKey(),
    }),
    'remove',
  );
  await h.settle();

  assert.equal(
    (await h.engine.store.replies.get(created.replyId))?.status,
    'removed',
    'a thread must not outlive the content it belongs to',
  );
});
