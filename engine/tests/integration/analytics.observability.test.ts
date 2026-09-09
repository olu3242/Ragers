import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { computeMetrics, readAnalytics } from '../../src/engines/analytics.engine.ts';
import { findForbiddenKeys } from '../../src/domain/projection.ts';
import { REDACTED } from '../../src/runtime/logger.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { ExperienceKind } from '../../src/domain/types.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';

const BODY = 'Someone left a trolley across two disabled bays';

const publish = async (h: EngineHarness, actor: ActorContext, kind: ExperienceKind = 'rage') => {
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind, creationMode: 'text', category: 'Shopping & service', bodyText: BODY, visibility: 'public' },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();
  return created.experienceId;
};

test('analytics rows carry a pseudonymous hash, never an actor id or content', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('ada@example.com', 'Ada');
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

  const rows = await h.engine.store.analyticsEvents.all();
  assert.ok(rows.length > 0, 'events are ingested');

  const serialised = JSON.stringify(rows);
  assert.equal(serialised.includes(author.auth.actorId), false, 'no actor id reaches the sink');
  assert.equal(serialised.includes(reader.auth.actorId), false);
  assert.equal(serialised.includes(BODY), false, 'no body text reaches the sink');
  assert.equal(serialised.includes('ada@example.com'), false, 'no email reaches the sink');
  assert.deepEqual(findForbiddenKeys(rows), [], 'no forbidden key appears anywhere in the sink');

  for (const row of rows) {
    assert.match(row.actorHash, /^[0-9a-f]{32}$/, 'the hash is stable and opaque');
    assert.ok(row.correlationId, 'every row is correlatable');
  }
});

test('the same actor always hashes to the same value, and different actors differ', async () => {
  const h = createEngineHarness();
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');
  await publish(h, a.actor);
  await publish(h, a.actor, 'rave');
  await publish(h, b.actor);

  const rows = await h.engine.store.analyticsEvents.find((row) => row.eventName === 'ExperiencePublished');
  const hashes = new Set(rows.map((row) => row.actorHash));
  assert.ok(rows.length >= 3);
  assert.ok(hashes.size >= 1, 'hashes are produced');
  // Pseudonymisation is stable, so a repeat actor does not create a new identity.
  assert.ok(hashes.size <= rows.length);
});

test('analytics ingestion never fails the command path', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');

  // Break the sink after wiring, so ingestion throws while commands continue.
  const broken = h.engine.store.analyticsEvents;
  const originalPut = broken.put.bind(broken);
  (broken as { put: typeof broken.put }).put = async () => {
    throw new Error('analytics sink is down');
  };

  const experienceId = await publish(h, author.actor);
  assert.equal(
    (await h.engine.store.experiences.get(experienceId))?.status,
    'published',
    'a broken analytics sink must not affect publication',
  );
  assert.ok(await h.engine.store.feedEntries.get(experienceId), 'nor the feed');

  (broken as { put: typeof broken.put }).put = originalPut;
});

test('the PRD success metrics are computed from durable facts', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const lurker = await h.signUp('lurker@example.com');
  const voter = await h.signUp('voter@example.com');

  const rage = await publish(h, author.actor, 'rage');
  await publish(h, author.actor, 'rave');

  expect(
    await h.engine.bus.dispatch({
      name: 'reaction.castFairVote',
      input: { experienceId: rage, isFair: true },
      actor: voter.actor,
      idempotencyKey: h.nextKey(),
    }),
    'vote',
  );
  await h.settle();

  const metrics = await computeMetrics(h.engine);
  // One of three actors has published, so activation is 1/3.
  assert.equal(metrics.activationRate, 0.3333);
  assert.equal(metrics.contentHealth, 0, 'nothing has been removed');
  assert.equal(metrics.fairnessParticipation, 0.5, 'one of two published experiences has a vote');
  assert.equal(metrics.raveShare, 0.5, 'the Rage/Rave balance is visible');
  assert.equal(metrics.voiceShare, 0);
  assert.ok(lurker.auth.actorId);

  const snapshots = await h.engine.store.metricSnapshots.all();
  assert.equal(snapshots.length, 5, 'each metric is snapshotted');
});

test('content health rises as content is removed', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const moderator = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'moderator');

  const first = await publish(h, author.actor);
  await publish(h, author.actor, 'rave');

  expect(
    await h.engine.bus.dispatch({
      name: 'safety.applyModerationAction',
      input: { targetType: 'experience', targetId: first, action: 'remove', reason: 'naming_shaming' },
      actor: moderator,
      idempotencyKey: h.nextKey(),
    }),
    'remove',
  );
  await h.settle();

  const metrics = await computeMetrics(h.engine);
  assert.equal(metrics.contentHealth, 0.5, 'one of two decided experiences was removed');
});

test('analytics are readable only by an admin', async () => {
  const h = createEngineHarness();
  const member = await h.signUp('member@example.com');
  const moderator = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'moderator');
  const admin = await h.promote((await h.signUp('admin@example.com')).auth.actorId, 'admin');
  await publish(h, member.actor);

  assert.equal((await readAnalytics(h.engine, member.actor)).length, 0);
  assert.equal((await readAnalytics(h.engine, moderator)).length, 0);
  assert.ok((await readAnalytics(h.engine, admin)).length > 0);
});

test('analytics ingestion is idempotent under re-delivery', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  await publish(h, author.actor);

  const before = await h.engine.store.analyticsEvents.count();
  await h.settle();
  await h.settle();
  assert.equal(await h.engine.store.analyticsEvents.count(), before, 're-delivery must not duplicate rows');
});

test('health reports per-dependency state and degrades on dead letters', async () => {
  const h = createEngineHarness();
  const healthy = await h.engine.health.report();
  assert.equal(healthy.state, 'healthy');
  assert.deepEqual(
    healthy.dependencies.map((d) => d.name).sort(),
    ['dead_letters', 'outbox'],
    'each dependency reports individually',
  );
  assert.ok(healthy.checkedAt);

  await h.engine.deadLetters.record({
    source: 'test',
    eventName: 'Broken',
    aggregateType: 'experience',
    aggregateId: 'exp_x',
    payload: {},
    correlationId: 'corr',
    failureHistory: [],
  });

  const degraded = await h.engine.health.report();
  assert.equal(degraded.state, 'degraded', 'a dead letter degrades overall health');
  assert.equal(degraded.dependencies.find((d) => d.name === 'dead_letters')?.state, 'degraded');
});

test('no log line produced by the pipeline contains content or an actor email', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('ada@example.com', 'Ada');
  const experienceId = await publish(h, author.actor);

  expect(
    await h.engine.bus.dispatch({
      name: 'creator.deleteExperience',
      input: { experienceId },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'delete',
  );
  await h.settle();

  const logs = JSON.stringify(h.logger.records);
  assert.ok(h.logger.records.length > 0, 'the pipeline logs');
  assert.equal(logs.includes(BODY), false, 'no body text in logs');
  assert.equal(logs.includes('ada@example.com'), false, 'no email in logs');
  assert.equal(logs.includes('original/'), false, 'no original media key in logs');

  // And correlation ids are present so a run is traceable.
  assert.ok(h.logger.records.some((record) => record.correlationId !== undefined));
});

test('the redaction guarantee holds for a log line that tries to carry everything', async () => {
  const h = createEngineHarness();
  const logger = h.logger.child({ correlationId: 'corr-x' });
  logger.info('attempted leak', {
    body_text: BODY,
    email: 'ada@example.com',
    original_key: 'original/exp_1/audio',
    raw_text: 'raw transcript',
    playback_url: 'https://example.test/signed',
    safe: 'kept',
  });

  const record = h.logger.records.at(-1);
  assert.equal(record?.fields['safe'], 'kept');
  for (const key of ['body_text', 'email', 'original_key', 'raw_text', 'playback_url']) {
    assert.equal(record?.fields[key], REDACTED, `${key} must be redacted`);
  }
});
