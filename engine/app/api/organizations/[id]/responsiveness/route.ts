import { getEngine } from '../../../../../lib/engine-instance.ts';
import { jsonError, jsonOk } from '../../../../../lib/api.ts';
import { notFoundError } from '../../../../../src/runtime/errors.ts';
import { publicResponsivenessFor } from '../../../../../src/engines/responsiveness.engine.ts';

/**
 * An organization's answering record. Public: it is part of what a reader is
 * entitled to know.
 *
 * Not an SLA, and never described as one — no service-level agreement exists.
 * Below the sample floor the medians are withheld and `insufficientSample` says so,
 * because a precise-looking figure from two cases is worse than no figure.
 */
export const GET = async (
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const view = await publicResponsivenessFor(getEngine(), id);
  if (!view) return jsonError(notFoundError('organization_not_found', 'no such organization'));
  return jsonOk(view);
};
