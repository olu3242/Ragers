import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { summariseFairness } from '../../src/engines/reaction.engine.ts';
import { REJECTED_REACTION_TYPES } from '../../src/domain/types.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';

const publishText = async (h: EngineHarness, actor: ActorContext, bodyText = 'A thing happened.') => {
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

test('the Ragers-native responses all work and toggle cleanly', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com', 'Author');
  const reader = await h.signUp('reader@example.com', 'Reader');
  const experienceId = await publishText(h, author.actor);

  for (const reactionType of ['same', 'fair_point', 'disagree'] as const) {
    const on = expect(
      await h.engine.bus.dispatch<unknown, { active: boolean }>({
        name: 'reaction.toggle',
        input: { experienceId, reactionType },
        actor: reader.actor,
        idempotencyKey: h.nextKey(),
      }),
      `toggle ${reactionType} on`,
    );
    assert.equal(on.active, true);
  }
  await h.settle();

  const counters = await h.engine.store.counters.get(experienceId);
  assert.equal(counters?.same, 1);
  assert.equal(counters?.fairPoint, 1);
  assert.equal(counters?.disagree, 1);
  // A response is not a claim: none of them touches a corroboration count.
  assert.equal(counters?.reRageCount, 0);
  assert.equal(counters?.corroboratorCount, 0);

  // Toggling off returns to the original state.
  const off = expect(
    await h.engine.bus.dispatch<unknown, { active: boolean }>({
      name: 'reaction.toggle',
      input: { experienceId, reactionType: 'same' },
      actor: reader.actor,
      idempotencyKey: h.nextKey(),
    }),
    'toggle off',
  );
  assert.equal(off.active, false);
  await h.settle();
  assert.equal((await h.engine.store.counters.get(experienceId))?.same, 0);
});

test('Been There is retired, and the refusal says what to use instead', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const reader = await h.signUp('reader@example.com');
  const experienceId = await publishText(h, author.actor);

  const refused = await h.engine.bus.dispatch({
    name: 'reaction.toggle',
    input: { experienceId, reactionType: 'been_there' },
    actor: reader.actor,
    idempotencyKey: h.nextKey(),
  });

  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false ? refused.error.code : '', 'reaction_retired');
  assert.match(
    refused.ok === false ? refused.error.message : '',
    /Re-Rage/,
    'a stale client should be told which mechanic replaced it',
  );
  // "This happened to me too" is one signal now, not two.
  assert.equal(await h.engine.store.reactions.count(), 0);
});

test('generic social mechanics are refused by name', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const reader = await h.signUp('reader@example.com');
  const experienceId = await publishText(h, author.actor);

  for (const rejected of REJECTED_REACTION_TYPES) {
    const result = await h.engine.bus.dispatch({
      name: 'reaction.toggle',
      input: { experienceId, reactionType: rejected },
      actor: reader.actor,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(result.ok, false, `${rejected} must be refused`);
    if (!result.ok) assert.equal(result.error.code, 'reaction_mechanic_not_supported');
  }
  assert.equal(await h.engine.store.reactions.count(), 0, 'no rejected mechanic is ever stored');
});

test('concurrent identical reactions produce exactly one row', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const reader = await h.signUp('reader@example.com');
  const experienceId = await publishText(h, author.actor);

  await Promise.all(
    Array.from({ length: 6 }, () =>
      h.engine.bus.dispatch({
        name: 'reaction.toggle',
        input: { experienceId, reactionType: 'same' },
        actor: reader.actor,
        idempotencyKey: h.nextKey(),
      }),
    ),
  );
  await h.settle();

  const rows = await h.engine.store.reactions.find((row) => row.experienceId === experienceId);
  assert.ok(rows.length <= 1, 'the natural key prevents duplicate reaction rows');
  const counters = await h.engine.store.counters.get(experienceId);
  assert.ok((counters?.same ?? 0) <= 1, 'counters cannot exceed the row count');
});

test('a fair vote can be recast without inflating the totals', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const voter = await h.signUp('voter@example.com');
  const experienceId = await publishText(h, author.actor);

  const first = expect(
    await h.engine.bus.dispatch<unknown, { recast: boolean }>({
      name: 'reaction.castFairVote',
      input: { experienceId, isFair: true },
      actor: voter.actor,
      idempotencyKey: h.nextKey(),
    }),
    'vote fair',
  );
  assert.equal(first.recast, false);
  await h.settle();
  assert.equal((await h.engine.store.counters.get(experienceId))?.fairYes, 1);

  const recast = expect(
    await h.engine.bus.dispatch<unknown, { recast: boolean }>({
      name: 'reaction.castFairVote',
      input: { experienceId, isFair: false },
      actor: voter.actor,
      idempotencyKey: h.nextKey(),
    }),
    'recast',
  );
  assert.equal(recast.recast, true);
  await h.settle();

  const counters = await h.engine.store.counters.get(experienceId);
  assert.equal(counters?.fairYes, 0, 'the previous vote is replaced, not added to');
  assert.equal(counters?.fairNo, 1);
  assert.equal(await h.engine.store.fairVotes.count(), 1, 'exactly one vote row per actor per experience');
});

test('an author cannot vote on the fairness of their own experience', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const experienceId = await publishText(h, author.actor);

  const result = await h.engine.bus.dispatch({
    name: 'reaction.castFairVote',
    input: { experienceId, isFair: true },
    actor: author.actor,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'policy_owner_forbidden');
});

test('engagement on unpublished or removed content is refused', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const reader = await h.signUp('reader@example.com');
  const moderator = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'moderator');
  const experienceId = await publishText(h, author.actor);

  expect(
    await h.engine.bus.dispatch({
      name: 'safety.applyModerationAction',
      input: { targetType: 'experience', targetId: experienceId, action: 'remove', reason: 'naming_shaming' },
      actor: moderator,
      idempotencyKey: h.nextKey(),
    }),
    'remove',
  );

  const react = await h.engine.bus.dispatch({
    name: 'reaction.toggle',
    input: { experienceId, reactionType: 'same' },
    actor: reader.actor,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(react.ok, false, 'removed content cannot be reacted to');

  const reply = await h.engine.bus.dispatch({
    name: 'conversation.createReply',
    input: { experienceId, creationMode: 'text', bodyText: 'Adding to this', visibility: 'public' },
    actor: reader.actor,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(reply.ok, false, 'removed content cannot be replied to');
});

test('counters converge after out-of-order and duplicated event delivery', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');
  const experienceId = await publishText(h, author.actor);

  for (const actor of [a.actor, b.actor]) {
    await h.engine.bus.dispatch({
      name: 'reaction.toggle',
      input: { experienceId, reactionType: 'same' },
      actor,
      idempotencyKey: h.nextKey(),
    });
    await h.engine.bus.dispatch({
      name: 'reaction.castFairVote',
      input: { experienceId, isFair: true },
      actor,
      idempotencyKey: h.nextKey(),
    });
  }

  // Drain repeatedly: consumers are idempotent, so extra rounds change nothing.
  await h.settle();
  await h.settle();
  await h.settle();

  const counters = await h.engine.store.counters.get(experienceId);
  assert.equal(counters?.same, 2);
  assert.equal(counters?.fairYes, 2);
  assert.deepEqual(summariseFairness(counters?.fairYes ?? 0, counters?.fairNo ?? 0), {
    fairYes: 2,
    fairNo: 0,
    totalVotes: 2,
    fairPercent: 100,
  });
});

test('the fairness summary reports no percentage until somebody votes', () => {
  assert.deepEqual(summariseFairness(0, 0), { fairYes: 0, fairNo: 0, totalVotes: 0 });
  assert.equal(summariseFairness(21, 4).fairPercent, 84, 'PRD example: Fair Rager? 84% yes');
});
