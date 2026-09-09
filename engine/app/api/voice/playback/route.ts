import { getEngine } from '../../../../lib/engine-instance.ts';
import { jsonError, jsonOk } from '../../../../lib/api.ts';
import { currentActor } from '../../../../lib/session.ts';
import { issuePlaybackGrant } from '../../../../src/domain/voice.ts';
import { notFoundError, unauthorizedError } from '../../../../src/runtime/errors.ts';

/**
 * Issue a short-lived playback grant. It can only ever reference the protected
 * derivative — the original key has no route out of the system.
 */
export const GET = async (request: Request): Promise<Response> => {
  const engine = getEngine();
  const actor = await currentActor();
  const mediaAssetId = new URL(request.url).searchParams.get('mediaAssetId') ?? '';

  const asset = await engine.store.mediaAssets.get(mediaAssetId);
  if (!asset) return jsonError(notFoundError('media_not_found', 'that audio is not available'));

  // The viewer must be authorized for the parent experience.
  const resource = asset.experienceId ? await engine.store.experiences.get(asset.experienceId) : undefined;
  const decision = engine.authorizer.authorize(actor, 'voice.playback', {
    type: 'media',
    id: asset.id,
    ...(resource === undefined ? {} : { ownerActorId: resource.actorId, status: resource.status }),
  });
  if (!decision.allowed) return jsonError(unauthorizedError(decision.code, decision.reason));

  const grant = issuePlaybackGrant(asset, actor.actorId, Date.now());
  if (!grant.ok) return jsonError(grant.error);

  return jsonOk({
    // Only the protected key and its expiry cross the boundary.
    protectedKey: grant.value.protectedKey,
    expiresAt: grant.value.expiresAt,
  });
};
