import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { RETENTION_POLICIES } from '../../src/domain/retention.ts';
import {
  holdsOnExperience,
  retentionAcceptsACommand,
  retentionHistoryFor,
  sweepRetention,
} from '../../src/engines/retention.engine.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';

/**
 * Phase 65 through the store.
 *
 * The policy tests hold the arithmetic. What is here is everything that only exists once
 * the sweep touches rows: that the bytes are marked and the *fact* is not, that a
 * protected derivative outlives the original it came from, that an open review stops a
 * removal, and that the ledger records the artefacts nothing happened to as well as the
 * ones that went.
 */
const DAY = 24 * 60 * 60 * 1000;

/** A voice experience with a media asset and a transcript, which is what retention acts on. */
const buildVoiceExperience = async (h: EngineHarness, author: ActorContext) => {
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
  const assets = await h.engine.store.mediaAssets.query([]);
  const asset = assets[0];
  assert.ok(asset, 'the attach produced a media asset');
  return { experienceId: created.experienceId, asset };
};

test('an original past its ceiling is marked removed, and the experience survives it', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('retain@example.com', 'Retain');
  const { experienceId, asset } = await buildVoiceExperience(h, actor);

  const before = await h.engine.store.experiences.get(experienceId);
  const transcriptBefore = (await h.engine.store.transcripts.query([]))[0];
  assert.ok(before);

  h.clock.advance(RETENTION_POLICIES.original_media.ceilingMs + DAY);
  const result = await sweepRetention(h.engine);

  const after = await h.engine.store.mediaAssets.get(asset.id);
  assert.ok(after?.originalRemovedAt, 'the original is marked removed');
  assert.equal(after.originalByteRemoval, 'object_storage_blocked');
  assert.match(after.originalRemovalReason ?? '', /No object storage is configured/);

  // The key itself is kept. Forgetting it before the bytes are gone would orphan the
  // file permanently — nothing would know what to delete once storage exists.
  assert.equal(after.originalKey, asset.originalKey, 'the key survives, so the bytes stay reachable');

  // And the fact is untouched: this is a removal of bytes, not of what somebody said.
  assert.deepEqual(await h.engine.store.experiences.get(experienceId), before, 'the experience is unchanged');
  assert.ok(result.expired > 0, 'the sweep removed something');
  assert.equal(result.byteRemoval, 'object_storage_blocked', 'and says the bytes are still there');

  // The redacted transcript outlives the raw one it came from.
  const transcriptAfter = (await h.engine.store.transcripts.query([]))[0];
  assert.equal(
    transcriptAfter?.redactedText,
    transcriptBefore?.redactedText,
    'the published text is not what expires',
  );
});

test('a protected derivative outlives the original, because it is the public artefact', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('derive@example.com', 'Derive');
  const { asset } = await buildVoiceExperience(h, actor);

  const protectedKey = (await h.engine.store.mediaAssets.get(asset.id))?.protectedKey;
  h.clock.advance(RETENTION_POLICIES.original_media.ceilingMs + DAY);
  await sweepRetention(h.engine);

  const after = await h.engine.store.mediaAssets.get(asset.id);
  assert.equal(after?.protectedKey, protectedKey, 'the protected derivative is untouched');
  assert.equal(after?.protectionStatus, 'protected', 'and it is still servable');
});

test('nothing expires while a moderation review is open on it', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('held@example.com', 'Held');
  const reporter = (await h.signUp('reporter@example.com', 'Reporter')).actor;
  const { experienceId, asset } = await buildVoiceExperience(h, actor);

  expect(
    await h.engine.bus.dispatch({
      name: 'safety.fileReport',
      input: { targetType: 'experience', targetId: experienceId, reasonCode: 'naming_shaming' },
      actor: reporter,
      idempotencyKey: h.nextKey(),
    }),
    'report',
  );
  await h.settle();
  assert.deepEqual(
    await holdsOnExperience(h.engine, experienceId),
    ['moderation_review_open'],
    'a queued report is an open review',
  );

  h.clock.advance(RETENTION_POLICIES.original_media.ceilingMs + DAY);
  const result = await sweepRetention(h.engine);

  const after = await h.engine.store.mediaAssets.get(asset.id);
  assert.equal(after?.originalRemovedAt, undefined, 'the artefact a moderator may need is still here');
  assert.ok(result.held > 0, 'and the sweep says it was held rather than missed');

  const ledger = await retentionHistoryFor(h.engine, asset.id);
  assert.equal(ledger[0]?.verdict, 'held');
  assert.equal(ledger[0]?.hold, 'moderation_review_open', 'and names which review is holding it');
});

test('the ledger records what nothing happened to, not only what went', async () => {
  // "We looked and it was within its ceiling" is the answer to the only question anybody
  // asks about a retention policy. A ledger of removals alone could not give it.
  const h = createEngineHarness();
  const { actor } = await h.signUp('ledger@example.com', 'Ledger');
  const { asset } = await buildVoiceExperience(h, actor);

  const result = await sweepRetention(h.engine);
  assert.equal(result.expired, 0, 'a fresh artefact expires nothing');
  assert.ok(result.considered > 0, 'and the sweep still wrote rows');

  const ledger = await retentionHistoryFor(h.engine, asset.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.verdict, 'within_ceiling');
  assert.equal(ledger[0]?.byteRemoval, undefined, 'nothing was claimed to have been removed');
  assert.ok((ledger[0]?.reason.length ?? 0) > 40, 'and the row explains its own ceiling');
});

test('a second sweep does not remove the same artefact twice', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('twice@example.com', 'Twice');
  const { asset } = await buildVoiceExperience(h, actor);

  h.clock.advance(RETENTION_POLICIES.original_media.ceilingMs + DAY);
  const first = await sweepRetention(h.engine);
  const removedAt = (await h.engine.store.mediaAssets.get(asset.id))?.originalRemovedAt;

  h.clock.advance(DAY);
  const second = await sweepRetention(h.engine);

  assert.ok(first.expired > 0, 'the first sweep removed it');
  assert.equal(second.expired, 0, 'the second removed nothing');
  assert.equal(
    (await h.engine.store.mediaAssets.get(asset.id))?.originalRemovedAt,
    removedAt,
    'and the removal time is the first one, not the latest sweep',
  );
  const ledger = await retentionHistoryFor(h.engine, asset.id);
  assert.equal(ledger[0]?.verdict, 'already_removed', 'the second sweep says so rather than re-deciding');
});

test('the raw transcript expires on its own clock, and the redacted text does not', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('transcript@example.com', 'Transcript');
  await buildVoiceExperience(h, actor);

  const before = (await h.engine.store.transcripts.query([]))[0];
  assert.ok(before, 'the voice pipeline produced a transcript');

  h.clock.advance(RETENTION_POLICIES.raw_transcript.ceilingMs + DAY);
  await sweepRetention(h.engine);

  const after = await h.engine.store.transcripts.get(before.id);
  assert.ok(after?.rawRemovedAt, 'the raw text is marked removed');
  assert.equal(after.redactedText, before.redactedText, 'the published text is not what expires');
  assert.equal(after.rawByteRemoval, 'object_storage_blocked');
});

test('retention takes no command, because expiry is a clock and not a decision about somebody', async () => {
  // A `retention.remove` command would be a way for one person to destroy another's
  // evidence on demand, and there is no legitimate caller for it.
  const h = createEngineHarness();
  assert.equal(retentionAcceptsACommand(), false);
  assert.equal(
    h.engine.bus.registeredCommands().some((name) => name.startsWith('retention.')),
    false,
    'and no such command is registered',
  );
});
