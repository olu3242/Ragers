import { getEngine } from '../../../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, jsonError, jsonOk, readJson, respond } from '../../../../../lib/api.ts';
import { currentActor } from '../../../../../lib/session.ts';
import { notFoundError } from '../../../../../src/runtime/errors.ts';
import { resolutionSummaryFor } from '../../../../../src/engines/resolution.engine.ts';

/** What the people it happened to say about the outcome. Counted, never attributed. */
export const GET = async (
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const summary = await resolutionSummaryFor(getEngine(), id);
  if (!summary) return jsonError(notFoundError('experience_not_found', 'that experience is not available'));
  return jsonOk(summary);
};

/**
 * Report an outcome. Only the author or an active corroborator may — an
 * organization has no route here at all.
 */
export const POST = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const body = await readJson(request);
  const result = await getEngine().bus.dispatch({
    name: 'resolution.report',
    input: {
      experienceId: id,
      kind: body['kind'],
      ...(body['note'] === undefined ? {} : { note: body['note'] }),
    },
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result);
};
