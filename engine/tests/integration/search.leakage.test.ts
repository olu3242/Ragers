import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { searchExperiences } from '../../src/engines/search.engine.ts';
import { findForbiddenKeys } from '../../src/domain/projection.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { UploadTargetResult } from '../../src/engines/voice.engine.ts';

const RAW = 'John Smith left the trolley in the disabled bay';

const plantedTranscription = {
  name: 'planted',
  transcribe: async () => ({
    ok: true as const,
    value: { text: RAW, language: 'en', confidence: 0.9 },
  }),
};

const publishVoice = async (h: EngineHarness, actor: ActorContext) => {
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'voice', category: 'Shopping & service', visibility: 'anonymous' },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  const target = expect(
    await h.engine.bus.dispatch<unknown, UploadTargetResult>({
      name: 'voice.requestUploadTarget',
      input: { experienceId: created.experienceId },
      actor,
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
        byteSize: 150_000,
        mimeType: 'audio/webm',
      },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'attach',
  );
  await h.settle();
  return created.experienceId;
};

const publishText = async (h: EngineHarness, actor: ActorContext, bodyText: string) => {
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rave', creationMode: 'text', category: 'Everyday courtesy', bodyText, visibility: 'public' },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();
  return created.experienceId;
};

test('a voice experience is searchable by its redacted transcript, never its raw text', async () => {
  const h = createEngineHarness({ providers: { transcription: plantedTranscription } });
  const { actor } = await h.signUp('ada@example.com');
  const experienceId = await publishVoice(h, actor);

  const document = await h.engine.store.searchDocuments.get(experienceId);
  assert.ok(document, 'the experience is indexed');
  assert.equal(document?.searchableText.includes('John Smith'), false, 'raw names must never be indexed');
  assert.ok(document?.searchableText.includes('trolley'), 'the redacted body is searchable');

  const byRedacted = await searchExperiences(h.engine, { text: 'trolley' });
  assert.equal(byRedacted.length, 1);
  assert.equal(byRedacted[0]?.hasVoice, true);

  const byRawName = await searchExperiences(h.engine, { text: 'John Smith' });
  assert.equal(byRawName.length, 0, 'the raw transcript must not be reachable through search');
});

test('search documents and hits carry no actor reference', async () => {
  const h = createEngineHarness({ providers: { transcription: plantedTranscription } });
  const { actor } = await h.signUp('ada@example.com');
  const experienceId = await publishVoice(h, actor);

  const document = await h.engine.store.searchDocuments.get(experienceId);
  assert.deepEqual(findForbiddenKeys(document), []);
  assert.equal(JSON.stringify(document).includes(actor.actorId), false);
  assert.equal(JSON.stringify(document).includes('original/'), false);

  const hits = await searchExperiences(h.engine, {});
  assert.deepEqual(findForbiddenKeys(hits), []);
  assert.equal(JSON.stringify(hits).includes(actor.actorId), false);
});

test('removed content becomes unsearchable immediately', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const moderator = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'moderator');
  const experienceId = await publishText(h, author.actor, 'A kind thing at the checkout.');

  assert.equal((await searchExperiences(h.engine, { text: 'checkout' })).length, 1);

  expect(
    await h.engine.bus.dispatch({
      name: 'safety.applyModerationAction',
      input: { targetType: 'experience', targetId: experienceId, action: 'remove', reason: 'naming_shaming' },
      actor: moderator,
      idempotencyKey: h.nextKey(),
    }),
    'remove',
  );
  await h.settle();

  assert.equal(
    (await searchExperiences(h.engine, { text: 'checkout' })).length,
    0,
    'a stale index entry after removal is a privacy incident, not a latency issue',
  );
  assert.equal(await h.engine.store.searchDocuments.get(experienceId), undefined);
});

test('search filters by kind, category and voice-only', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  await publishText(h, author.actor, 'Held the door open today.');

  assert.equal((await searchExperiences(h.engine, { kind: 'rave' })).length, 1);
  assert.equal((await searchExperiences(h.engine, { kind: 'rage' })).length, 0);
  assert.equal((await searchExperiences(h.engine, { category: 'Everyday courtesy' })).length, 1);
  assert.equal((await searchExperiences(h.engine, { category: 'Neighborhood' })).length, 0);
  assert.equal((await searchExperiences(h.engine, { voiceOnly: true })).length, 0);
});

test('re-indexing is idempotent', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  await publishText(h, author.actor, 'Someone tidied the bus stop.');

  await h.settle();
  await h.settle();
  assert.equal(await h.engine.store.searchDocuments.count(), 1, 'repeated indexing must not duplicate documents');
});
