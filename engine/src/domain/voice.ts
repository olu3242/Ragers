import {
  VOICE_ALLOWED_MIME_TYPES,
  VOICE_MAX_BYTES,
  VOICE_MAX_DURATION_MS,
  VOICE_MIN_DURATION_MS,
} from './types.ts';
import { err, ok, type Result } from '../runtime/result.ts';
import { preconditionError, validationError, type EngineError } from '../runtime/errors.ts';
import type { WorkState } from '../runtime/work.ts';

/**
 * Recorder state machine — the client-side capture flow, modelled in the domain
 * so the golden path is testable without a browser and cannot drift between
 * the UI and the engine.
 */
export type RecorderState =
  | 'idle'
  | 'permission_pending'
  | 'permission_denied'
  | 'ready'
  | 'recording'
  | 'paused'
  | 'stopped'
  | 'preview'
  | 'submitted';

export type RecorderEvent =
  | 'request_permission'
  | 'permission_granted'
  | 'permission_denied'
  | 'start'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'preview'
  | 're_record'
  | 'submit'
  | 'reset';

const RECORDER_TRANSITIONS: Readonly<Record<RecorderState, Readonly<Partial<Record<RecorderEvent, RecorderState>>>>> = {
  idle: { request_permission: 'permission_pending' },
  permission_pending: { permission_granted: 'ready', permission_denied: 'permission_denied' },
  // Denial is recoverable: the user can grant permission later, or fall back to text.
  permission_denied: { request_permission: 'permission_pending', reset: 'idle' },
  ready: { start: 'recording', reset: 'idle' },
  recording: { pause: 'paused', stop: 'stopped' },
  paused: { resume: 'recording', stop: 'stopped' },
  stopped: { preview: 'preview' },
  preview: { re_record: 'ready', submit: 'submitted', reset: 'idle' },
  submitted: {},
};

export const recorderNext = (state: RecorderState, event: RecorderEvent): Result<RecorderState, EngineError> => {
  const next = RECORDER_TRANSITIONS[state][event];
  if (!next) {
    return err(
      preconditionError('illegal_recorder_transition', `cannot ${event} while ${state}`, { state, event }),
    );
  }
  return ok(next);
};

export const isRecorderTerminal = (state: RecorderState): boolean => state === 'submitted';

/** Voice capture is optional: denial must degrade to text without losing typed content. */
export const canFallBackToText = (state: RecorderState): boolean =>
  state === 'permission_denied' || state === 'idle';

/**
 * Media asset. `originalKey` and `protectedKey` are separate columns so that
 * "only the protected derivative is servable" is a structural property rather
 * than a convention.
 */
export interface MediaAsset {
  readonly id: string;
  readonly experienceId?: string;
  readonly replyId?: string;
  readonly kind: 'audio' | 'image';
  /** Internal only. Never returned by any read path. */
  readonly originalKey: string;
  /** Public-facing, identity-protected derivative. Absent until protection succeeds. */
  readonly protectedKey?: string;
  readonly durationMs: number;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly processingStatus: WorkState;
  readonly protectionStatus: 'queued' | 'processing' | 'protected' | 'failed' | 'dead_letter';
  readonly protectionFindings?: Readonly<Record<string, number>>;
  readonly attemptCount: number;
  readonly failureReason?: string;
  readonly createdAt: number;
}

export interface VoiceCandidate {
  readonly durationMs: unknown;
  readonly byteSize: unknown;
  readonly mimeType: unknown;
}

/** Bounds are enforced server-side; the client's claims are never trusted. */
export const validateVoiceCandidate = (candidate: VoiceCandidate): Result<
  { durationMs: number; byteSize: number; mimeType: string },
  EngineError
> => {
  const { durationMs, byteSize, mimeType } = candidate;

  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
    return err(validationError('invalid_duration', 'durationMs must be a number'));
  }
  if (durationMs < VOICE_MIN_DURATION_MS) {
    return err(
      validationError('voice_too_short', `recording must be at least ${VOICE_MIN_DURATION_MS}ms`, { durationMs }),
    );
  }
  if (durationMs > VOICE_MAX_DURATION_MS) {
    return err(
      validationError('voice_too_long', `recording must be at most ${VOICE_MAX_DURATION_MS}ms`, { durationMs }),
    );
  }
  if (typeof byteSize !== 'number' || !Number.isFinite(byteSize) || byteSize <= 0) {
    return err(validationError('invalid_size', 'byteSize must be a positive number'));
  }
  if (byteSize > VOICE_MAX_BYTES) {
    return err(validationError('voice_too_large', `recording must be at most ${VOICE_MAX_BYTES} bytes`, { byteSize }));
  }
  if (typeof mimeType !== 'string' || !VOICE_ALLOWED_MIME_TYPES.includes(mimeType)) {
    return err(validationError('unsupported_mime_type', 'audio format is not supported', { mimeType }));
  }

  return ok({ durationMs, byteSize, mimeType });
};

/**
 * Single-use, scoped, expiring upload target. Scoping to one actor and one
 * experience means a leaked target cannot be used to write to anything else.
 */
export interface UploadTarget {
  readonly id: string;
  readonly actorId: string;
  readonly experienceId: string;
  readonly storageKey: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly consumedAt?: number;
}

export const UPLOAD_TARGET_TTL_MS = 15 * 60 * 1_000;

export const consumeUploadTarget = (
  target: UploadTarget,
  actorId: string,
  experienceId: string,
  now: number,
): Result<UploadTarget, EngineError> => {
  if (target.consumedAt !== undefined) {
    return err(preconditionError('upload_target_consumed', 'this upload target has already been used'));
  }
  if (target.expiresAt <= now) {
    return err(preconditionError('upload_target_expired', 'this upload target has expired'));
  }
  if (target.actorId !== actorId) {
    return err(preconditionError('upload_target_actor_mismatch', 'this upload target belongs to another actor'));
  }
  if (target.experienceId !== experienceId) {
    return err(
      preconditionError('upload_target_scope_mismatch', 'this upload target belongs to another experience'),
    );
  }
  return ok({ ...target, consumedAt: now });
};

/** Short-lived playback grant. It can only ever reference the protected derivative. */
export interface PlaybackGrant {
  readonly mediaAssetId: string;
  readonly viewerActorId: string;
  readonly protectedKey: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export const PLAYBACK_TTL_MS = 5 * 60 * 1_000;

export const issuePlaybackGrant = (
  asset: MediaAsset,
  viewerActorId: string,
  now: number,
): Result<PlaybackGrant, EngineError> => {
  if (asset.protectionStatus !== 'protected' || !asset.protectedKey) {
    return err(
      preconditionError('media_not_protected', 'playback is only available once the audio has been protected', {
        protectionStatus: asset.protectionStatus,
      }),
    );
  }
  return ok({
    mediaAssetId: asset.id,
    viewerActorId,
    protectedKey: asset.protectedKey,
    issuedAt: now,
    expiresAt: now + PLAYBACK_TTL_MS,
  });
};

export const isPlaybackGrantValid = (grant: PlaybackGrant, now: number): boolean => grant.expiresAt > now;
