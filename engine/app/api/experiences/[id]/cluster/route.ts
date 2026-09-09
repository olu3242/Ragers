import { getEngine } from '../../../../../lib/engine-instance.ts';
import { jsonError, jsonOk } from '../../../../../lib/api.ts';
import { notFoundError } from '../../../../../src/runtime/errors.ts';
import { eq } from '../../../../../src/ports/store.ts';
import type { ClusterMember } from '../../../../../src/ports/store.ts';

/**
 * The pattern an experience belongs to, if any.
 *
 * Read from the membership projection rather than the raw experience row, and it
 * returns an id and a relationship only — nothing about who posted anything.
 */
export const GET = async (
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const membership = await getEngine().store.clusterMembers.queryOne([
    eq<ClusterMember>('experienceId', id),
  ]);
  // No cluster is a correct answer, not an error: an experience nobody has
  // confirmed an entity for belongs to no pattern.
  if (!membership) return jsonError(notFoundError('no_cluster', 'that experience is not in a pattern yet'));
  return jsonOk({ clusterId: membership.clusterId, relationship: membership.relationship });
};
