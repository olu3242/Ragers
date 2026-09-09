import { getEngine } from '../../../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, jsonError, jsonOk, readJson, respond } from '../../../../../lib/api.ts';
import { currentActor } from '../../../../../lib/session.ts';
import { unauthorizedError } from '../../../../../src/runtime/errors.ts';
import { assertedValues } from '../../../../../src/domain/enrichment.ts';
import { enrichmentFor } from '../../../../../src/engines/enrichment.engine.ts';

/**
 * What an experience cost the person it happened to.
 *
 * The read is guarded to the author. Enrichment is not public: "lost £2,400" beside a
 * named account is a detail a reader does not need in order to understand the
 * experience, and RLS refuses it too — this check is so the API says no rather than
 * returning an empty result and looking broken.
 */
export const GET = async (
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const actor = await currentActor();
  const engine = getEngine();
  const experience = await engine.store.experiences.get(id);
  if (!experience || !actor.authenticated || experience.actorId !== actor.actorId) {
    return jsonError(unauthorizedError('policy_ownership', 'that is not yours to read'));
  }
  const enrichment = await enrichmentFor(engine, id);
  return jsonOk({
    asserted: enrichment ? assertedValues(enrichment).map((value) => value.dimension) : [],
  });
};

export const POST = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const body = await readJson(request);
  const result = await getEngine().bus.dispatch({
    name: 'enrichment.assert',
    input: { experienceId: id, ...body },
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result, 201);
};
