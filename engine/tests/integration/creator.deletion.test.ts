import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { PROPAGATION_SURFACES } from '../../src/ports/store.ts';
import { searchExperiences } from '../../src/engines/search.engine.ts';
import { notificationsFor } from '../../src/engines/notification.engine.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';

/** Build a voice experience with a reply, reactions, votes, media and a transcript. */
const buildFullExperience = async (h: EngineHarness, author: ActorContext, reader: ActorContext) => {
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'voice', category: 'Neighborhood', visibility: 'public' },
      actor: author,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  const target = expect(
    await h.engine.bus.dispatch<unknown, { uploadTargetId: string }>({
      name: 'voice.requestUploadTarget',
      input: { experienceId: created.experienceId },
      actor: author,
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
        durationMs: 5_000,
        byteSize: 120_000,
        mimeType: 'audio/webm',
      },
      actor: author,
      idempotencyKey: h.nextKey(),
    }),
    'attach',
  );
  await h.settle();

  const engagement: readonly { name: string; input: Record<string, unknown> }[] = [
    { name: 'reaction.toggle', input: { experienceId: created.experienceId, reactionType: 'been_there' } },
    { name: 'reaction.castFairVote', input: { experienceId: created.experienceId, isFair: true } },
    {
      name: 'conversation.createReply',
      input: { experienceId: created.experienceId, creationMode: 'text', bodyText: 'Same here.', visibility: 'public' },
    },
  ];
  for (const command of engagement) {
    expect(
      await h.engine.bus.dispatch({ ...command, actor: reader, idempotencyKey: h.nextKey() }),
      command.name,
    );
  }
  await h.settle();
  return created.experienceId;
};

test('deleting a voice experience removes every trace from every surface', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const reader = await h.signUp('reader@example.com');
  const experienceId = await buildFullExperience(h, author.actor, reader.actor);

  // Everything is present before deletion.
  assert.ok(await h.engine.store.feedEntries.get(experienceId), 'feed');
  assert.ok(await h.engine.store.searchDocuments.get(experienceId), 'search');
  assert.ok((await h.engine.store.experienceSubjects.count((r) => r.experienceId === experienceId)) > 0, 'subjects');
  assert.ok((await h.engine.store.replies.count((r) => r.experienceId === experienceId)) > 0, 'replies');
  assert.ok((await h.engine.store.mediaAssets.count((r) => r.experienceId === experienceId)) > 0, 'media');
  assert.ok((await h.engine.store.transcripts.count()) > 0, 'transcripts');
  assert.ok(await h.engine.store.counters.get(experienceId), 'counters');
  assert.ok((await notificationsFor(h.engine, author.auth.actorId)).length > 0, 'notifications');

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

  // Exhaustive sweep: nothing may survive on any read surface.
  assert.equal(await h.engine.store.feedEntries.get(experienceId), undefined, 'feed purged');
  assert.equal(await h.engine.store.searchDocuments.get(experienceId), undefined, 'search purged');
  assert.equal((await searchExperiences(h.engine, {})).length, 0, 'unsearchable');
  assert.equal(await h.engine.store.experienceSubjects.count((r) => r.experienceId === experienceId), 0, 'subjects');
  assert.equal(await h.engine.store.replies.count((r) => r.experienceId === experienceId), 0, 'replies');
  assert.equal(await h.engine.store.mediaAssets.count((r) => r.experienceId === experienceId), 0, 'media rows');
  assert.equal(await h.engine.store.transcripts.count(), 0, 'transcripts');
  assert.equal(await h.engine.store.counters.get(experienceId), undefined, 'counters');
  assert.equal(await h.engine.store.reactions.count((r) => r.experienceId === experienceId), 0, 'reactions');
  assert.equal(await h.engine.store.fairVotes.count((r) => r.experienceId === experienceId), 0, 'votes');
  assert.equal(await h.engine.store.rankingInputs.get(experienceId), undefined, 'ranking');
  assert.equal(await h.engine.store.notifications.count((r) => r.subjectId === experienceId), 0, 'notifications');

  // Stored objects are actually gone, not merely dereferenced.
  const remainingKeys = await h.engine.providers.objectStore.keys();
  assert.equal(
    remainingKeys.some((key) => key.includes(experienceId)),
    false,
    'both the original and the protected object are deleted',
  );

  // The request records completion across every declared surface.
  const request = await h.engine.store.deletionRequests.get(`del:${experienceId}`);
  assert.equal(request?.state, 'completed');
  for (const surface of PROPAGATION_SURFACES) {
    assert.equal(request?.propagation[surface], true, `${surface} must confirm`);
  }
  assert.ok(request?.completedAt);
});

test('deletion propagation is idempotent and resumable', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const reader = await h.signUp('reader@example.com');
  const experienceId = await buildFullExperience(h, author.actor, reader.actor);

  expect(
    await h.engine.bus.dispatch({
      name: 'creator.deleteExperience',
      input: { experienceId },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'delete',
  );

  // Draining repeatedly must converge on the same completed state.
  await h.settle();
  const first = await h.engine.store.deletionRequests.get(`del:${experienceId}`);
  await h.settle();
  await h.settle();
  const again = await h.engine.store.deletionRequests.get(`del:${experienceId}`);

  assert.equal(again?.state, 'completed');
  assert.deepEqual(again?.propagation, first?.propagation);
  assert.equal((await h.engine.deadLetters.list()).length, 0);
});

test('only the author may delete, and deleting twice is not an error', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const stranger = await h.signUp('stranger@example.com');
  const moderator = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'moderator');

  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rave', creationMode: 'text', category: 'Other', bodyText: 'Mine.', visibility: 'public' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();

  for (const actor of [stranger.actor, moderator]) {
    const attempt = await h.engine.bus.dispatch({
      name: 'creator.deleteExperience',
      input: { experienceId: created.experienceId },
      actor,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(attempt.ok, false, 'author deletion is not a moderation power');
    if (!attempt.ok) assert.equal(attempt.error.code, 'policy_not_owner');
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await h.engine.bus.dispatch({
      name: 'creator.deleteExperience',
      input: { experienceId: created.experienceId },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(result.ok, true, 'deleting twice is idempotent');
  }
});

test('visibility can be tightened after publication but never loosened', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');

  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: 'Public first.', visibility: 'public' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();

  expect(
    await h.engine.bus.dispatch({
      name: 'creator.changeVisibility',
      input: { experienceId: created.experienceId, visibility: 'anonymous' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'tighten',
  );

  const loosen = await h.engine.bus.dispatch({
    name: 'creator.changeVisibility',
    input: { experienceId: created.experienceId, visibility: 'public' },
    actor: author.actor,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(loosen.ok, false);
  if (!loosen.ok) assert.equal(loosen.error.code, 'visibility_cannot_loosen');
});

test('an export contains only the requester\'s own data', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const other = await h.signUp('other@example.com');

  expect(
    await h.engine.bus.dispatch({
      name: 'experience.create',
      input: { kind: 'rave', creationMode: 'text', category: 'Other', bodyText: 'Mine to export.', visibility: 'public' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'own',
  );
  expect(
    await h.engine.bus.dispatch({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: 'Someone else data.', visibility: 'public' },
      actor: other.actor,
      idempotencyKey: h.nextKey(),
    }),
    'other',
  );
  await h.settle();

  const request = expect(
    await h.engine.bus.dispatch<unknown, { exportRequestId: string }>({
      name: 'creator.requestExport',
      input: {},
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'export',
  );
  await h.settle();

  const stored = await h.engine.store.exportRequests.get(request.exportRequestId);
  assert.equal(stored?.state, 'ready');
  assert.ok(stored?.artifactKey?.includes(author.auth.actorId));

  const keys = await h.engine.providers.objectStore.keys();
  const exportKey = keys.find((key) => key.startsWith('exports/'));
  assert.ok(exportKey);
  assert.ok(exportKey?.includes(author.auth.actorId), 'the artifact is scoped to the requester');
  assert.equal(exportKey?.includes(other.auth.actorId), false);
});

test('the edit window closes', async () => {
  const h = createEngineHarness({ config: { editWindowMs: 60_000 } });
  const author = await h.signUp('author@example.com');

  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: 'Original text.', visibility: 'public' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();

  expect(
    await h.engine.bus.dispatch({
      name: 'experience.updateBody',
      input: { experienceId: created.experienceId, bodyText: 'Edited in time.' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'edit in window',
  );

  h.clock.advance(120_000);
  const late = await h.engine.bus.dispatch({
    name: 'experience.updateBody',
    input: { experienceId: created.experienceId, bodyText: 'Too late.' },
    actor: author.actor,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.error.code, 'edit_window_closed');
});
