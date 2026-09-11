import { getEngine } from '../../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, readJson, respond } from '../../../../lib/api.ts';
import { currentActor } from '../../../../lib/session.ts';

/**
 * Claim a queue item. Dispatched through the bus, so `moderation.claim` decides
 * whether this caller may — the surface does not.
 */
export const POST = async (request: Request): Promise<Response> => {
  const body = await readJson(request);
  const result = await getEngine().bus.dispatch({
    name: 'safety.claimQueueItem',
    input: { queueItemId: body['queueItemId'] },
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result);
};
