import { getEngine } from '../../../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, readJson, respond } from '../../../../../lib/api.ts';
import { currentActor } from '../../../../../lib/session.ts';

/**
 * Share an experience.
 *
 * Its own route, its own table and its own count. Sharing amplifies a claim; it
 * does not make one, so nothing here can reach a corroboration count.
 */
export const POST = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const body = await readJson(request);
  const result = await getEngine().bus.dispatch({
    name: 'share.create',
    input: {
      experienceId: id,
      ...(body['destination'] === undefined ? {} : { destination: body['destination'] }),
    },
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result);
};
