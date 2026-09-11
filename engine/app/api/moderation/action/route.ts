import { getEngine } from '../../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, readJson, respond } from '../../../../lib/api.ts';
import { currentActor } from '../../../../lib/session.ts';

/**
 * Apply a moderation decision.
 *
 * `moderation.action` carries `ownership: 'forbidden'`, so a moderator cannot act
 * on their own content — enforced by the matrix, not by this route.
 */
export const POST = async (request: Request): Promise<Response> => {
  const body = await readJson(request);
  const result = await getEngine().bus.dispatch({
    name: 'safety.applyModerationAction',
    input: {
      targetType: body['targetType'] ?? 'experience',
      targetId: body['targetId'],
      action: body['action'],
      reason: body['reason'] ?? '',
    },
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result, 202);
};
