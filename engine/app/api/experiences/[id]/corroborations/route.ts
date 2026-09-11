import { getEngine } from '../../../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, readJson, respond } from '../../../../../lib/api.ts';
import { currentActor } from '../../../../../lib/session.ts';

/**
 * Claim an experience: "this happened to me too".
 *
 * Its own route, separate from reactions, because it is a different kind of act.
 * A reaction is a response to someone else's claim; this is a claim of your own,
 * and it is the only thing that moves a corroboration count.
 */
export const POST = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const body = await readJson(request);
  const result = await getEngine().bus.dispatch({
    name: 'corroboration.create',
    input: {
      experienceId: id,
      type: body['type'],
      ...(body['narrative'] === undefined ? {} : { narrative: body['narrative'] }),
      ...(body['visibility'] === undefined ? {} : { visibility: body['visibility'] }),
      ...(body['aliasId'] === undefined ? {} : { aliasId: body['aliasId'] }),
    },
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result);
};
