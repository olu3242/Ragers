import { getEngine } from '../../../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, readJson, respond } from '../../../../../lib/api.ts';
import { currentActor } from '../../../../../lib/session.ts';

/**
 * An organization answers.
 *
 * There is no corresponding route to hide, edit or resolve an experience —
 * responding is the whole of an organization's reach, by construction.
 */
export const POST = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const body = await readJson(request);
  const result = await getEngine().bus.dispatch({
    name: 'organization.respond',
    input: {
      organizationId: id,
      ...(body['experienceId'] === undefined ? {} : { experienceId: body['experienceId'] }),
      ...(body['clusterId'] === undefined ? {} : { clusterId: body['clusterId'] }),
      kind: body['kind'],
      body: body['body'],
    },
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result, 201);
};
