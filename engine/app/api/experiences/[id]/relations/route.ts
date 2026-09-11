import { getEngine } from '../../../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, jsonOk, readJson, respond } from '../../../../../lib/api.ts';
import { currentActor } from '../../../../../lib/session.ts';
import { relatedTo } from '../../../../../src/engines/relation.engine.ts';

/**
 * Experiences people have related to this one.
 *
 * Each carries how many distinct people asserted the link. That number is a
 * discovery signal and is never folded into a corroboration or experiencer count —
 * relating carries no trust weight at all.
 */
export const GET = async (
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  return jsonOk({ related: await relatedTo(getEngine(), id) });
};

export const POST = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const body = await readJson(request);
  const result = await getEngine().bus.dispatch({
    name: 'relation.assert',
    input: {
      fromExperienceId: id,
      toExperienceId: body['toExperienceId'],
      ...(body['assertion'] === undefined ? {} : { assertion: body['assertion'] }),
      ...(body['note'] === undefined ? {} : { note: body['note'] }),
    },
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result, 201);
};

/** Retract, by the person who asserted it. */
export const DELETE = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const body = await readJson(request);
  const result = await getEngine().bus.dispatch({
    name: 'relation.retract',
    input: { relationId: body['relationId'] },
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result);
};
