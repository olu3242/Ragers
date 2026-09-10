import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { reviewCoordination, findingsForCluster, coordinationMutatesClaims } from '../../src/engines/coordination.engine.ts';
import { recommend, conclusionsFor, recommendationsFor } from '../../src/engines/conclusion.engine.ts';
import { eq } from '../../src/ports/store.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { CorroborationRow, QueueItem } from '../../src/ports/store.ts';

/**
 * Phases 62–64 through the real bus.
 *
 * The pure rules are held in `tests/unit/coordination.reply.test.ts`. Here: that a
 * review is actually opened and nothing else moves, that a reported reply can now be
 * actioned at all, and that a deletion stops being cited.
 */
const seedTaxonomy = async (h: EngineHarness): Promise<void> => {
  await h.engine.store.entities.put({ id: 'ent_1', name: 'Northwind Air', slug: 'northwind-air', kind: 'organization' });
  await h.engine.store.entityAliases.put({ id: 'ali_1', entityId: 'ent_1', alias: 'Northwind Air' });
  await h.engine.store.categories.put({ id: 'cat_1', name: 'Shopping & service', slug: 'shopping-service' });
  await h.engine.store.issueTypes.put({
    id: 'iss_1',
    categoryId: 'cat_1',
    name: 'Refund not processed',
    slug: 'refund-not-processed',
  });
};

const publish = async (h: EngineHarness, actor: ActorContext, body: string): Promise<string> => {
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'text', category: 'Shopping & service', bodyText: body, visibility: 'public' },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();
  expect(
    await h.engine.bus.dispatch({
      name: 'normalization.confirm',
      input: { experienceId: created.experienceId, fields: { entity: 'ent_1', category: 'cat_1', issueType: 'iss_1' } },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'confirm',
  );
  await h.settle();
  return created.experienceId;
};

// ── P62 ───────────────────────────────────────────────────────────────────
test('a cohort co-arriving across a cluster opens a review and changes no count', async () => {
  const h = createEngineHarness();
  await seedTaxonomy(h);

  // Three experiences from three different authors, in one cluster.
  const experiences: string[] = [];
  for (const name of ['one', 'two', 'three']) {
    const author = await h.signUp(`${name}@example.com`, name);
    experiences.push(await publish(h, author.actor, `Account ${name}: the refund never arrived`));
  }

  // And the same three accounts corroborating all three, within the window.
  const ring = [];
  for (const name of ['ring_a', 'ring_b', 'ring_c']) {
    ring.push(await h.signUp(`${name}@example.com`, name));
  }
  for (const experienceId of experiences) {
    for (const member of ring) {
      expect(
        await h.engine.bus.dispatch({
          name: 'corroboration.create',
          input: { experienceId, type: 're_rage' },
          actor: member.actor,
          idempotencyKey: h.nextKey(),
        }),
        'corroborate',
      );
      h.clock.advance(60_000);
    }
  }
  await h.settle();

  const clusterId = (await h.engine.store.experiences.get(experiences[0] as string))?.clusterId;
  assert.ok(clusterId, 'the accounts clustered');

  const claimsBefore = await h.engine.store.corroborations.countWhere([eq<CorroborationRow>('status', 'active')]);
  const findings = await findingsForCluster(h.engine, clusterId);
  assert.equal(findings.length, 1, 'one cohort');
  assert.equal(findings[0]?.cohort.length, 3);

  const opened = await reviewCoordination(h.engine, clusterId);
  assert.equal(opened.length, 1, 'one review');

  const item = await h.engine.store.queueItems.get(opened[0]?.queueItemId as string);
  assert.equal(item?.state, 'queued', 'a person has to look');
  assert.equal(item?.targetType, 'experience', 'the queue names the experience, not the accounts');

  // Nothing else moved. This is the property the phase exists for.
  assert.equal(
    await h.engine.store.corroborations.countWhere([eq<CorroborationRow>('status', 'active')]),
    claimsBefore,
    'not one claim was retracted, discounted or reweighted',
  );
  assert.equal(await h.engine.store.moderationActions.count(), 0, 'and no action was taken');
  assert.equal(coordinationMutatesClaims(), false);
});

test('a second sweep over unchanged state opens no second review', async () => {
  const h = createEngineHarness();
  await seedTaxonomy(h);
  const experiences: string[] = [];
  for (const name of ['one', 'two', 'three']) {
    const author = await h.signUp(`${name}@example.com`, name);
    experiences.push(await publish(h, author.actor, `Account ${name}: the refund never arrived`));
  }
  for (const name of ['ring_a', 'ring_b', 'ring_c']) {
    const member = await h.signUp(`${name}@example.com`, name);
    for (const experienceId of experiences) {
      expect(
        await h.engine.bus.dispatch({
          name: 'corroboration.create',
          input: { experienceId, type: 're_rage' },
          actor: member.actor,
          idempotencyKey: h.nextKey(),
        }),
        'corroborate',
      );
    }
  }
  await h.settle();
  const clusterId = (await h.engine.store.experiences.get(experiences[0] as string))?.clusterId as string;

  await reviewCoordination(h.engine, clusterId);
  const afterFirst = await h.engine.store.queueItems.count();
  await reviewCoordination(h.engine, clusterId);
  assert.equal(await h.engine.store.queueItems.count(), afterFirst, 'the sweep is idempotent');
});

// ── P63 ───────────────────────────────────────────────────────────────────
test('a reported reply can now be actioned, and the parent is untouched', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com', 'Author');
  const replier = await h.signUp('replier@example.com', 'Replier');
  const reporter = await h.signUp('reporter@example.com', 'Reporter');
  const admin = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'admin');

  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: 'The thing that happened', visibility: 'public' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();

  const reply = expect(
    await h.engine.bus.dispatch<unknown, { replyId: string }>({
      name: 'conversation.createReply',
      input: { experienceId: created.experienceId, creationMode: 'text', bodyText: 'Something unpleasant', visibility: 'public' },
      actor: replier.actor,
      idempotencyKey: h.nextKey(),
    }),
    'reply',
  );
  await h.settle();

  expect(
    await h.engine.bus.dispatch({
      name: 'safety.fileReport',
      input: { targetType: 'reply', targetId: reply.replyId, reasonCode: 'harassment' },
      actor: reporter.actor,
      idempotencyKey: h.nextKey(),
    }),
    'report',
  );
  await h.settle();

  const queued = await h.engine.store.queueItems.queryOne([
    eq<QueueItem>('targetType', 'reply'),
    eq<QueueItem>('targetId', reply.replyId),
  ]);
  assert.ok(queued, 'the reply is queued');

  // This is what could not happen before: the action resolved a reply and then loaded
  // an experience, so the queue item was unclearable.
  expect(
    await h.engine.bus.dispatch({
      name: 'safety.applyModerationAction',
      input: { targetType: 'reply', targetId: reply.replyId, action: 'remove', reason: 'harassment' },
      actor: admin,
      idempotencyKey: h.nextKey(),
    }),
    'moderate the reply',
  );
  await h.settle();

  assert.equal((await h.engine.store.replies.get(reply.replyId))?.status, 'removed');
  assert.equal(
    (await h.engine.store.queueItems.get(queued.id))?.state,
    'actioned',
    'and the queue item can finally be cleared',
  );
  assert.equal(
    (await h.engine.store.experiences.get(created.experienceId))?.status,
    'published',
    'the parent experience is untouched',
  );

  const action = await h.engine.store.moderationActions.findOne((row) => row.targetId === reply.replyId);
  assert.equal(action?.targetType, 'reply', 'recorded against the reply');
  assert.equal(action?.reason, 'harassment');

  const audited = await h.engine.store.auditEvents.findOne((row) => row.resourceId === reply.replyId);
  assert.ok(audited, 'and audited');
});

test('a report against a reply that does not exist is refused rather than queued', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('reporter@example.com', 'Reporter');
  const refused = await h.engine.bus.dispatch({
    name: 'safety.fileReport',
    input: { targetType: 'reply', targetId: 'rep_missing', reasonCode: 'spam' },
    actor,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.error.kind, 'not_found');
  assert.equal(await h.engine.store.queueItems.count(), 0, 'nothing unclearable was created');
});

// ── P64 ───────────────────────────────────────────────────────────────────
test('deleting an experience stops the recommendation ledger citing it', async () => {
  const h = createEngineHarness();
  await seedTaxonomy(h);
  const admin = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'admin');

  const authors = [];
  const experiences: string[] = [];
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const author = await h.signUp(`${name}@example.com`, name);
    authors.push(author);
    experiences.push(await publish(h, author.actor, `Account ${name}: the refund never arrived`));
  }
  const clusterId = (await h.engine.store.experiences.get(experiences[0] as string))?.clusterId as string;

  const [conclusion] = await conclusionsFor(h.engine, clusterId);
  assert.ok(conclusion);
  const recommended = await recommend(h.engine, conclusion, admin);
  assert.equal(recommended.created, true);
  assert.equal(recommended.row.acrossExperienceIds.length, 6);

  // The author of the first one deletes it.
  expect(
    await h.engine.bus.dispatch({
      name: 'creator.deleteExperience',
      input: { experienceId: experiences[0] },
      actor: authors[0]?.actor as ActorContext,
      idempotencyKey: h.nextKey(),
    }),
    'delete',
  );
  await h.settle();

  const after = await h.engine.store.recommendations.get(recommended.row.id);
  assert.ok(after, 'five experiences still make a pattern');
  assert.ok(
    !after.acrossExperienceIds.includes(experiences[0] as string),
    'and the deleted one is no longer cited by id',
  );
  assert.equal(after.acrossExperienceIds.length, 5);
});

test('a recommendation whose experiences fall below the floor is removed, not shrunk', async () => {
  const h = createEngineHarness();
  await seedTaxonomy(h);
  const admin = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'admin');

  const authors = [];
  const experiences: string[] = [];
  for (const name of ['a', 'b', 'c']) {
    const author = await h.signUp(`${name}@example.com`, name);
    authors.push(author);
    experiences.push(await publish(h, author.actor, `Account ${name}: the refund never arrived`));
  }
  const clusterId = (await h.engine.store.experiences.get(experiences[0] as string))?.clusterId as string;
  const [conclusion] = await conclusionsFor(h.engine, clusterId);
  assert.ok(conclusion);
  await recommend(h.engine, conclusion, admin);
  assert.equal((await recommendationsFor(h.engine, clusterId)).length, 1);

  // Two of the three go. What is left could never have been drawn as a conclusion, so
  // leaving a shrunken recommendation would assert something the contract refuses.
  for (const index of [0, 1]) {
    expect(
      await h.engine.bus.dispatch({
        name: 'creator.deleteExperience',
        input: { experienceId: experiences[index] },
        actor: authors[index]?.actor as ActorContext,
        idempotencyKey: h.nextKey(),
      }),
      'delete',
    );
    await h.settle();
  }

  assert.deepEqual(await recommendationsFor(h.engine, clusterId), [], 'the recommendation is gone entirely');
});

test('content removed by moderation also stops being cited', async () => {
  const h = createEngineHarness();
  await seedTaxonomy(h);
  const admin = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'admin');
  const experiences: string[] = [];
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const author = await h.signUp(`${name}@example.com`, name);
    experiences.push(await publish(h, author.actor, `Account ${name}: the refund never arrived`));
  }
  const clusterId = (await h.engine.store.experiences.get(experiences[0] as string))?.clusterId as string;
  const [conclusion] = await conclusionsFor(h.engine, clusterId);
  assert.ok(conclusion);
  const recommended = await recommend(h.engine, conclusion, admin);

  expect(
    await h.engine.bus.dispatch({
      name: 'safety.applyModerationAction',
      input: { targetType: 'experience', targetId: experiences[0], action: 'remove', reason: 'naming_shaming' },
      actor: admin,
      idempotencyKey: h.nextKey(),
    }),
    'remove',
  );
  await h.settle();

  const after = await h.engine.store.recommendations.get(recommended.row.id);
  assert.ok(!after?.acrossExperienceIds.includes(experiences[0] as string), 'removed content is not cited either');
});
