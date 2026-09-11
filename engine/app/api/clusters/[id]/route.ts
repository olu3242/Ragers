import { getEngine } from '../../../../lib/engine-instance.ts';
import { jsonError, jsonOk } from '../../../../lib/api.ts';
import { notFoundError } from '../../../../src/runtime/errors.ts';
import { clusterWithMembers } from '../../../../src/engines/matching.engine.ts';
import { publicSignalFor } from '../../../../src/engines/signal.engine.ts';
import { publicResponsesFor } from '../../../../src/engines/organization.engine.ts';

/**
 * A cluster and its measured signal.
 *
 * Named metrics only. There is deliberately no single score here — see
 * `publicSignalFor`.
 */
export const GET = async (
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const engine = getEngine();
  const view = await clusterWithMembers(engine, id);
  if (!view) return jsonError(notFoundError('cluster_not_found', 'no such cluster'));

  return jsonOk({
    cluster: {
      clusterId: view.cluster.id,
      headline: view.cluster.headline,
      kind: view.cluster.kind,
      totalExperiences: view.cluster.totalExperiences,
      // People, counted once each. Never the same number as corroborations.
      uniqueExperiencers: view.cluster.uniqueExperiencers,
      corroborations: view.cluster.corroborations,
    },
    signal: await publicSignalFor(engine, id),
    // An organization's account sits beside the accounts it answers.
    responses: await publicResponsesFor(engine, { clusterId: id }),
    // Member experience ids only: the projection carries no author reference.
    members: view.members.map((member) => ({
      experienceId: member.experienceId,
      relationship: member.relationship,
    })),
  });
};
