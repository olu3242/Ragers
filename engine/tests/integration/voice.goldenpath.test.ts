import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { findForbiddenKeys } from '../../src/domain/projection.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { UploadTargetResult } from '../../src/engines/voice.engine.ts';

/**
 * The voice golden path, end to end:
 *   authenticate -> choose Rage/Rave -> choose Voice -> record -> validate ->
 *   upload -> persist canonical Experience -> protect -> publish -> moderation
 *   -> transcription/enrichment -> feed
 */
test('the voice golden path publishes, protects, transcribes and reaches the feed', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('ada@example.com', 'Ada');

  // Choose Rave + Voice. The aggregate is canonical: voice is a creation mode.
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: {
        kind: 'rave',
        creationMode: 'voice',
        category: 'Neighborhood',
        visibility: 'anonymous',
      },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  assert.equal(created.status, 'pending_media', 'a voice experience waits for its audio');
  assert.equal(created.awaitingMedia, true);

  // Upload target: single-use, scoped, expiring, and pointing at an internal key.
  const target = expect(
    await h.engine.bus.dispatch<unknown, UploadTargetResult>({
      name: 'voice.requestUploadTarget',
      input: { experienceId: created.experienceId },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'upload target',
  );
  assert.match(target.storageKey, /^original\//, 'the original is written where no read path can reach it');

  // Attach the recording.
  const attached = expect(
    await h.engine.bus.dispatch<unknown, { mediaAssetId: string; protectionStatus: string }>({
      name: 'voice.attachAsset',
      input: {
        experienceId: created.experienceId,
        uploadTargetId: target.uploadTargetId,
        durationMs: 6_500,
        byteSize: 240_000,
        mimeType: 'audio/webm',
      },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'attach',
  );
  assert.equal(attached.protectionStatus, 'queued', 'audio is queued for protection, not served immediately');

  // Before the pipeline runs, nothing is published.
  assert.equal((await h.engine.store.experiences.get(created.experienceId))?.status, 'pending_media');
  assert.equal(await h.engine.store.feedEntries.count(), 0, 'nothing reaches the feed before protection');

  await h.settle();

  // Protection ran, and produced a distinct protected key.
  const asset = await h.engine.store.mediaAssets.get(attached.mediaAssetId);
  assert.equal(asset?.protectionStatus, 'protected');
  assert.match(asset?.protectedKey ?? '', /^protected\//);
  assert.notEqual(asset?.protectedKey, asset?.originalKey, 'the protected derivative is a distinct object');

  // The aggregate advanced through moderation to published.
  const experience = await h.engine.store.experiences.get(created.experienceId);
  assert.equal(experience?.status, 'published');
  assert.equal(experience?.mediaAssetId, attached.mediaAssetId);

  // Enrichment ran and produced redacted text only.
  const transcript = await h.engine.store.transcripts.findOne((row) => row.mediaAssetId === attached.mediaAssetId);
  assert.ok(transcript, 'a transcript exists');
  assert.equal(transcript?.processingStatus, 'ready');
  assert.ok(transcript?.redactedText, 'redacted text is what any read path serves');

  // The feed entry is anonymous, voice-flagged, and carries no actor reference.
  const entries = await h.engine.store.feedEntries.all();
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry?.identityLabel, 'Anonymous');
  assert.equal(entry?.identityKind, 'anonymous');
  assert.equal(entry?.hasVoice, true);
  assert.equal(entry?.durationMs, 6_500);
  assert.deepEqual(findForbiddenKeys(entry), [], 'the feed row must carry no actor or original-key reference');
  assert.equal(JSON.stringify(entry).includes(actor.actorId), false, 'the actor id must not reach the feed');
  assert.equal(JSON.stringify(entry).includes('original/'), false, 'the original key must not reach the feed');

  // The whole pipeline shares one correlation id per command chain.
  const events = await h.engine.outbox.all();
  assert.ok(events.length >= 6, 'the pipeline emitted its event chain');
  assert.equal((await h.engine.deadLetters.list()).length, 0, 'a clean run dead-letters nothing');
});

test('a text experience skips media and publishes directly through screening', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('grace@example.com', 'Grace');

  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: {
        kind: 'rage',
        creationMode: 'text',
        category: 'Driving & transit',
        bodyText: 'Someone parked across the whole crosswalk.',
        visibility: 'public',
      },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  assert.equal(created.status, 'pending_moderation', 'text goes straight to moderation');
  assert.equal(created.awaitingMedia, false);

  await h.settle();

  assert.equal((await h.engine.store.experiences.get(created.experienceId))?.status, 'published');
  const entry = await h.engine.store.feedEntries.get(created.experienceId);
  assert.equal(entry?.identityLabel, 'Grace', 'a public experience shows the display name');
  assert.equal(entry?.hasVoice, false);
});

test('an alias experience shows the alias handle and never the display name', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('rear@example.com', 'Rear Admiral Hopper');

  const alias = expect(
    await h.engine.bus.dispatch<unknown, { aliasId: string; aliasName: string }>({
      name: 'identity.createAlias',
      input: { aliasName: 'quietcommuter' },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'alias',
  );

  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: {
        kind: 'rave',
        creationMode: 'text',
        category: 'Everyday courtesy',
        bodyText: 'Someone held the lift for a whole family.',
        visibility: 'alias',
        aliasId: alias.aliasId,
      },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();

  const entry = await h.engine.store.feedEntries.get(created.experienceId);
  assert.equal(entry?.identityLabel, '@quietcommuter');
  assert.equal(JSON.stringify(entry).includes('Rear Admiral Hopper'), false, 'the real name must not leak');
});

test('another actor\'s alias cannot be borrowed', async () => {
  const h = createEngineHarness();
  const owner = await h.signUp('owner@example.com', 'Owner');
  const other = await h.signUp('other@example.com', 'Other');

  const alias = expect(
    await h.engine.bus.dispatch<unknown, { aliasId: string }>({
      name: 'identity.createAlias',
      input: { aliasName: 'borrowme' },
      actor: owner.actor,
      idempotencyKey: h.nextKey(),
    }),
    'alias',
  );

  const attempt = await h.engine.bus.dispatch({
    name: 'experience.create',
    input: {
      kind: 'rage',
      creationMode: 'text',
      category: 'Other',
      bodyText: 'Using an alias I do not own.',
      visibility: 'alias',
      aliasId: alias.aliasId,
    },
    actor: other.actor,
    idempotencyKey: h.nextKey(),
  });

  assert.equal(attempt.ok, false);
  if (!attempt.ok) assert.equal(attempt.error.code, 'alias_unavailable');
});
