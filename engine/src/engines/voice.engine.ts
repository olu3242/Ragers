import { err, ok } from '../runtime/result.ts';
import { notFoundError, preconditionError } from '../runtime/errors.ts';
import {
  consumeUploadTarget,
  validateVoiceCandidate,
  UPLOAD_TARGET_TTL_MS,
  type MediaAsset,
  type UploadTarget,
} from '../domain/voice.ts';
import { mediaFailed, mediaReady } from '../domain/experience.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { EngineDeps } from './deps.ts';
import { experienceResource, loadExperience } from './support.ts';

export interface UploadTargetResult {
  readonly uploadTargetId: string;
  readonly storageKey: string;
  readonly expiresAt: number;
}

export interface AttachVoiceCommand {
  readonly experienceId: string;
  readonly uploadTargetId: string;
  readonly durationMs: number;
  readonly byteSize: number;
  readonly mimeType: string;
}

/**
 * P2 Voice Engine. Audio is validated server-side, stored under an `original/`
 * key that no read path can reach, and queued for protection. The experience
 * stays in `pending_media` until protection succeeds.
 */
export const registerVoiceEngine = (deps: EngineDeps): void => {
  const requestUpload: CommandHandler<{ experienceId: string }, UploadTargetResult> = {
    name: 'voice.requestUploadTarget',
    action: 'voice.request_upload',
    resolveResource: async (input) => experienceResource(deps.store, input.experienceId),
    handle: async (input, ctx) => {
      const loaded = await loadExperience(deps.store, input.experienceId);
      if (!loaded.ok) return loaded;
      if (loaded.value.creationMode !== 'voice') {
        return err(preconditionError('not_voice_mode', 'only a voice experience accepts audio'));
      }
      if (loaded.value.status !== 'pending_media' && loaded.value.status !== 'draft') {
        return err(
          preconditionError('not_awaiting_media', `this experience is ${loaded.value.status}, not awaiting media`),
        );
      }

      const target: UploadTarget = {
        id: deps.ids.next('upl'),
        actorId: ctx.actor.actorId,
        experienceId: input.experienceId,
        // The original is written where no client read path can reach it.
        storageKey: `original/${input.experienceId}/audio`,
        issuedAt: ctx.clock.now(),
        expiresAt: ctx.clock.now() + UPLOAD_TARGET_TTL_MS,
      };
      await deps.store.uploadTargets.put(target);

      return ok({
        value: { uploadTargetId: target.id, storageKey: target.storageKey, expiresAt: target.expiresAt },
        events: [],
      });
    },
  };

  const attach: CommandHandler<AttachVoiceCommand, { mediaAssetId: string; protectionStatus: string }> = {
    name: 'voice.attachAsset',
    action: 'voice.attach',
    resolveResource: async (input) => experienceResource(deps.store, input.experienceId),
    handle: async (input, ctx) => {
      const loaded = await loadExperience(deps.store, input.experienceId);
      if (!loaded.ok) return loaded;

      const target = await deps.store.uploadTargets.get(input.uploadTargetId);
      if (!target) return err(notFoundError('upload_target_not_found', 'no such upload target'));

      const consumed = consumeUploadTarget(target, ctx.actor.actorId, input.experienceId, ctx.clock.now());
      if (!consumed.ok) return consumed;

      const validated = validateVoiceCandidate(input);
      if (!validated.ok) return validated;

      await deps.store.uploadTargets.put(consumed.value);

      const asset: MediaAsset = {
        id: deps.ids.next('media'),
        experienceId: input.experienceId,
        kind: 'audio',
        originalKey: target.storageKey,
        durationMs: validated.value.durationMs,
        byteSize: validated.value.byteSize,
        mimeType: validated.value.mimeType,
        processingStatus: 'queued',
        protectionStatus: 'queued',
        attemptCount: 0,
        createdAt: ctx.clock.now(),
      };
      await deps.store.mediaAssets.put(asset);

      return ok({
        value: { mediaAssetId: asset.id, protectionStatus: asset.protectionStatus },
        events: [
          {
            aggregateType: 'experience',
            aggregateId: input.experienceId,
            eventName: 'VoiceAssetAttached',
            payload: { mediaAssetId: asset.id, durationMs: asset.durationMs },
          },
        ],
      });
    },
  };

  deps.bus.register(requestUpload);
  deps.bus.register(attach);
};

/**
 * Once media is protected, the experience leaves `pending_media` for moderation.
 * Idempotent: re-delivery finds the experience already past pending_media and
 * does nothing.
 */
export const createMediaReadyConsumer = (deps: EngineDeps): Consumer => ({
  name: 'voice.media_ready',
  events: ['MediaProtected'],
  handle: async (event) => {
    const mediaAssetId = String(event.payload['mediaAssetId'] ?? '');
    const asset = await deps.store.mediaAssets.get(mediaAssetId);
    if (!asset?.experienceId) return ok(undefined);

    const experience = await deps.store.experiences.get(asset.experienceId);
    if (!experience) return ok(undefined);
    if (experience.status !== 'pending_media') return ok(undefined);

    const change = mediaReady(experience, mediaAssetId, deps.clock.now());
    if (!change.ok) return err(change.error);

    await deps.store.experiences.put({ ...change.value.experience, mediaAssetId });
    await deps.outbox.append(change.value.events, event.correlationId);
    return ok(undefined);
  },
});

/**
 * Protection failure returns the experience to draft so the author can re-record.
 * The experience is never published with unprotected audio.
 */
export const createMediaFailedConsumer = (deps: EngineDeps): Consumer => ({
  name: 'voice.media_failed',
  events: ['MediaProtectionFailed'],
  handle: async (event) => {
    const mediaAssetId = String(event.payload['mediaAssetId'] ?? '');
    const asset = await deps.store.mediaAssets.get(mediaAssetId);
    if (!asset?.experienceId) return ok(undefined);

    const experience = await deps.store.experiences.get(asset.experienceId);
    if (!experience || experience.status !== 'pending_media') return ok(undefined);

    const change = mediaFailed(experience, String(event.payload['reason'] ?? 'protection_failed'), deps.clock.now());
    if (!change.ok) return err(change.error);

    await deps.store.experiences.put(change.value.experience);
    await deps.outbox.append(change.value.events, event.correlationId);
    return ok(undefined);
  },
});
