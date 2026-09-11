import { getEngine } from '../../../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, readJson, respond } from '../../../../../lib/api.ts';
import { currentActor } from '../../../../../lib/session.ts';

/**
 * Decide a proposal.
 *
 * The response carries `dispatched` and, on failure, `dispatchError`: approving
 * records a decision, and whether the governed action actually ran is the target
 * engine's call. A caller must be able to tell those apart, so both are returned.
 */
export const POST = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const body = await readJson(request);
  const result = await getEngine().bus.dispatch({
    name: 'proposal.decide',
    input: {
      proposalId: id,
      outcome: body['outcome'],
      ...(body['note'] === undefined ? {} : { note: body['note'] }),
    },
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result);
};
