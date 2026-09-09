import { getEngine } from '../../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, readJson, respond } from '../../../../lib/api.ts';
import { currentActor } from '../../../../lib/session.ts';

/**
 * Attach a recording. The engine re-validates duration, size and format —
 * the client's claims about its own audio are never trusted.
 */
export const POST = async (request: Request): Promise<Response> => {
  const result = await getEngine().bus.dispatch({
    name: 'voice.attachAsset',
    input: await readJson(request),
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result, 202);
};
