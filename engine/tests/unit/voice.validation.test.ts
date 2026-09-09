import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  consumeUploadTarget,
  isPlaybackGrantValid,
  issuePlaybackGrant,
  PLAYBACK_TTL_MS,
  UPLOAD_TARGET_TTL_MS,
  validateVoiceCandidate,
  type MediaAsset,
  type UploadTarget,
} from '../../src/domain/voice.ts';
import {
  VOICE_MAX_BYTES,
  VOICE_MAX_DURATION_MS,
  VOICE_MIN_DURATION_MS,
} from '../../src/domain/types.ts';
import { expect } from '../../src/runtime/result.ts';

const valid = { durationMs: 5_000, byteSize: 100_000, mimeType: 'audio/webm' };

test('a valid recording passes validation', () => {
  const result = expect(validateVoiceCandidate(valid), 'valid');
  assert.deepEqual(result, valid);
});

test('duration, size and mime bounds are all enforced', () => {
  const cases: readonly [Record<string, unknown>, string][] = [
    [{ durationMs: VOICE_MIN_DURATION_MS - 1 }, 'voice_too_short'],
    [{ durationMs: VOICE_MAX_DURATION_MS + 1 }, 'voice_too_long'],
    [{ durationMs: 'five' }, 'invalid_duration'],
    [{ byteSize: 0 }, 'invalid_size'],
    [{ byteSize: VOICE_MAX_BYTES + 1 }, 'voice_too_large'],
    [{ mimeType: 'audio/aiff' }, 'unsupported_mime_type'],
    [{ mimeType: 'application/octet-stream' }, 'unsupported_mime_type'],
  ];
  for (const [override, code] of cases) {
    const result = validateVoiceCandidate({ ...valid, ...override });
    assert.equal(result.ok, false, `${code} must be rejected`);
    if (!result.ok) assert.equal(result.error.code, code);
  }
});

test('exact bounds are inclusive', () => {
  assert.ok(validateVoiceCandidate({ ...valid, durationMs: VOICE_MIN_DURATION_MS }).ok);
  assert.ok(validateVoiceCandidate({ ...valid, durationMs: VOICE_MAX_DURATION_MS }).ok);
  assert.ok(validateVoiceCandidate({ ...valid, byteSize: VOICE_MAX_BYTES }).ok);
});

const target = (overrides: Partial<UploadTarget> = {}): UploadTarget => ({
  id: 'upl_1',
  actorId: 'actor_1',
  experienceId: 'exp_1',
  storageKey: 'original/exp_1/audio',
  issuedAt: 1_000,
  expiresAt: 1_000 + UPLOAD_TARGET_TTL_MS,
  ...overrides,
});

test('an upload target is single-use', () => {
  const consumed = expect(consumeUploadTarget(target(), 'actor_1', 'exp_1', 2_000), 'consume');
  assert.equal(consumed.consumedAt, 2_000);
  const reuse = consumeUploadTarget(consumed, 'actor_1', 'exp_1', 3_000);
  assert.equal(reuse.ok, false);
  if (!reuse.ok) assert.equal(reuse.error.code, 'upload_target_consumed');
});

test('an upload target expires', () => {
  const result = consumeUploadTarget(target(), 'actor_1', 'exp_1', 1_000 + UPLOAD_TARGET_TTL_MS + 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'upload_target_expired');
});

test('an upload target is scoped to one actor and one experience', () => {
  const wrongActor = consumeUploadTarget(target(), 'actor_2', 'exp_1', 2_000);
  assert.equal(wrongActor.ok, false);
  if (!wrongActor.ok) assert.equal(wrongActor.error.code, 'upload_target_actor_mismatch');

  const wrongExperience = consumeUploadTarget(target(), 'actor_1', 'exp_2', 2_000);
  assert.equal(wrongExperience.ok, false);
  if (!wrongExperience.ok) assert.equal(wrongExperience.error.code, 'upload_target_scope_mismatch');
});

const asset = (overrides: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'media_1',
  experienceId: 'exp_1',
  kind: 'audio',
  originalKey: 'original/exp_1/audio',
  protectedKey: 'protected/exp_1/audio',
  durationMs: 5_000,
  byteSize: 100_000,
  mimeType: 'audio/webm',
  processingStatus: 'ready',
  protectionStatus: 'protected',
  attemptCount: 1,
  createdAt: 1_000,
  ...overrides,
});

test('a playback grant references only the protected derivative', () => {
  const grant = expect(issuePlaybackGrant(asset(), 'viewer_1', 2_000), 'grant');
  assert.equal(grant.protectedKey, 'protected/exp_1/audio');
  assert.equal(JSON.stringify(grant).includes('original/'), false, 'a grant must never reference the original');
});

test('playback is refused until protection has succeeded', () => {
  for (const status of ['queued', 'processing', 'failed', 'dead_letter'] as const) {
    const result = issuePlaybackGrant(asset({ protectionStatus: status }), 'viewer_1', 2_000);
    assert.equal(result.ok, false, `playback must be refused while ${status}`);
    if (!result.ok) assert.equal(result.error.code, 'media_not_protected');
  }
});

test('playback is refused when a protected key is missing even if the status claims protected', () => {
  const broken: MediaAsset = { ...asset(), protectionStatus: 'protected' };
  const withoutKey = { ...broken } as Record<string, unknown>;
  delete withoutKey['protectedKey'];
  const result = issuePlaybackGrant(withoutKey as unknown as MediaAsset, 'viewer_1', 2_000);
  assert.equal(result.ok, false);
});

test('a playback grant is short-lived', () => {
  const grant = expect(issuePlaybackGrant(asset(), 'viewer_1', 2_000), 'grant');
  assert.equal(grant.expiresAt, 2_000 + PLAYBACK_TTL_MS);
  assert.ok(isPlaybackGrantValid(grant, 2_000 + PLAYBACK_TTL_MS - 1));
  assert.equal(isPlaybackGrantValid(grant, 2_000 + PLAYBACK_TTL_MS), false);
});
