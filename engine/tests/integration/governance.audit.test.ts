import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import {
  readAuditTrail,
  readDeadLetters,
  readQueueMetrics,
} from '../../src/engines/governance.engine.ts';
import { createFakePiiDetector } from '../../src/adapters/fakes.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';

test('only an admin can grant a role, and the grant is audited', async () => {
  const h = createEngineHarness();
  const member = await h.signUp('member@example.com');
  const target = await h.signUp('target@example.com');
  const moderator = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'moderator');
  const admin = await h.promote((await h.signUp('admin@example.com')).auth.actorId, 'admin');

  for (const actor of [member.actor, moderator]) {
    const attempt = await h.engine.bus.dispatch({
      name: 'governance.grantRole',
      input: { actorId: target.auth.actorId, role: 'moderator' },
      actor,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(attempt.ok, false, 'role granting is admin-only');
    if (!attempt.ok) assert.equal(attempt.error.kind, 'unauthorized');
  }

  expect(
    await h.engine.bus.dispatch({
      name: 'governance.grantRole',
      input: { actorId: target.auth.actorId, role: 'moderator' },
      actor: admin,
      idempotencyKey: h.nextKey(),
    }),
    'grant',
  );

  assert.equal((await h.engine.store.actors.get(target.auth.actorId))?.role, 'moderator');

  const trail = await readAuditTrail(h.engine, admin, { resourceId: target.auth.actorId });
  assert.equal(trail.length, 1);
  assert.equal(trail[0]?.action, 'role.grant');
  assert.deepEqual(trail[0]?.before, { role: 'member' });
  assert.deepEqual(trail[0]?.after, { role: 'moderator' });
  assert.equal(trail[0]?.actorId, admin.actorId, 'the audit names who acted');
  assert.ok(trail[0]?.correlationId, 'the audit carries the correlation id');
});

test('a moderation action writes an audit record naming the moderator', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const moderator = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'moderator');
  const admin = await h.promote((await h.signUp('admin@example.com')).auth.actorId, 'admin');

  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: 'A thing.', visibility: 'public' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();

  expect(
    await h.engine.bus.dispatch({
      name: 'safety.applyModerationAction',
      input: { targetType: 'experience', targetId: created.experienceId, action: 'remove', reason: 'harassment' },
      actor: moderator,
      idempotencyKey: h.nextKey(),
    }),
    'remove',
  );

  const trail = await readAuditTrail(h.engine, admin, { resourceId: created.experienceId });
  assert.equal(trail.length, 1);
  assert.equal(trail[0]?.action, 'moderation.remove');
  assert.equal(trail[0]?.actorId, moderator.actorId);
});

test('the audit trail is readable only by an admin', async () => {
  const h = createEngineHarness();
  const member = await h.signUp('member@example.com');
  const moderator = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'moderator');
  const admin = await h.promote((await h.signUp('admin@example.com')).auth.actorId, 'admin');

  expect(
    await h.engine.bus.dispatch({
      name: 'identity.setDefaultVisibility',
      input: { visibility: 'anonymous' },
      actor: member.actor,
      idempotencyKey: h.nextKey(),
    }),
    'change default',
  );

  assert.equal((await readAuditTrail(h.engine, member.actor)).length, 0, 'a member sees no audit trail');
  assert.equal((await readAuditTrail(h.engine, moderator)).length, 0, 'a moderator sees no audit trail');
  assert.ok((await readAuditTrail(h.engine, admin)).length > 0, 'an admin does');
});

test('the audit store exposes no mutation path', () => {
  const h = createEngineHarness();
  const table = h.engine.store.auditEvents;
  // The port has put/remove for the writer, but the governance surface exposes
  // reads only — there is no update or delete command anywhere in the bus.
  const mutatingCommands = h.engine.bus
    .registeredCommands()
    .filter((name) => name.includes('audit') && !name.includes('read'));
  assert.deepEqual(mutatingCommands, [], 'no command can alter the audit trail');
  assert.ok(table, 'the table exists for the writer only');
});

test('dead-letter replay is admin-only, idempotent and audited', async () => {
  const h = createEngineHarness({
    providers: { pii: createFakePiiDetector({ hardFail: true }) },
  });
  const author = await h.signUp('author@example.com');
  const member = await h.signUp('member@example.com');
  const admin = await h.promote((await h.signUp('admin@example.com')).auth.actorId, 'admin');

  // Force a dead letter through a permanently failing protection provider.
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'voice', category: 'Other', visibility: 'anonymous' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  const target = expect(
    await h.engine.bus.dispatch<unknown, { uploadTargetId: string }>({
      name: 'voice.requestUploadTarget',
      input: { experienceId: created.experienceId },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'target',
  );
  expect(
    await h.engine.bus.dispatch({
      name: 'voice.attachAsset',
      input: {
        experienceId: created.experienceId,
        uploadTargetId: target.uploadTargetId,
        durationMs: 4_000,
        byteSize: 90_000,
        mimeType: 'audio/webm',
      },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'attach',
  );
  await h.settle();

  const dead = await readDeadLetters(h.engine, admin);
  assert.ok(dead.length >= 1, 'the failure is inspectable by an admin');
  assert.equal((await readDeadLetters(h.engine, member.actor)).length, 0, 'a member sees no dead letters');

  const deadLetterId = dead[0]?.id ?? '';
  const byMember = await h.engine.bus.dispatch({
    name: 'governance.replayDeadLetter',
    input: { deadLetterId },
    actor: member.actor,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(byMember.ok, false, 'replay is admin-only');

  const first = expect(
    await h.engine.bus.dispatch<unknown, { replayCount: number }>({
      name: 'governance.replayDeadLetter',
      input: { deadLetterId },
      actor: admin,
      idempotencyKey: h.nextKey(),
    }),
    'replay',
  );
  assert.equal(first.replayCount, 1);

  const second = expect(
    await h.engine.bus.dispatch<unknown, { replayCount: number }>({
      name: 'governance.replayDeadLetter',
      input: { deadLetterId },
      actor: admin,
      idempotencyKey: h.nextKey(),
    }),
    'replay again',
  );
  assert.equal(second.replayCount, 2, 'replay is repeatable and counted');

  const trail = await readAuditTrail(h.engine, admin, { resourceId: deadLetterId });
  assert.equal(trail.length, 2, 'every replay is audited');
});

test('queue metrics are moderator-gated and report real depth', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const member = await h.signUp('member@example.com');
  const moderator = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'moderator');

  expect(
    await h.engine.bus.dispatch({
      name: 'experience.create',
      input: {
        kind: 'rage',
        creationMode: 'text',
        category: 'Neighborhood',
        bodyText: 'John Smith blocked the drive.',
        visibility: 'public',
      },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();

  assert.deepEqual(await readQueueMetrics(h.engine, member.actor), {
    queued: 0,
    claimed: 0,
    actioned: 0,
    oldestQueuedAgeMs: 0,
  });

  const metrics = await readQueueMetrics(h.engine, moderator);
  assert.equal(metrics.queued, 1, 'the review item is visible to a moderator');
});

test('a moderator cannot claim an item another moderator already holds', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const modA = await h.promote((await h.signUp('a@example.com')).auth.actorId, 'moderator');
  const modB = await h.promote((await h.signUp('b@example.com')).auth.actorId, 'moderator');

  expect(
    await h.engine.bus.dispatch({
      name: 'experience.create',
      input: {
        kind: 'rage',
        creationMode: 'text',
        category: 'Neighborhood',
        bodyText: 'Mary Jane parked badly.',
        visibility: 'public',
      },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();

  const item = (await h.engine.store.queueItems.all())[0];
  assert.ok(item);

  expect(
    await h.engine.bus.dispatch({
      name: 'safety.claimQueueItem',
      input: { queueItemId: item?.id ?? '' },
      actor: modA,
      idempotencyKey: h.nextKey(),
    }),
    'claim',
  );

  const contested = await h.engine.bus.dispatch({
    name: 'safety.claimQueueItem',
    input: { queueItemId: item?.id ?? '' },
    actor: modB,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(contested.ok, false);
  if (!contested.ok) assert.equal(contested.error.code, 'already_claimed');

  // Re-claiming your own item is idempotent.
  expect(
    await h.engine.bus.dispatch({
      name: 'safety.claimQueueItem',
      input: { queueItemId: item?.id ?? '' },
      actor: modA,
      idempotencyKey: h.nextKey(),
    }),
    'reclaim',
  );
});

test('a moderator cannot action their own content', async () => {
  const h = createEngineHarness();
  const moderator = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'moderator');

  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: 'My own post.', visibility: 'public' },
      actor: moderator,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();

  const attempt = await h.engine.bus.dispatch({
    name: 'safety.applyModerationAction',
    input: { targetType: 'experience', targetId: created.experienceId, action: 'remove', reason: 'spam' },
    actor: moderator,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(attempt.ok, false);
  if (!attempt.ok) assert.equal(attempt.error.code, 'policy_owner_forbidden');
});

test('a reporter is acknowledged but learns nothing about internal handling', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const reporter = await h.signUp('reporter@example.com');

  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: 'Reportable.', visibility: 'public' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();

  const report = expect(
    await h.engine.bus.dispatch<unknown, { reportId: string; acknowledged: true }>({
      name: 'safety.fileReport',
      input: { targetType: 'experience', targetId: created.experienceId, reasonCode: 'naming_shaming' },
      actor: reporter.actor,
      idempotencyKey: h.nextKey(),
    }),
    'report',
  );

  // The response is an acknowledgement and nothing more.
  assert.deepEqual(Object.keys(report).sort(), ['acknowledged', 'reportId']);
  const serialised = JSON.stringify(report);
  assert.equal(serialised.includes('queue'), false, 'no internal queue detail is disclosed');
  assert.equal(serialised.includes('priority'), false);
  assert.equal(serialised.includes('status'), false);

  // Internally the item is queued for review.
  assert.equal(await h.engine.store.queueItems.count((row) => row.targetId === created.experienceId), 1);
});
