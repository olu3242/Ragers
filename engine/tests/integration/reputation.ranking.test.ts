import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import {
  aliasReputationOf,
  publicReputationOf,
  recomputeReputation,
  standingFor,
} from '../../src/engines/reputation.engine.ts';
import {
  balanceAdjustment,
  computeRanking,
  computeScore,
  computeTrends,
  getRankedFeed,
  recencyDecay,
} from '../../src/engines/ranking.engine.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { ExperienceKind } from '../../src/domain/types.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';

const publish = async (h: EngineHarness, actor: ActorContext, kind: ExperienceKind, bodyText: string) => {
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind, creationMode: 'text', category: 'Other', bodyText, visibility: 'public' },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();
  return created.experienceId;
};

test('reputation is derived from durable facts and is deterministic', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const voterA = await h.signUp('a@example.com');
  const voterB = await h.signUp('b@example.com');

  const experienceId = await publish(h, author.actor, 'rage', 'Blocked the path.');
  for (const [voter, isFair] of [
    [voterA.actor, true],
    [voterB.actor, false],
  ] as const) {
    expect(
      await h.engine.bus.dispatch({
        name: 'reaction.castFairVote',
        input: { experienceId, isFair },
        actor: voter,
        idempotencyKey: h.nextKey(),
      }),
      'vote',
    );
  }
  await h.settle();

  const first = await h.engine.store.reputation.get(author.auth.actorId);
  assert.equal(first?.experiencesPublished, 1);
  assert.equal(first?.fairYesReceived, 1);
  assert.equal(first?.fairNoReceived, 1);
  assert.equal(first?.approvalRate, 0.5);

  // Recomputing from the same facts yields the same values.
  const again = await recomputeReputation(h.engine, author.auth.actorId);
  assert.equal(again.approvalRate, first?.approvalRate);
  assert.equal(again.experiencesPublished, first?.experiencesPublished);
});

test('the public reputation shape omits standing and internal signals', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  await publish(h, author.actor, 'rave', 'Someone was kind.');

  const stored = await h.engine.store.reputation.get(author.auth.actorId);
  assert.ok(stored?.internalSignals, 'internal signals exist internally');

  const publicShape = await publicReputationOf(h.engine, author.auth.actorId);
  const serialised = JSON.stringify(publicShape);
  assert.equal(serialised.includes('internalSignals'), false);
  assert.equal(serialised.includes('standing'), false, 'standing is not shown to other users as a score');
  assert.equal(serialised.includes('removalsReceived'), false);
  assert.deepEqual(Object.keys(publicShape).sort(), ['approvalRate', 'experiencesPublished', 'totalFairVotes']);
});

test('alias reputation reports the alias only and cannot be linked back to the account', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com', 'Real Name');
  const alias = expect(
    await h.engine.bus.dispatch<unknown, { aliasId: string }>({
      name: 'identity.createAlias',
      input: { aliasName: 'quietone' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'alias',
  );
  expect(
    await h.engine.bus.dispatch({
      name: 'experience.create',
      input: {
        kind: 'rave',
        creationMode: 'text',
        category: 'Other',
        bodyText: 'Under an alias.',
        visibility: 'alias',
        aliasId: alias.aliasId,
      },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();

  const reputation = await aliasReputationOf(h.engine, alias.aliasId);
  assert.equal(reputation?.aliasName, 'quietone');
  assert.equal(reputation?.experiencesPublished, 1);
  const serialised = JSON.stringify(reputation);
  assert.equal(serialised.includes(author.auth.actorId), false, 'the owning actor must not be reachable');
  assert.equal(serialised.includes('Real Name'), false);
});

test('standing follows the documented tiers, with limited on repeated removals', () => {
  assert.equal(standingFor(0, 0, 0), 'new');
  assert.equal(standingFor(3, 0.5, 0), 'established');
  assert.equal(standingFor(20, 0.8, 0), 'trusted');
  assert.equal(standingFor(20, 0.79, 0), 'established', 'trust needs both volume and approval');
  assert.equal(standingFor(50, 0.95, 3), 'limited', 'enforcement overrides standing');
});

test('recency decay is monotonic in age and halves over the half-life', () => {
  assert.equal(recencyDecay(0), 1);
  assert.equal(recencyDecay(24 * 60 * 60 * 1_000), 0.5);
  assert.ok(recencyDecay(1_000) > recencyDecay(2_000));
  assert.ok(recencyDecay(48 * 60 * 60 * 1_000) < recencyDecay(24 * 60 * 60 * 1_000));
});

test('the balance adjustment lifts the under-represented kind and is zero when balanced', () => {
  const balanced = { rageCount: 5, raveCount: 5, targetRaveShare: 0.5 };
  assert.equal(balanceAdjustment('rage', balanced), 0);
  assert.equal(balanceAdjustment('rave', balanced), 0);

  // Rage-skewed corpus: Raves gain a lift, Rages do not.
  const skewed = { rageCount: 9, raveCount: 1, targetRaveShare: 0.5 };
  assert.ok(balanceAdjustment('rave', skewed) > 0, 'Raves are lifted when Rages dominate');
  assert.equal(balanceAdjustment('rage', skewed), 0);

  // And symmetrically the other way.
  const inverted = { rageCount: 1, raveCount: 9, targetRaveShare: 0.5 };
  assert.ok(balanceAdjustment('rage', inverted) > 0);
  assert.equal(balanceAdjustment('rave', inverted), 0);
});

test('ranking is deterministic for fixed inputs', () => {
  const parts = { engagementScore: 4, fairnessScore: 0.75, recencyDecay: 0.5, balanceAdjustment: 0.1 };
  const first = computeScore(parts);
  assert.equal(computeScore(parts), first);
  assert.equal(first, Number(((4 * 0.5 + 0.75 * 0.3 + 0.1) * 0.5).toFixed(6)));
});

test('a more-engaged experience outranks a less-engaged one of the same age', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const readers = await Promise.all([
    h.signUp('r1@example.com'),
    h.signUp('r2@example.com'),
    h.signUp('r3@example.com'),
  ]);

  const popular = await publish(h, author.actor, 'rage', 'Widely recognised annoyance.');
  const quiet = await publish(h, author.actor, 'rage', 'Barely noticed annoyance.');

  for (const reader of readers) {
    expect(
      await h.engine.bus.dispatch({
        name: 'reaction.toggle',
        input: { experienceId: popular, reactionType: 'same' },
        actor: reader.actor,
        idempotencyKey: h.nextKey(),
      }),
      'react',
    );
  }
  await h.settle();
  await computeRanking(h.engine);

  const feed = await getRankedFeed(h.engine);
  assert.equal(feed.order, 'ranked');
  assert.equal(feed.entries[0]?.experienceId, popular, 'engagement lifts the more-recognised experience');
  assert.equal(feed.entries[1]?.experienceId, quiet);
});

test('the feed falls back to chronological order when ranking has not run', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const first = await publish(h, author.actor, 'rage', 'Earlier.');
  h.clock.advance(60_000);
  const second = await publish(h, author.actor, 'rave', 'Later.');

  // Clear ranking inputs to simulate ranking never having run.
  for (const row of await h.engine.store.rankingInputs.all()) {
    await h.engine.store.rankingInputs.remove(row.id);
  }

  const feed = await getRankedFeed(h.engine);
  assert.equal(feed.order, 'chronological', 'the feed always renders');
  assert.equal(feed.entries[0]?.experienceId, second, 'newest first');
  assert.equal(feed.entries[1]?.experienceId, first);
});

test('removed content is unrankable', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const moderator = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'moderator');
  const experienceId = await publish(h, author.actor, 'rage', 'To be removed.');

  expect(
    await h.engine.bus.dispatch({
      name: 'safety.applyModerationAction',
      input: { targetType: 'experience', targetId: experienceId, action: 'remove', reason: 'spam' },
      actor: moderator,
      idempotencyKey: h.nextKey(),
    }),
    'remove',
  );
  await h.settle();

  const ranked = await computeRanking(h.engine);
  assert.equal(
    ranked.some((row) => row.experienceId === experienceId),
    false,
    'suppressed entries are excluded from ranking',
  );
  assert.equal((await getRankedFeed(h.engine)).entries.length, 0);
});

test('trends are suppressed below the volume threshold and appear once it is met', async () => {
  const h = createEngineHarness({ config: { trendMinVolume: 3 } });
  const author = await h.signUp('author@example.com');

  await publish(h, author.actor, 'rage', 'Someone blocked the crosswalk');
  await publish(h, author.actor, 'rage', 'Again blocked the crosswalk');
  assert.equal((await computeTrends(h.engine, '24h')).length, 0, 'two is below the threshold');

  await publish(h, author.actor, 'rage', 'A third blocked crosswalk today');
  const trends = await computeTrends(h.engine, '24h');
  assert.ok(trends.length > 0, 'the threshold is met, so trends appear');
  assert.ok(trends.every((trend) => trend.volume >= 3));
  assert.ok(trends.every((trend) => trend.state === 'trending'));
});
