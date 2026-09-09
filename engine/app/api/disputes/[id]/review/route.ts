import { getEngine } from '../../../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, readJson, respond } from '../../../../../lib/api.ts';
import { currentActor } from '../../../../../lib/session.ts';

/**
 * Decide a dispute. Operator-only by policy, and refused for the raiser by the
 * domain — so neither the disputed party nor the disputer can settle it.
 */
export const POST = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const body = await readJson(request);
  const result = await getEngine().bus.dispatch({
    name: 'dispute.review',
    input: {
      disputeId: id,
      outcome: body['outcome'],
      ...(body['note'] === undefined ? {} : { note: body['note'] }),
    },
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result);
};

/** Withdraw. Only the raiser, enforced in the domain. */
export const DELETE = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const result = await getEngine().bus.dispatch({
    name: 'dispute.withdraw',
    input: { disputeId: id },
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result);
};
