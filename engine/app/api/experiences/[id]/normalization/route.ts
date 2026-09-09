import { getEngine } from '../../../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, jsonOk, readJson, respond } from '../../../../../lib/api.ts';
import { currentActor } from '../../../../../lib/session.ts';
import { pendingSuggestions } from '../../../../../src/engines/normalization.engine.ts';

/**
 * Suggestions awaiting confirmation.
 *
 * Each carries the person's own words it was read from, so the confirmation step
 * can show why it is asking rather than presenting a value from nowhere.
 */
export const GET = async (
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  return jsonOk({ suggestions: await pendingSuggestions(getEngine(), id) });
};

/** Confirm. Only what is affirmed here becomes a fact anything else may read. */
export const POST = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const body = await readJson(request);
  const result = await getEngine().bus.dispatch({
    name: 'normalization.confirm',
    input: { experienceId: id, fields: body['fields'] ?? {} },
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result);
};
