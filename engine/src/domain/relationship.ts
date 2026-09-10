import type { RelationAssertion } from './relation.ts';

/**
 * Phase 51 — the experience relationship graph.
 *
 * **Nodes are experiences.** There is no actor node, no actor edge, and nothing in
 * these types through which one could be derived — `assertedByCount` is a count and
 * carries no identity. A generic social graph is not in scope here and is not a
 * stepping stone to anything in this band: the follow/block/mute graph E6 already
 * owns is between *people* and is deliberately kept separate, because merging the
 * two would let "who you follow" reach what an experience is connected to.
 *
 * **One connection is one edge.** Two experiences can be connected by several
 * routes at once — somebody asserted the pair, and they also landed in the same
 * cluster — and that is one connection with two reasons, never two connections.
 * Counting it twice would inflate a degree, and a degree is the one number a reader
 * will read as "how big is this".
 *
 * **An edge carries no trust weight.** `trustWeight` is the literal `0`, so a caller
 * cannot mistake a well-connected experience for a well-corroborated one. Relating a
 * hundred pairs purchases no credibility, and this is the same rule the Relate
 * engine states — restated here because the graph is where somebody would be
 * tempted to sum it.
 */

/** Why two experiences are connected. Named, never summed into a score. */
export type ConnectionReason =
  | 'same_occurrence_asserted'
  | 'same_pattern_asserted'
  | 'related_context_asserted'
  | 'same_cluster';

export const CONNECTION_REASONS: readonly ConnectionReason[] = [
  'same_occurrence_asserted',
  'same_pattern_asserted',
  'related_context_asserted',
  'same_cluster',
];

/**
 * Presentation order only: the reason listed first is the most specific one anybody
 * offered. This is not a weight and nothing adds these numbers.
 */
const REASON_ORDER: Readonly<Record<ConnectionReason, number>> = {
  same_occurrence_asserted: 0,
  same_pattern_asserted: 1,
  same_cluster: 2,
  related_context_asserted: 3,
};

export const reasonForAssertion = (assertion: RelationAssertion): ConnectionReason => {
  switch (assertion) {
    case 'same_occurrence':
      return 'same_occurrence_asserted';
    case 'same_pattern':
      return 'same_pattern_asserted';
    default:
      return 'related_context_asserted';
  }
};

/** One route into a pair, before deduplication. */
export interface ConnectionEdgeInput {
  readonly experienceId: string;
  readonly reason: ConnectionReason;
  /** Present only for an asserted reason. A cluster is not asserted by anybody. */
  readonly assertedBy?: string;
}

export interface Connection {
  readonly experienceId: string;
  /** Every distinct reason, most specific first. */
  readonly reasons: readonly ConnectionReason[];
  /** Distinct people who asserted this pair. Zero when the only reason is a cluster. */
  readonly assertedByCount: number;
  /** Always zero. A connection is discovery, never corroboration. */
  readonly trustWeight: 0;
}

/**
 * Collapse every route into a pair down to one connection.
 *
 * This is the whole of the duplication guard, and it is here rather than in the
 * engine because it is the property the phase is judged on: assert a pair and also
 * cluster it, and the degree must not move.
 */
export const mergeConnections = (edges: readonly ConnectionEdgeInput[]): readonly Connection[] => {
  const byExperience = new Map<string, { reasons: Set<ConnectionReason>; asserters: Set<string> }>();
  for (const edge of edges) {
    const entry = byExperience.get(edge.experienceId) ?? { reasons: new Set(), asserters: new Set() };
    entry.reasons.add(edge.reason);
    if (edge.assertedBy !== undefined && edge.assertedBy.length > 0) entry.asserters.add(edge.assertedBy);
    byExperience.set(edge.experienceId, entry);
  }

  return [...byExperience.entries()]
    .map(([experienceId, entry]) => ({
      experienceId,
      reasons: [...entry.reasons].sort((left, right) => REASON_ORDER[left] - REASON_ORDER[right]),
      assertedByCount: entry.asserters.size,
      trustWeight: 0 as const,
    }))
    .sort(
      (left, right) =>
        right.assertedByCount - left.assertedByCount ||
        (REASON_ORDER[left.reasons[0] as ConnectionReason] ?? 9) -
          (REASON_ORDER[right.reasons[0] as ConnectionReason] ?? 9) ||
        left.experienceId.localeCompare(right.experienceId),
    );
};

/**
 * Canonical key for an undirected pair.
 *
 * A → B and B → A are one edge. The Relate engine already canonicalises the stored
 * row; this canonicalises the *graph*, where a pair can also arrive from both ends
 * of a traversal.
 */
export const edgeKeyOf = (left: string, right: string): string =>
  left < right ? `${left}|${right}` : `${right}|${left}`;

/**
 * Traversal bounds.
 *
 * Depth 2 because "connected to something connected to this" is the last hop a
 * reader can still interpret; beyond it a graph read becomes a crawl of the whole
 * table dressed up as a feature. The node cap is the same argument applied to
 * breadth, and `truncated` says so out loud rather than silently returning less.
 */
export const MAX_GRAPH_DEPTH = 2;
export const MAX_GRAPH_NODES = 50;

export interface GraphNode {
  readonly experienceId: string;
  /** Hops from the seed. The seed itself is 0. */
  readonly depth: number;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly reasons: readonly ConnectionReason[];
  readonly assertedByCount: number;
}

export interface RelationshipGraph {
  readonly seedId: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** True when a bound stopped the walk, so a reader knows this is not the whole of it. */
  readonly truncated: boolean;
  /** Always zero, for the graph as a whole as well as for each edge. */
  readonly trustWeight: 0;
}

/** One experience's connections, as gathered by the engine at a known depth. */
export interface GraphLayer {
  readonly experienceId: string;
  readonly depth: number;
  readonly connections: readonly Connection[];
}

/**
 * Assemble the walked layers into a graph, with every pair appearing once.
 *
 * The engine does the reading; this does the deduplication, because that is the
 * part with a rule in it. An edge discovered from both of its ends — which happens
 * on every second hop — is one edge, and its reasons are the union of what both
 * ends saw.
 */
export const assembleGraph = (
  seedId: string,
  layers: readonly GraphLayer[],
  options: { readonly truncated?: boolean } = {},
): RelationshipGraph => {
  const depthOf = new Map<string, number>([[seedId, 0]]);
  for (const layer of layers) {
    const current = depthOf.get(layer.experienceId);
    if (current === undefined || layer.depth < current) depthOf.set(layer.experienceId, layer.depth);
    for (const connection of layer.connections) {
      const reached = layer.depth + 1;
      const known = depthOf.get(connection.experienceId);
      if (known === undefined || reached < known) depthOf.set(connection.experienceId, reached);
    }
  }

  const edges = new Map<string, GraphEdge>();
  for (const layer of layers) {
    for (const connection of layer.connections) {
      const key = edgeKeyOf(layer.experienceId, connection.experienceId);
      const existing = edges.get(key);
      const [from, to] = key.split('|') as [string, string];
      if (!existing) {
        edges.set(key, {
          from,
          to,
          reasons: connection.reasons,
          assertedByCount: connection.assertedByCount,
        });
        continue;
      }
      // Seen from the other end: the union of reasons, and the larger asserter
      // count, since each end counted the same distinct people.
      const reasons = [...new Set([...existing.reasons, ...connection.reasons])].sort(
        (left, right) => REASON_ORDER[left] - REASON_ORDER[right],
      );
      edges.set(key, {
        from: existing.from,
        to: existing.to,
        reasons,
        assertedByCount: Math.max(existing.assertedByCount, connection.assertedByCount),
      });
    }
  }

  return {
    seedId,
    nodes: [...depthOf.entries()]
      .map(([experienceId, depth]) => ({ experienceId, depth }))
      .sort((left, right) => left.depth - right.depth || left.experienceId.localeCompare(right.experienceId)),
    edges: [...edges.values()].sort(
      (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
    ),
    truncated: options.truncated ?? false,
    trustWeight: 0,
  };
};

/** The number a reader will read as "how big is this". One per connected pair. */
export const degreeOf = (graph: RelationshipGraph, experienceId: string): number =>
  graph.edges.filter((edge) => edge.from === experienceId || edge.to === experienceId).length;
