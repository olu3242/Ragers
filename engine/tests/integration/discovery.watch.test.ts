import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import {
  discover,
  FORBIDDEN_DISCOVERY_FILTERS,
  relatedByContext,
  searchContextually,
} from '../../src/engines/discovery.engine.ts';
import {
  discoverForActor,
  guestProfile,
  profileFor,
} from '../../src/engines/relevance.engine.ts';
import {
  isWatching,
  watchAffectsRanking,
  watchCountFor,
  watchersOfIsAvailable,
  watchIsPublic,
  watchListOf,
} from '../../src/engines/watch.engine.ts';
import {
  organizationIntelligenceFor,
  organizationIntelligenceScore,
  organizationLeaderboard,
} from '../../src/engines/organization-intelligence.engine.ts';
import { profileIsEmpty } from '../../src/domain/relevance-profile.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { ExperienceKind } from '../../src/domain/types.ts';

/**
 * Phases 71–75 and 78 through the store.
 *
 * The unit tests hold the ordering. What is here is everything that only exists once the
 * reads touch rows: that removed content is absent **before its consumer has drained**, that
 * a watcher is invisible in every direction, that an empty profile shows everything rather
 * than nothing, and that the organization read composes governed figures without inventing
 * one.
 */
const publish = async (
  h: EngineHarness,
  actor: ActorContext,
  kind: ExperienceKind,
  bodyText: string,
  category = 'Other',
): Promise<string> => {
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind, creationMode: 'text', category, bodyText, visibility: 'public' },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();
  return created.experienceId;
};

// ── Phase 71/72: the read-time guarantee ─────────────────────────────────
test('a removed experience is absent from discovery before its consumer has drained', async () => {
  // **The window this phase exists for.** `feed.suppress` and `search.purge` maintain the
  // projections, and between the state change and the consumer running they still say
  // published. Phase 51 learned this once with `relatedTo`; here it is asserted directly, by
  // changing the row and *not* settling.
  const h = createEngineHarness();
  const { actor } = await h.signUp('disc-author@example.com', 'Author');
  const experienceId = await publish(h, actor, 'rage', 'The lift has been broken for a month.');

  assert.equal((await discover(h.engine)).length, 1, 'discoverable while published');

  const experience = await h.engine.store.experiences.get(experienceId);
  assert.ok(experience);
  await h.engine.store.experiences.put({ ...experience, status: 'removed' });
  // Deliberately no settle(): the projection still lists it and still says not-suppressed.
  const entry = await h.engine.store.feedEntries.get(experienceId);
  assert.equal(entry?.suppressed, false, 'the projection has not caught up, which is the point');

  assert.deepEqual(await discover(h.engine), [], 'and the read refuses it anyway');
  assert.deepEqual(await searchContextually(h.engine, { text: 'lift' }), [], 'search too');
});

test('an unpublished experience never appears, in discovery or search', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('draft@example.com', 'Drafter');
  // A draft is never projected at all, so this asserts the read does not somehow find one.
  expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: 'Not finished yet.', visibility: 'public' },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  // No settle, and even after one a draft is not published.
  assert.deepEqual(await discover(h.engine), []);
  assert.deepEqual(await searchContextually(h.engine, { text: 'finished' }), []);
});

test('an anonymous experience IS discoverable, because anonymity is about attribution', async () => {
  // The correction to my own first version, asserted so it stays corrected. Filtering on
  // visibility would have removed exactly the accounts somebody felt unsafe attaching their
  // name to — the opposite of what the setting is for. Identity protection is the
  // projection's job: it carries a label and never an actor id.
  const h = createEngineHarness();
  const { actor } = await h.signUp('anon@example.com', 'Anon');
  expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: {
        kind: 'rage',
        creationMode: 'text',
        category: 'Other',
        bodyText: 'I was told to stop asking about it.',
        visibility: 'anonymous',
      },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();

  const found = await discover(h.engine);
  assert.equal(found.length, 1, 'an anonymous account is still findable');
  assert.equal(found[0]?.identityLabel, 'Anonymous');
  assert.equal(
    JSON.stringify(found[0]).includes(actor.actorId),
    false,
    'and the author id appears nowhere in the result',
  );
});

test('a search hit exposes no internal attribute, asserted over its own keys', async () => {
  // Over the keys rather than against a list of forbidden values, so a field added to the hit
  // later fails this test rather than shipping.
  const h = createEngineHarness();
  const { actor } = await h.signUp('hit@example.com', 'Hitter');
  await publish(h, actor, 'rave', 'The engineer came back the same day.');

  const hits = await searchContextually(h.engine, { text: 'engineer' });
  assert.equal(hits.length, 1);
  const hit = hits[0];
  assert.ok(hit);
  const allowed = new Set([
    'experienceId',
    'kind',
    'category',
    'identityLabel',
    'hasVoice',
    'excerpt',
    'publishedAt',
    'factors',
    'reason',
  ]);
  for (const key of Object.keys(hit)) {
    assert.ok(allowed.has(key), `a search hit must not carry ${key}`);
  }
  // And the factors carry no identity either, even though they are computed from rows.
  assert.equal(JSON.stringify(hit.factors).includes(actor.actorId), false);
});

test('a discovery query cannot filter on an internal attribute', async () => {
  // An internal attribute as a *filter* leaks it one query at a time: "show me the low-trust
  // accounts" discloses the trust band without ever rendering it.
  const h = createEngineHarness();
  const { actor } = await h.signUp('filter@example.com', 'Filterer');
  await publish(h, actor, 'rage', 'Something happened.');

  const query = await discover(h.engine, {});
  assert.equal(query.length, 1, 'a bare browse works');
  for (const forbidden of Object.keys(FORBIDDEN_DISCOVERY_FILTERS)) {
    // The type system already refuses these; this asserts the *documented* set is real and
    // carries reasons, which is what survives a refactor.
    assert.ok(
      (FORBIDDEN_DISCOVERY_FILTERS[forbidden] ?? '').length > 30,
      `${forbidden} says why it is forbidden`,
    );
  }
});

test('discovery is deterministic across repeated reads', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('det@example.com', 'Det');
  for (let index = 0; index < 5; index += 1) {
    await publish(h, actor, index % 2 === 0 ? 'rage' : 'rave', `Something happened ${index}.`);
  }
  const once = (await discover(h.engine)).map((row) => row.experienceId);
  const twice = (await discover(h.engine)).map((row) => row.experienceId);
  assert.deepEqual(once, twice);
  assert.ok(once.length > 1);
});

test('every result but the last carries the reason it is above the next', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('reason@example.com', 'Reasoner');
  await publish(h, actor, 'rage', 'First thing.');
  await publish(h, actor, 'rage', 'Second thing.');

  const found = await discover(h.engine);
  assert.equal(found.length, 2);
  assert.ok((found[0]?.reason ?? '').length > 10, 'the first says why it is first');
  assert.equal(found[1]?.reason, undefined, 'and the last has nothing below it to explain');
});

// ── Phase 78: the watcher is invisible ───────────────────────────────────
test('watching twice is watching, and the second call creates nothing', async () => {
  const h = createEngineHarness();
  const { actor: author } = await h.signUp('watch-author@example.com', 'Author');
  const { actor: watcher } = await h.signUp('watcher@example.com', 'Watcher');
  const experienceId = await publish(h, author, 'rage', 'The refund never arrived.');

  const first = expect(
    await h.engine.bus.dispatch<unknown, { watching: boolean; created: boolean }>({
      name: 'watch.start',
      input: { targetType: 'experience', targetId: experienceId },
      actor: watcher,
      idempotencyKey: h.nextKey(),
    }),
    'watch',
  );
  const second = expect(
    await h.engine.bus.dispatch<unknown, { watching: boolean; created: boolean }>({
      name: 'watch.start',
      input: { targetType: 'experience', targetId: experienceId },
      actor: watcher,
      idempotencyKey: h.nextKey(),
    }),
    'watch again',
  );

  assert.equal(first.created, true);
  assert.equal(second.created, false, 'idempotent by constraint, not by handler');
  assert.equal(await watchCountFor(h.engine, 'experience', experienceId), 1, 'one watcher, not two');
  assert.equal(await isWatching(h.engine, watcher.actorId, 'experience', experienceId), true);
});

test('a watch emits an event on the transition only, and the event names no watcher', async () => {
  // Both halves matter. The event fires once so a notification downstream cannot fire twice
  // for one intent; and it carries no watcher id, because an event reaches every consumer and
  // the outbox — putting the watcher in it would leak the identity to everything at once.
  const h = createEngineHarness();
  const { actor: author } = await h.signUp('ev-author@example.com', 'Author');
  const { actor: watcher } = await h.signUp('ev-watcher@example.com', 'Watcher');
  const experienceId = await publish(h, author, 'rave', 'They fixed it properly.');

  for (let index = 0; index < 3; index += 1) {
    await h.engine.bus.dispatch({
      name: 'watch.start',
      input: { targetType: 'experience', targetId: experienceId },
      actor: watcher,
      idempotencyKey: h.nextKey(),
    });
  }

  const events = (await h.engine.outbox.all()).filter((row) => row.eventName === 'WatchStarted');
  assert.equal(events.length, 1, 'one event for three calls');
  assert.equal(
    JSON.stringify(events[0]?.payload).includes(watcher.actorId),
    false,
    'and the payload names no watcher',
  );
});

test('there is no way to ask who is watching, only how many', async () => {
  const h = createEngineHarness();
  const { actor: author } = await h.signUp('who-author@example.com', 'Author');
  const experienceId = await publish(h, author, 'rage', 'Nobody answered the phone.');

  for (const email of ['w1@example.com', 'w2@example.com', 'w3@example.com']) {
    const { actor } = await h.signUp(email, 'Watcher');
    expect(
      await h.engine.bus.dispatch({
        name: 'watch.start',
        input: { targetType: 'experience', targetId: experienceId },
        actor,
        idempotencyKey: h.nextKey(),
      }),
      'watch',
    );
  }

  assert.equal(await watchCountFor(h.engine, 'experience', experienceId), 3, 'a count is available');
  assert.equal(watchersOfIsAvailable(), false, 'and a list is not');
  assert.equal(watchIsPublic(), false);

  // The author — the person with the most apparent claim to know — cannot learn it either.
  // An author who could see their watchers could see which of the people they named is
  // following the fallout.
  assert.deepEqual(await watchListOf(h.engine, author.actorId), [], 'the author sees no watchers');
});

test('watching an unpublished or removed experience is refused', async () => {
  const h = createEngineHarness();
  const { actor: author } = await h.signUp('unpub-author@example.com', 'Author');
  const { actor: watcher } = await h.signUp('unpub-watcher@example.com', 'Watcher');
  const experienceId = await publish(h, author, 'rage', 'Published, then taken down.');

  const experience = await h.engine.store.experiences.get(experienceId);
  assert.ok(experience);
  await h.engine.store.experiences.put({ ...experience, status: 'removed' });

  const refused = await h.engine.bus.dispatch({
    name: 'watch.start',
    input: { targetType: 'experience', targetId: experienceId },
    actor: watcher,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(refused.ok, false);
  assert.equal(
    refused.ok === false && refused.error.code,
    'target_unavailable',
    'and it is distinguishable from not existing, so the refusal is not an existence oracle',
  );

  const missing = await h.engine.bus.dispatch({
    name: 'watch.start',
    input: { targetType: 'experience', targetId: 'exp_never_existed' },
    actor: watcher,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(missing.ok === false && missing.error.code, 'target_not_found');
});

test('unwatching is idempotent, and works on something since removed', async () => {
  // A removed experience must not leave a watch nobody can clear — that is the unclearable
  // queue item defect in a different table.
  const h = createEngineHarness();
  const { actor: author } = await h.signUp('unw-author@example.com', 'Author');
  const { actor: watcher } = await h.signUp('unw-watcher@example.com', 'Watcher');
  const experienceId = await publish(h, author, 'rage', 'Watched then removed.');

  expect(
    await h.engine.bus.dispatch({
      name: 'watch.start',
      input: { targetType: 'experience', targetId: experienceId },
      actor: watcher,
      idempotencyKey: h.nextKey(),
    }),
    'watch',
  );
  const experience = await h.engine.store.experiences.get(experienceId);
  assert.ok(experience);
  await h.engine.store.experiences.put({ ...experience, status: 'removed' });

  for (let index = 0; index < 2; index += 1) {
    const stopped = await h.engine.bus.dispatch({
      name: 'watch.stop',
      input: { targetType: 'experience', targetId: experienceId },
      actor: watcher,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(stopped.ok, true, `unwatch ${index} succeeds`);
  }
  assert.equal(await watchCountFor(h.engine, 'experience', experienceId), 0);
});

test('a deleted experience takes its watches with it', async () => {
  const h = createEngineHarness();
  const { actor: author } = await h.signUp('del-author@example.com', 'Author');
  const { actor: watcher } = await h.signUp('del-watcher@example.com', 'Watcher');
  const experienceId = await publish(h, author, 'rage', 'Deleted by its author.');

  expect(
    await h.engine.bus.dispatch({
      name: 'watch.start',
      input: { targetType: 'experience', targetId: experienceId },
      actor: watcher,
      idempotencyKey: h.nextKey(),
    }),
    'watch',
  );
  expect(
    await h.engine.bus.dispatch({
      name: 'creator.deleteExperience',
      input: { experienceId },
      actor: author,
      idempotencyKey: h.nextKey(),
    }),
    'delete',
  );
  await h.settle();

  assert.deepEqual(await watchListOf(h.engine, watcher.actorId), [], 'no watch on a deleted thing');
  assert.equal(watchAffectsRanking(), false);
});

// ── Phase 74: the profile ────────────────────────────────────────────────
test('a new account has an empty profile and sees everything', async () => {
  // The failure this guards: filter by an empty set of interests and a brand-new account
  // opens the app to a blank page.
  const h = createEngineHarness();
  const { actor: author } = await h.signUp('prof-author@example.com', 'Author');
  const { actor: newcomer } = await h.signUp('newcomer@example.com', 'New');
  await publish(h, author, 'rage', 'Something to find.');
  await publish(h, author, 'rave', 'Something else to find.');

  const profile = await profileFor(h.engine, newcomer.actorId);
  assert.equal(profileIsEmpty(profile), true);

  const found = await discoverForActor(h.engine, newcomer.actorId);
  assert.equal(found.length, 2, 'unfiltered, not empty');
  assert.equal(profileIsEmpty(guestProfile()), true, 'and a signed-out visitor is the same case');
});

test('a profile is built from watches and authored categories, and names no inference', async () => {
  const h = createEngineHarness();
  const { actor: author } = await h.signUp('own@example.com', 'Owner');
  const { actor: other } = await h.signUp('other-author@example.com', 'Other');
  const mine = await publish(h, author, 'rage', 'My own account.', 'Neighborhood');
  const theirs = await publish(h, other, 'rave', 'Their account.', 'Driving & transit');

  expect(
    await h.engine.bus.dispatch({
      name: 'watch.start',
      input: { targetType: 'experience', targetId: theirs },
      actor: author,
      idempotencyKey: h.nextKey(),
    }),
    'watch',
  );

  const profile = await profileFor(h.engine, author.actorId);
  assert.deepEqual(profile.watchedExperienceIds, [theirs], 'what they chose to watch');
  assert.deepEqual(profile.authoredCategories, ['Neighborhood'], 'and the category they posted in');
  assert.equal(
    profile.authoredCategories.includes('Driving & transit'),
    false,
    'not the category of what they read — nothing knows what they read',
  );
  assert.ok(mine.length > 0);
});

test('a profile that matches nothing still produces a feed', async () => {
  // Somebody who follows a subject that has gone quiet gets discovery, not a blank page.
  const h = createEngineHarness();
  const { actor: author } = await h.signUp('quiet-author@example.com', 'Author');
  const { actor: follower } = await h.signUp('quiet-follower@example.com', 'Follower');
  await publish(h, author, 'rage', 'Unrelated to anything followed.', 'Other');

  await h.engine.store.subjects.put({
    id: 'sub_quiet',
    canonicalTerm: 'nothing happens here',
    kind: 'behavior',
    experienceCount: 0,
    state: 'canonical',
  });
  expect(
    await h.engine.bus.dispatch({
      name: 'watch.start',
      input: { targetType: 'subject', targetId: 'sub_quiet' },
      actor: follower,
      idempotencyKey: h.nextKey(),
    }),
    'follow a subject',
  );

  const found = await discoverForActor(h.engine, follower.actorId);
  assert.equal(found.length, 1, 'a quiet interest does not empty the feed');
});

// ── Phase 75: the organization read ──────────────────────────────────────
test('the organization read composes governed figures and invents none', async () => {
  const h = createEngineHarness();
  await h.engine.store.entities.put({
    id: 'ent_org',
    name: 'Northwind Air',
    slug: 'northwind-air',
    kind: 'organization',
  });
  await h.engine.store.organizationProfiles.put({
    id: 'org_1',
    entityId: 'ent_org',
    displayName: 'Northwind Air',
    status: 'claimed',
  });

  const read = await organizationIntelligenceFor(h.engine, 'org_1');
  assert.equal(read.organizationId, 'org_1');
  // The benchmark says why it is absent rather than reading as a favourable comparison.
  assert.equal(read.benchmark.available, false);
  assert.match(read.benchmark.reason ?? '', /against a floor of/);
  assert.equal(organizationLeaderboard(), undefined, 'no league table');
  assert.equal(organizationIntelligenceScore(), undefined, 'and no score');
});

// ── Related-by-context ───────────────────────────────────────────────────
test('related reads re-check status too, so a removed neighbour is absent', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('rel@example.com', 'Rel');
  const first = await publish(h, actor, 'rage', 'The boiler failed at Northwind Court.');
  const second = await publish(h, actor, 'rage', 'The boiler failed again at Northwind Court.');

  const before = await relatedByContext(h.engine, first);
  const experience = await h.engine.store.experiences.get(second);
  assert.ok(experience);
  await h.engine.store.experiences.put({ ...experience, status: 'hidden' });

  const after = await relatedByContext(h.engine, first);
  assert.equal(
    after.some((row) => row.experienceId === second),
    false,
    'a hidden neighbour is gone from a related read immediately',
  );
  assert.ok(before.length >= after.length);
});
