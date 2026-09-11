import { getEngine } from '../../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, jsonError, jsonOk, respond } from '../../../../lib/api.ts';
import { currentActor } from '../../../../lib/session.ts';
import { notFoundError } from '../../../../src/runtime/errors.ts';
import { summariseFairness } from '../../../../src/engines/reaction.engine.ts';

/** Read one experience from its projections only — never from the raw row. */
export const GET = async (
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const engine = getEngine();
  const entry = await engine.store.feedEntries.get(id);
  if (!entry || entry.suppressed) {
    return jsonError(notFoundError('experience_not_found', 'that experience is not available'));
  }
  const counters = await engine.store.counters.get(id);
  return jsonOk({
    experience: entry,
    // Claims and responses are reported separately, and shares separately again,
    // so no client can add them up into a single "engagement" number.
    signal: {
      reRages: counters?.reRageCount ?? 0,
      reRaves: counters?.reRaveCount ?? 0,
      // People who say this happened to them, the author aside.
      corroborators: counters?.corroboratorCount ?? 0,
      shares: counters?.shareCount ?? 0,
    },
    responses: {
      same: counters?.same ?? 0,
      fairPoint: counters?.fairPoint ?? 0,
      disagree: counters?.disagree ?? 0,
      replyCount: counters?.replyCount ?? 0,
      fairness: summariseFairness(counters?.fairYes ?? 0, counters?.fairNo ?? 0),
    },
  });
};

/** Author deletion, which triggers propagation across every surface. */
export const DELETE = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const result = await getEngine().bus.dispatch({
    name: 'creator.deleteExperience',
    input: { experienceId: id },
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result, 202);
};
