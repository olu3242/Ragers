import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { connectionsOf, relationshipGraphFor } from '../../src/engines/relationship.engine.ts';
import { relatedTo } from '../../src/engines/relation.engine.ts';
import { memoryFor } from '../../src/engines/memory.engine.ts';
import { forbiddenMemoryKeysIn } from '../../src/domain/memory.ts';
import { patternHistoryFor } from '../../src/engines/history.engine.ts';
import { clusterLifecycleFor, signalIsCurrent } from '../../src/engines/lifecycle.engine.ts';
import { degreeOf } from '../../src/domain/relationship.ts';
import { EXPIRES_AFTER_MS, STABILIZING_AFTER_MS } from '../../src/domain/signal-lifecycle.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';

/**
 * Phases 51–55 through the real bus, the real policy matrix and the real store.
 *
 * These are reads over rows the earlier bands already own, so the thing worth testing
 * end to end is not that the arithmetic works — the unit tests hold that — but that
 * the reads see what the commands actually wrote, and that they refuse to disclose
 * what the earlier bands refuse to disclose.
 */
const DAY = 86_400_000;

const setUp = async (h: EngineHarness): Promise<void> => {
  await h.engine.store.entities.put({ id: 'ent_1', name: 'Northwind Air', slug: 'northwind-air', kind: 'organization' });
  await h.engine.store.entityAliases.put({ id: 'ali_e1', entityId: 'ent_1', alias: 'Northwind Air' });
  await h.engine.store.categories.put({ id: 'cat_1', name: 'Shopping & service', slug: 'shopping-service' });
  await h.engine.store.issueTypes.put({
    id: 'iss_1',
    categoryId: 'cat_1',
    name: 'Refund not processed',
    slug: 'refund-not-processed',
  });
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

const confirm = async (h: EngineHarness, actor: ActorContext, experienceId: string): Promise<void> => {
  expect(
    await h.engine.bus.dispatch({
      name: 'normalization.confirm',
      input: { experienceId, fields: { entity: 'ent_1', category: 'cat_1', issueType: 'iss_1' } },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'confirm',
  );
  await h.settle();
};

// ── P51 the graph ─────────────────────────────────────────────────────────
test('a pair asserted and also clustered is one connection, and the degree does not double', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const ada = await h.signUp('ada@example.com', 'Ada');
  const ben = await h.signUp('ben@example.com', 'Ben');

  const first = await publish(h, ada.actor, 'The refund was promised and never arrived');
  const second = await publish(h, ben.actor, 'They promised a refund and it never came');
  // Confirming the same structure is what puts them in one cluster.
  await confirm(h, ada.actor, first);
  await confirm(h, ben.actor, second);

  const clustered = await h.engine.store.experiences.get(first);
  const alsoClustered = await h.engine.store.experiences.get(second);
  assert.ok(clustered?.clusterId, 'the first landed in a cluster');
  assert.equal(alsoClustered?.clusterId, clustered.clusterId, 'and so did the second');

  // Now somebody also asserts the pair by hand: a second route to one connection.
  expect(
    await h.engine.bus.dispatch({
      name: 'relation.assert',
      input: { fromExperienceId: first, toExperienceId: second, assertion: 'same_pattern' },
      actor: ada.actor,
      idempotencyKey: h.nextKey(),
    }),
    'relate',
  );
  await h.settle();

  const connections = await connectionsOf(h.engine, first);
  assert.equal(connections.length, 1, 'one connection, two reasons');
  assert.deepEqual(connections[0]?.reasons, ['same_pattern_asserted', 'same_cluster']);
  assert.equal(connections[0]?.trustWeight, 0);

  const graph = await relationshipGraphFor(h.engine, first);
  assert.equal(degreeOf(graph, first), 1, 'the degree counts connected pairs, not routes');
  assert.equal(graph.trustWeight, 0);
});

test('the graph walks two hops and says when it stopped', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const ada = await h.signUp('ada@example.com', 'Ada');
  const ben = await h.signUp('ben@example.com', 'Ben');
  const cleo = await h.signUp('cleo@example.com', 'Cleo');

  const one = await publish(h, ada.actor, 'The first account of the refund failure');
  const two = await publish(h, ben.actor, 'The second account of the refund failure');
  const three = await publish(h, cleo.actor, 'The third account, related to the second');

  const relate = async (from: string, to: string, actor: ActorContext) => {
    expect(
      await h.engine.bus.dispatch({
        name: 'relation.assert',
        input: { fromExperienceId: from, toExperienceId: to, assertion: 'same_pattern' },
        actor,
        idempotencyKey: h.nextKey(),
      }),
      'relate',
    );
    await h.settle();
  };
  await relate(one, two, ada.actor);
  await relate(two, three, ben.actor);

  const shallow = await relationshipGraphFor(h.engine, one, { depth: 1 });
  assert.deepEqual(shallow.nodes.map((node) => node.experienceId).sort(), [one, two].sort());
  assert.equal(shallow.truncated, true, 'there was more and it says so');

  const deeper = await relationshipGraphFor(h.engine, one, { depth: 2 });
  assert.deepEqual(deeper.nodes.map((node) => node.experienceId).sort(), [one, two, three].sort());
  assert.equal(deeper.nodes.find((node) => node.experienceId === three)?.depth, 2);
});

test('a graph does not disclose an experience moderation removed', async () => {
  // A relation is asserted while both are published, and the row survives one of them
  // being taken down afterwards. Without a status filter, a public read would name it.
  const h = createEngineHarness();
  await setUp(h);
  const ada = await h.signUp('ada@example.com', 'Ada');
  const ben = await h.signUp('ben@example.com', 'Ben');
  const admin = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'admin');

  const kept = await publish(h, ada.actor, 'The account that stays up');
  const removed = await publish(h, ben.actor, 'The account that gets taken down');
  expect(
    await h.engine.bus.dispatch({
      name: 'relation.assert',
      input: { fromExperienceId: kept, toExperienceId: removed, assertion: 'same_pattern' },
      actor: ada.actor,
      idempotencyKey: h.nextKey(),
    }),
    'relate',
  );
  await h.settle();
  assert.equal((await connectionsOf(h.engine, kept)).length, 1, 'connected while both are published');

  expect(
    await h.engine.bus.dispatch({
      name: 'safety.applyModerationAction',
      input: { targetType: 'experience', targetId: removed, action: 'remove', reason: 'harassment' },
      actor: admin,
      idempotencyKey: h.nextKey(),
    }),
    'remove',
  );
  await h.settle();

  assert.deepEqual(await connectionsOf(h.engine, kept), [], 'and not afterwards');
  assert.deepEqual(await relatedTo(h.engine, kept), [], 'including through the older read');
  const graph = await relationshipGraphFor(h.engine, kept);
  assert.equal(graph.edges.length, 0);
});

// ── P52 memory ────────────────────────────────────────────────────────────
test('a memory records what happened, in order, and names nobody', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const ada = await h.signUp('ada@example.com', 'Ada');
  const ben = await h.signUp('ben@example.com', 'Ben');
  const staff = await h.signUp('staff@example.com', 'Staff');

  const experienceId = await publish(h, ada.actor, 'The refund was promised and never arrived');
  await confirm(h, ada.actor, experienceId);

  expect(
    await h.engine.bus.dispatch({
      name: 'enrichment.assert',
      input: { experienceId, dimension: 'money_lost', amount: 640, currency: 'GBP' },
      actor: ada.actor,
      idempotencyKey: h.nextKey(),
    }),
    'assert cost',
  );
  h.clock.advance(DAY);
  expect(
    await h.engine.bus.dispatch({
      name: 'corroboration.create',
      input: { experienceId, type: 're_rage' },
      actor: ben.actor,
      idempotencyKey: h.nextKey(),
    }),
    'corroborate',
  );
  await h.settle();

  await h.engine.store.organizationProfiles.put({
    id: 'org_1',
    entityId: 'ent_1',
    displayName: 'Northwind Air',
    claimedBy: staff.auth.actorId,
    claimedAt: h.clock.now(),
    status: 'claimed',
  });
  await h.engine.store.organizationMemberships.put({
    id: 'mem_1',
    organizationId: 'org_1',
    actorId: staff.auth.actorId,
    role: 'admin',
    grantedAt: h.clock.now(),
  });
  h.clock.advance(DAY);
  expect(
    await h.engine.bus.dispatch({
      name: 'organization.respond',
      input: { organizationId: 'org_1', experienceId, kind: 'acknowledge', body: 'We are looking into this' },
      actor: staff.actor,
      idempotencyKey: h.nextKey(),
    }),
    'respond',
  );
  h.clock.advance(DAY);
  expect(
    await h.engine.bus.dispatch({
      name: 'resolution.report',
      input: { experienceId, kind: 'still_unresolved' },
      actor: ada.actor,
      idempotencyKey: h.nextKey(),
    }),
    'report',
  );
  await h.settle();

  const memory = await memoryFor(h.engine, experienceId);
  assert.ok(memory);
  const kinds = memory.entries.map((item) => item.kind);
  assert.deepEqual(
    [...new Set(kinds)].sort(),
    [
      'corroborated',
      'cost_asserted',
      'organization_responded',
      // A report is what a person did; a change is what the engine derived from it.
      // Both belong in a history, and conflating them would make one person reporting
      // look like the outcome having moved.
      'outcome_changed',
      'outcome_reported',
      'published',
      'structure_confirmed',
    ],
  );
  // Order is the whole point of a memory.
  const timestamps = memory.entries.map((item) => item.at);
  assert.deepEqual([...timestamps].sort((left, right) => left - right), timestamps);
  assert.equal(memory.contributorCount, 2, 'the author and one corroborator');

  // No person, no prose. The body said "refund"; the response said "looking into
  // this"; neither is anywhere in here.
  assert.deepEqual(forbiddenMemoryKeysIn(memory), []);
  const serialised = JSON.stringify(memory);
  assert.ok(!serialised.includes(ada.auth.actorId), 'the author is not named');
  assert.ok(!serialised.includes(ben.auth.actorId), 'the corroborator is not named');
  assert.ok(!serialised.includes('looking into this'), 'the response text is not carried');
  assert.ok(!serialised.includes('refund'), 'and neither is the body');
  // The figure itself: asserted against the detail values rather than by substring,
  // because a millisecond timestamp happens to contain most short digit strings.
  const cost = memory.entries.find((item) => item.kind === 'cost_asserted');
  assert.deepEqual(cost?.detail, { dimension: 'money_lost', provenance: 'experiencer', stated: true });
  for (const item of memory.entries) {
    assert.ok(!('amount' in item.detail), 'no entry carries an amount');
  }
});

test('a memory of an experience that does not exist is undefined, not empty', async () => {
  const h = createEngineHarness();
  assert.equal(await memoryFor(h.engine, 'exp_missing'), undefined);
});

// ── P53 pattern history ───────────────────────────────────────────────────
test('a pattern history is a series, and a period with too few people is suppressed', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const staff = await h.signUp('staff@example.com', 'Staff');
  await h.engine.store.organizationProfiles.put({
    id: 'org_1',
    entityId: 'ent_1',
    displayName: 'Northwind Air',
    claimedBy: staff.auth.actorId,
    claimedAt: h.clock.now(),
    status: 'claimed',
  });

  // Three accounts from three people in one period: above nothing, below the floor.
  for (const name of ['one', 'two', 'three']) {
    const person = await h.signUp(`${name}@example.com`, name);
    const id = await publish(h, person.actor, `Account ${name} of the refund failure`);
    await confirm(h, person.actor, id);
  }

  const history = await patternHistoryFor(h.engine, 'org_1', { periods: 3 });
  assert.ok(history);
  assert.equal(history.volume.points.length, 3);
  const latest = history.volume.points.at(-1);
  // The accounts actually landed in the newest period, which the newest period's
  // end being *now* rather than *before now* is what makes true. Asserted because a
  // series whose latest bucket excludes the present instant reports every period
  // empty and every period suppressed — the right answer for the wrong reason.
  assert.equal(latest?.newContributors, 3, 'the three people are in the newest period');
  assert.equal(latest?.aggregate.suppressed, true, 'three people is below the person floor');
  assert.equal(latest?.aggregate.suppressed === true && latest.aggregate.reason, 'too_few_people');
  // And with a suppressed period, no change may be stated across it.
  assert.ok(history.volumeChanges.every((change) => change.withheld));
});

test('an unknown organization has no history rather than an empty one', async () => {
  const h = createEngineHarness();
  assert.equal(await patternHistoryFor(h.engine, 'org_missing'), undefined);
});

// ── P54 + P55 lifecycle and decay ─────────────────────────────────────────
test('a signal is current while people are reporting it, and stops being current when they stop', async () => {
  const h = createEngineHarness();
  await setUp(h);

  // Enough people to clear the reporting floor, all in one cluster.
  const people = [];
  let clusterId: string | undefined;
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const person = await h.signUp(`${name}@example.com`, name);
    people.push(person);
    const id = await publish(h, person.actor, `Account ${name}: the refund never arrived`);
    await confirm(h, person.actor, id);
    clusterId = (await h.engine.store.experiences.get(id))?.clusterId ?? clusterId;
  }
  assert.ok(clusterId, 'they share a cluster');

  const live = await clusterLifecycleFor(h.engine, clusterId);
  assert.ok(live);
  assert.equal(live.lifecycle.state, 'active');
  assert.equal(live.lifecycle.current, true);
  assert.equal(live.uniqueExperiencers, 6);
  assert.ok(live.weight.weight > 0);
  assert.equal(await signalIsCurrent(h.engine, clusterId), true);

  // Nothing changes except time.
  h.clock.advance(STABILIZING_AFTER_MS + DAY);
  const stale = await clusterLifecycleFor(h.engine, clusterId);
  assert.equal(stale?.lifecycle.state, 'stabilizing');
  assert.equal(stale?.lifecycle.current, false, 'a stale signal must not read as live');
  assert.equal(await signalIsCurrent(h.engine, clusterId), false);
  assert.equal(stale?.weight.contributionCount, live.weight.contributionCount, 'every row is still there');
  assert.ok((stale?.weight.weight ?? 0) < live.weight.weight, 'but it weighs less');

  h.clock.advance(EXPIRES_AFTER_MS);
  const expired = await clusterLifecycleFor(h.engine, clusterId);
  assert.equal(expired?.lifecycle.state, 'expired');
  assert.equal(expired?.weight.contributionCount, live.weight.contributionCount, 'and still is');
});

test('an unknown cluster has no lifecycle, and is not current', async () => {
  const h = createEngineHarness();
  assert.equal(await clusterLifecycleFor(h.engine, 'clu_missing'), undefined);
  assert.equal(await signalIsCurrent(h.engine, 'clu_missing'), false);
});
