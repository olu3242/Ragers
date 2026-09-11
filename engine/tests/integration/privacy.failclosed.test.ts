import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { createFakePiiDetector } from '../../src/adapters/fakes.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { UploadTargetResult } from '../../src/engines/voice.engine.ts';

const attachVoice = async (h: ReturnType<typeof createEngineHarness>, actor: Parameters<typeof h.engine.bus.dispatch>[0]['actor']) => {
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'voice', category: 'Other', visibility: 'anonymous' },
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
  const attached = expect(
    await h.engine.bus.dispatch<unknown, { mediaAssetId: string }>({
      name: 'voice.attachAsset',
      input: {
        experienceId: created.experienceId,
        uploadTargetId: target.uploadTargetId,
        durationMs: 4_000,
        byteSize: 120_000,
        mimeType: 'audio/webm',
      },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'attach',
  );
  return { experienceId: created.experienceId, mediaAssetId: attached.mediaAssetId };
};

test('protection failure never publishes: the experience returns to draft with a reason', async () => {
  const h = createEngineHarness({
    providers: { pii: createFakePiiDetector({ hardFail: true }) },
  });
  const { actor } = await h.signUp('ada@example.com');
  const { experienceId, mediaAssetId } = await attachVoice(h, actor);

  await h.settle();

  const asset = await h.engine.store.mediaAssets.get(mediaAssetId);
  assert.equal(asset?.protectionStatus, 'dead_letter', 'an unprotectable asset is dead-lettered, not served');
  assert.equal(asset?.protectedKey, undefined, 'no protected derivative exists');

  const experience = await h.engine.store.experiences.get(experienceId);
  assert.equal(experience?.status, 'draft', 'the author is returned to draft so they can re-record');
  assert.notEqual(experience?.status, 'published');

  assert.equal(await h.engine.store.feedEntries.count(), 0, 'nothing reaches the feed');
  assert.ok((await h.engine.deadLetters.list()).length >= 1, 'the failure is recorded, never dropped');
});

test('protection retries and then succeeds, publishing normally', async () => {
  const h = createEngineHarness({
    providers: { pii: createFakePiiDetector({ transientFailures: 2 }) },
    retry: { maxAttempts: 5, baseMs: 1_000, factor: 2 },
  });
  const { actor } = await h.signUp('ada@example.com');
  const { experienceId, mediaAssetId } = await attachVoice(h, actor);

  await h.settle();

  const asset = await h.engine.store.mediaAssets.get(mediaAssetId);
  assert.equal(asset?.protectionStatus, 'protected');
  assert.equal(asset?.attemptCount, 3, 'two transient failures then success');
  assert.equal((await h.engine.store.experiences.get(experienceId))?.status, 'published');
  assert.equal((await h.engine.deadLetters.list()).length, 0, 'a recovered failure does not dead-letter');
});

test('a voice experience is publishable even when transcription is dead-lettered', async () => {
  const h = createEngineHarness({
    providers: {
      // Protection works; transcription is permanently broken.
      transcription: {
        name: 'broken',
        transcribe: async () => ({
          ok: false as const,
          error: { kind: 'internal' as const, code: 'no_transcription', message: 'down', retryable: false },
        }),
      },
    },
  });
  const { actor } = await h.signUp('ada@example.com');
  const { experienceId, mediaAssetId } = await attachVoice(h, actor);

  await h.settle();

  assert.equal(
    (await h.engine.store.experiences.get(experienceId))?.status,
    'published',
    'enrichment failure must never block publication',
  );
  const transcript = await h.engine.store.transcripts.findOne((row) => row.mediaAssetId === mediaAssetId);
  assert.equal(transcript?.processingStatus, 'dead_letter');
  assert.equal(transcript?.redactedText, undefined, 'no transcript text is invented on failure');
  assert.ok(await h.engine.store.feedEntries.get(experienceId), 'the experience is still on the feed');
});

test('identifying detail in a transcript is redacted before it is readable', async () => {
  const h = createEngineHarness({
    providers: {
      transcription: {
        name: 'planted',
        transcribe: async () => ({
          ok: true as const,
          value: {
            text: 'John Smith blocked the crosswalk, call 555-123-4567 or john@example.com',
            language: 'en',
            confidence: 0.9,
          },
        }),
      },
    },
  });
  const { actor } = await h.signUp('ada@example.com');
  const { mediaAssetId } = await attachVoice(h, actor);

  await h.settle();

  const transcript = await h.engine.store.transcripts.findOne((row) => row.mediaAssetId === mediaAssetId);
  assert.ok(transcript?.redactedText, 'a redacted form exists');

  const redacted = transcript?.redactedText ?? '';
  assert.equal(redacted.includes('John Smith'), false, 'the name must be redacted');
  assert.equal(redacted.includes('555-123-4567'), false, 'the phone number must be redacted');
  assert.equal(redacted.includes('john@example.com'), false, 'the email must be redacted');
  assert.ok(redacted.includes('[person_name]') || redacted.includes('[email]'), 'redaction leaves a class marker');

  // Findings are counts by class and never carry the detected value.
  const findings = transcript?.redactionFindings ?? {};
  assert.ok(Object.keys(findings).length > 0, 'findings are recorded');
  assert.equal(JSON.stringify(findings).includes('John'), false, 'findings must not contain detected values');
});

test('moderation screening failure fails closed and never publishes', async () => {
  const h = createEngineHarness({
    providers: {
      pii: {
        name: 'screen-breaker',
        // Media protection succeeds; text screening is permanently broken.
        protectAudio: async (input) => ({
          ok: true as const,
          value: { protectedKey: input.originalKey.replace('original/', 'protected/'), findings: [] },
        }),
        detectInText: async () => ({
          ok: false as const,
          error: { kind: 'internal' as const, code: 'screen_unavailable', message: 'down', retryable: false },
        }),
      },
    },
  });
  const { actor } = await h.signUp('ada@example.com');

  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: {
        kind: 'rage',
        creationMode: 'text',
        category: 'Other',
        bodyText: 'Something happened.',
        visibility: 'public',
      },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );

  await h.settle();

  const experience = await h.engine.store.experiences.get(created.experienceId);
  assert.equal(experience?.status, 'pending_moderation', 'unscreenable content stays unpublished');
  assert.equal(await h.engine.store.feedEntries.count(), 0, 'nothing reaches the feed');
  assert.ok(
    (await h.engine.deadLetters.list()).some((entry) => entry.source === 'moderation.screen'),
    'the screening failure is dead-lettered for an operator, not silently dropped',
  );
});

test('content that names a person is routed to human review rather than auto-published', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('ada@example.com');

  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: {
        kind: 'rage',
        creationMode: 'text',
        category: 'Neighborhood',
        bodyText: 'John Smith left his bins out again.',
        visibility: 'public',
      },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );

  await h.settle();

  assert.equal(
    (await h.engine.store.experiences.get(created.experienceId))?.status,
    'pending_moderation',
    'naming a person routes to review, not publication',
  );
  assert.equal(await h.engine.store.feedEntries.count(), 0);

  const queued = await h.engine.store.queueItems.find((row) => row.targetId === created.experienceId);
  assert.equal(queued.length, 1, 'the item is queued for a human moderator');
  assert.equal(queued[0]?.state, 'queued');

  const screening = await h.engine.store.screenings.findOne((row) => row.targetId === created.experienceId);
  assert.equal(screening?.outcome, 'needs_review');
  assert.ok(screening?.signals.includes('person_name'));
});
