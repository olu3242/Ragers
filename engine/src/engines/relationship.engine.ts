import { eq } from '../ports/store.ts';
import {
  assembleGraph,
  MAX_GRAPH_DEPTH,
  MAX_GRAPH_NODES,
  mergeConnections,
  reasonForAssertion,
  type Connection,
  type ConnectionEdgeInput,
  type GraphLayer,
  type RelationshipGraph,
} from '../domain/relationship.ts';
import type { ClusterMember, RelationRow } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * Relationship Graph — E6, with E1 and E7 in support. Phase 51.
 *
 * A read, deliberately. `experience_relations` already stores the pair
 * canonically and keys on `(pair, actor)`, and `cluster_members` already records
 * membership; a second edge table would create two answers to "are these two
 * connected", which is the exact duplication this phase's failure test exists to
 * catch. So there is no migration here and no new row anywhere.
 *
 * **Published only.** A relation is asserted while both experiences are published,
 * but that says nothing about later: one of them can be hidden or removed by
 * moderation afterwards, and the stored row survives. Every read here re-checks
 * status now, so a graph cannot disclose the existence of content moderation took
 * down. (This closed a real leak in `relatedTo`, which had no status filter at all
 * and was reachable from a public page and a public route.)
 */

/** Every route into a pair, read now rather than trusted from assertion time. */
const edgesFrom = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<readonly ConnectionEdgeInput[]> => {
  const experience = await deps.store.experiences.get(experienceId);
  if (!experience || experience.status !== 'published') return [];

  const edges: ConnectionEdgeInput[] = [];

  // 1. What people asserted, in either direction. The pair is canonical in the
  //    row, but this experience may be either end of it.
  const asserted = [
    ...(await deps.store.relations.query([
      eq<RelationRow>('fromExperienceId', experienceId),
      eq<RelationRow>('status', 'active'),
    ])),
    ...(await deps.store.relations.query([
      eq<RelationRow>('toExperienceId', experienceId),
      eq<RelationRow>('status', 'active'),
    ])),
  ];
  for (const row of asserted) {
    const other = row.fromExperienceId === experienceId ? row.toExperienceId : row.fromExperienceId;
    edges.push({ experienceId: other, reason: reasonForAssertion(row.assertion), assertedBy: row.assertedBy });
  }

  // 2. Landing in the same cluster. Not asserted by anybody, so it carries no
  //    asserter — a cluster is a key match, and a match is not a claim.
  if (experience.clusterId !== undefined) {
    const members = await deps.store.clusterMembers.query([
      eq<ClusterMember>('clusterId', experience.clusterId),
    ]);
    for (const member of members) {
      if (member.experienceId === experienceId) continue;
      edges.push({ experienceId: member.experienceId, reason: 'same_cluster' });
    }
  }

  // Filter to what is publishable *now*, once, rather than per edge kind.
  const reachable = new Set<string>();
  for (const candidate of new Set(edges.map((edge) => edge.experienceId))) {
    const row = await deps.store.experiences.get(candidate);
    if (row?.status === 'published') reachable.add(candidate);
  }
  return edges.filter((edge) => reachable.has(edge.experienceId));
};

/**
 * What this experience is connected to, and why.
 *
 * One entry per connected experience however many routes reach it, which is the
 * property that keeps a degree meaning what a reader thinks it means.
 */
export const connectionsOf = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<readonly Connection[]> => mergeConnections(await edgesFrom(deps, experienceId));

/**
 * The graph around one experience, breadth-first and bounded.
 *
 * Bounded twice on purpose: `MAX_GRAPH_DEPTH` because past two hops a reader cannot
 * interpret what they are looking at, and `MAX_GRAPH_NODES` because an experience in
 * a large cluster would otherwise return the cluster. `truncated` says a bound was
 * reached, rather than quietly returning a smaller graph as if it were the whole.
 */
export const relationshipGraphFor = async (
  deps: EngineDeps,
  experienceId: string,
  options: { readonly depth?: number } = {},
): Promise<RelationshipGraph> => {
  const depth = Math.max(1, Math.min(options.depth ?? 1, MAX_GRAPH_DEPTH));
  const seed = await deps.store.experiences.get(experienceId);
  if (!seed || seed.status !== 'published') {
    return assembleGraph(experienceId, []);
  }

  const layers: GraphLayer[] = [];
  const walked = new Set<string>();
  const seen = new Set<string>([experienceId]);
  let frontier: readonly string[] = [experienceId];
  let truncated = false;

  for (let hop = 0; hop < depth; hop += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      if (walked.has(current)) continue;
      walked.add(current);
      const connections = await connectionsOf(deps, current);
      layers.push({ experienceId: current, depth: hop, connections });
      for (const connection of connections) {
        if (seen.has(connection.experienceId)) continue;
        if (seen.size >= MAX_GRAPH_NODES) {
          truncated = true;
          continue;
        }
        seen.add(connection.experienceId);
        next.push(connection.experienceId);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
    if (hop + 1 === depth && frontier.length > 0) truncated = true;
  }

  return assembleGraph(experienceId, layers, { truncated });
};

/** A count a reader will interpret as "how big is this". One per connected pair. */
export const connectionCountOf = async (deps: EngineDeps, experienceId: string): Promise<number> =>
  (await connectionsOf(deps, experienceId)).length;

/**
 * Deliberately absent: any read keyed on an actor.
 *
 * A relationship graph over *people* is a different product, and one this band does
 * not build. `graph.engine.ts` owns follow/block/mute between people and stays
 * separate; nothing here joins the two.
 */
export const actorRelationshipGraph = (): undefined => undefined;
