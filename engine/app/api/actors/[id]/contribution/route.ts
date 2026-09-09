import { getEngine } from '../../../../../lib/engine-instance.ts';
import { jsonOk } from '../../../../../lib/api.ts';
import { contributionViewOf } from '../../../../../src/engines/reputation.engine.ts';

/**
 * What a person contributed and what others confirmed.
 *
 * Separately-named counts and no composite: a score beside somebody's name turns
 * every contribution into a referendum on the contributor. Nothing from the trust
 * layer or `internalSignals` appears here, and nothing about popularity.
 */
export const GET = async (
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  return jsonOk(await contributionViewOf(getEngine(), id));
};
