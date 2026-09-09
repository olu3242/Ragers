import { getEngine } from '../../../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, jsonOk, readJson, respond } from '../../../../../lib/api.ts';
import { currentActor } from '../../../../../lib/session.ts';
import { disputesFor } from '../../../../../src/engines/dispute.engine.ts';

/**
 * Disputes on an experience.
 *
 * The read says *that* it is contested, by which side, and on what grounds. Never
 * the detail — that can quote either party at length — and never a verdict the
 * platform has not reached.
 */
export const GET = async (
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  return jsonOk(await disputesFor(getEngine(), id));
};

/** Open one. Standing is resolved by the engine, not by this route. */
export const POST = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const body = await readJson(request);
  const result = await getEngine().bus.dispatch({
    name: 'dispute.open',
    input: {
      experienceId: id,
      reason: body['reason'],
      ...(body['detail'] === undefined ? {} : { detail: body['detail'] }),
      ...(body['responseId'] === undefined ? {} : { responseId: body['responseId'] }),
      ...(body['organizationId'] === undefined ? {} : { organizationId: body['organizationId'] }),
    },
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result, 201);
};
