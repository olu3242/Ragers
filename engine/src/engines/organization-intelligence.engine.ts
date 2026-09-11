import { eq } from '../ports/store.ts';
import { publicResponsivenessFor } from './responsiveness.engine.ts';
import { benchmarkDataReadiness } from './benchmark.engine.ts';
import { discover, signalIsCurrent, type DiscoveryResult } from './discovery.engine.ts';
import { patternHistoryFor } from './history.engine.ts';
import { lifecycleOf } from '../domain/signal-lifecycle.ts';
import type { ClusterRow, SignalSnapshotRow } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * Organization intelligence — E11, Phase 75.
 *
 * **This module computes nothing.** It composes reads that are each already governed and
 * each already carry their own floors: responsiveness (which is a `Measure` and withholds
 * itself below its sample floor), pattern history (which applies the person floor per
 * period and the differencing guard between them), the signal lifecycle (which says whether
 * a pattern is still current), and discovery (which re-checks status per candidate).
 *
 * That constraint is the whole design. The tempting version of this phase is a "company
 * intelligence score" — one number per organization, comparable across organizations,
 * sortable. It would be immediately useful and it is the single most dangerous thing this
 * codebase could produce, for two reasons:
 *
 * **A score would be a judgement the data cannot support.** Every input here is bounded:
 * responsiveness withholds below its floor, history suppresses thin periods, benchmarks are
 * data-blocked because no environment has twenty distinct contributors per comparison set.
 * A composite over withheld inputs is a number with no denominator, and it would be
 * published beside a company's name.
 *
 * **A ranking would be the product's centre of gravity.** A league table of the worst
 * companies is what a discovery band naturally grows into, and once it exists every other
 * rule bends towards feeding it. `organizationLeaderboard()` returns undefined and
 * `organizationIntelligenceScore()` returns undefined, so both absences are assertable
 * rather than merely current.
 *
 * Ranking organizations against each other is Phase 47's question, it is already
 * implemented, and it is `CODE_READY_DATA_BLOCKED` for exactly this reason: the floors are
 * real and no environment clears them. This phase does not route around that.
 */

export interface OrganizationPattern {
  readonly clusterId: string;
  readonly headline: string;
  /** People, never rows. */
  readonly uniqueExperiencers: number;
  readonly lifecycleState: string;
  /** Whether this pattern is still happening, as opposed to having happened. */
  readonly current: boolean;
}

export interface OrganizationIntelligence {
  readonly organizationId: string;
  /** Withheld below its sample floor, by `publicResponsivenessFor` rather than by this module. */
  readonly responsiveness: Awaited<ReturnType<typeof publicResponsivenessFor>>;
  /** Patterns about this organization, each labelled with whether it is current. */
  readonly patterns: readonly OrganizationPattern[];
  /** Recent experiences, ranked by the same named factors as everything else. */
  readonly recent: readonly DiscoveryResult[];
  /**
   * Why a benchmark is absent, when it is. Present rather than an empty field, because
   * "no comparison available" and "compares favourably" must never look alike.
   */
  readonly benchmark: { readonly available: boolean; readonly reason?: string };
  readonly generatedAt: number;
}

/**
 * One composed read about one organization.
 *
 * Every figure arrives already bounded by the read that owns it. Nothing here re-derives a
 * measure, applies a second floor, or combines two figures — a combination is where a
 * judgement would enter.
 */
export const organizationIntelligenceFor = async (
  deps: EngineDeps,
  organizationId: string,
): Promise<OrganizationIntelligence> => {
  const profile = await deps.store.organizationProfiles.get(organizationId);
  const entityId = profile?.entityId;

  const clusters =
    entityId === undefined
      ? []
      : await deps.store.clusters.query([eq<ClusterRow>('entityId', entityId)]);

  const patterns: OrganizationPattern[] = [];
  for (const cluster of clusters) {
    const snapshot = await deps.store.signalSnapshots.queryOne([
      eq<SignalSnapshotRow>('clusterId', cluster.id),
    ]);
    // Built once and passed to both reads. Two copies would be two chances to drift, and
    // `lifecycleOf` and `signalIsCurrent` disagreeing about the same pattern is exactly the
    // kind of inconsistency a reader would have no way to detect.
    const input = {
      firstContributionAt: cluster.createdAt,
      lastContributionAt: snapshot?.computedAt ?? cluster.updatedAt,
      uniqueExperiencers: cluster.uniqueExperiencers,
      recentContributions: snapshot?.uniqueExperiencers ?? 0,
      // `resolvedShare` and `outcomeReporters` are zero here rather than derived, and that
      // is deliberate: the lifecycle only lets the resolved share decide anything once
      // enough people have reported an outcome, so passing zero means "nobody has said",
      // which is the honest input for a composed read that is not measuring resolution.
      resolvedShare: 0,
      outcomeReporters: 0,
      now: deps.clock.now(),
    };
    patterns.push({
      clusterId: cluster.id,
      headline: cluster.headline,
      uniqueExperiencers: cluster.uniqueExperiencers,
      lifecycleState: lifecycleOf(input).state,
      // Stated per pattern rather than filtered out, because "this used to happen" is
      // information an organization and a reader both want — it is just not the same
      // information as "this happens".
      current: signalIsCurrent(input),
    });
  }

  const readiness = await benchmarkDataReadiness(deps);

  return {
    organizationId,
    responsiveness: await publicResponsivenessFor(deps, organizationId),
    patterns,
    recent: entityId === undefined ? [] : await discover(deps, { entityId, limit: 10 }),
    benchmark: readiness.ready
      ? { available: true }
      : {
          available: false,
          // The reason is built from the readiness figures rather than taken from a field,
          // so it cannot say "unavailable" without saying how far short the data falls.
          reason: `${readiness.distinctContributors} distinct contributor(s) against a floor of ${readiness.floor}`,
        },
    generatedAt: deps.clock.now(),
  };
};

/**
 * The organization's own view of its history, per pattern.
 *
 * Separated from the composed read because a history is a series and the composed read is a
 * snapshot — putting a series inside a snapshot invites reading the last point as the
 * current state, which is the mistake Phase 53 exists to prevent.
 */
export const organizationHistoryFor = async (
  deps: EngineDeps,
  clusterId: string,
): Promise<Awaited<ReturnType<typeof patternHistoryFor>>> => patternHistoryFor(deps, clusterId);

/**
 * The two absences, as code.
 *
 * A league table is what a discovery band naturally grows into, and once it exists every
 * other rule bends towards feeding it. A score is a judgement over inputs that withhold
 * themselves, published beside a company's name.
 */
export const organizationLeaderboard = (): undefined => undefined;
export const organizationIntelligenceScore = (): undefined => undefined;
