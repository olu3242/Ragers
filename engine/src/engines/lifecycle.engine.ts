import { eq } from '../ports/store.ts';
import { decayedWeightOf, recoveryOf, type DecayedWeight, type RecoveryDirection } from '../domain/decay.ts';
import { lifecycleOf, type SignalLifecycle } from '../domain/signal-lifecycle.ts';
import type { ClusterMember } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * Signal lifecycle and decay — E8. Phases 54 and 55.
 *
 * Both derived on read, from rows that already exist. There is no lifecycle column
 * and no decay column, and that is the point of both phases: a stored state goes
 * stale silently, and a stored weight makes every past measure unreproducible.
 *
 * The contributions a lifecycle and a weight are computed from are the same set —
 * the published experiences in the cluster and the active corroborations on them —
 * so the two answers cannot disagree about when the pattern was last touched.
 */

/** The window recovery is measured over. One month: shorter is noise. */
export const RECOVERY_WINDOW_MS = 30 * 86_400_000;

export interface ClusterLifecycle {
  readonly clusterId: string;
  readonly lifecycle: SignalLifecycle;
  readonly weight: DecayedWeight;
  readonly recovery: RecoveryDirection;
  /** Distinct people, not accounts. The count every floor in the system governs. */
  readonly uniqueExperiencers: number;
}

/** Every contribution to a cluster, with its date. Rows, never a cached total. */
const contributionsIn = async (
  deps: EngineDeps,
  clusterId: string,
): Promise<{
  readonly at: readonly number[];
  readonly people: ReadonlySet<string>;
  readonly outcomeReporters: number;
  readonly resolvedShare: number;
}> => {
  const members = await deps.store.clusterMembers.query([eq<ClusterMember>('clusterId', clusterId)]);
  const at: number[] = [];
  const people = new Set<string>();
  const reporters = new Set<string>();
  const resolvedReporters = new Set<string>();

  for (const member of members) {
    const experience = await deps.store.experiences.get(member.experienceId);
    if (!experience || experience.status !== 'published') continue;

    at.push(experience.publishedAt ?? experience.createdAt);
    people.add(experience.actorId);

    for (const claim of await deps.store.corroborations.query([
      eq('experienceId', experience.id),
      eq('status', 'active'),
    ])) {
      at.push(claim.createdAt);
      people.add(claim.corroboratorId);
    }

    // Outcome reporters are counted as *people*, and one person reporting twice is
    // one reporter — otherwise a single satisfied reporter could settle a pattern by
    // saying so repeatedly.
    for (const report of await deps.store.resolutionReports.query([eq('experienceId', experience.id)])) {
      reporters.add(report.reporterId);
      // `resolved_for_me` only. `partially_resolved` is not a fix, and counting it
      // as one is how a settled signal comes to mean "some people are less angry".
      if (report.kind === 'resolved_for_me') resolvedReporters.add(report.reporterId);
    }
  }

  return {
    at,
    people,
    outcomeReporters: reporters.size,
    resolvedShare: reporters.size === 0 ? 0 : resolvedReporters.size / reporters.size,
  };
};

export const clusterLifecycleFor = async (
  deps: EngineDeps,
  clusterId: string,
): Promise<ClusterLifecycle | undefined> => {
  const cluster = await deps.store.clusters.get(clusterId);
  if (!cluster) return undefined;

  const now = deps.clock.now();
  const contributions = await contributionsIn(deps, clusterId);
  const weight = decayedWeightOf({ contributionsAt: contributions.at, now });

  const first = contributions.at.length === 0 ? now : Math.min(...contributions.at);
  const last = weight.lastContributionAt ?? first;
  const recentWindowStart = now - 14 * 86_400_000;

  return {
    clusterId,
    lifecycle: lifecycleOf({
      firstContributionAt: first,
      lastContributionAt: last,
      uniqueExperiencers: contributions.people.size,
      recentContributions: contributions.at.filter((moment) => moment >= recentWindowStart).length,
      resolvedShare: contributions.resolvedShare,
      outcomeReporters: contributions.outcomeReporters,
      now,
    }),
    weight,
    recovery: recoveryOf({ contributionsAt: contributions.at, now }, RECOVERY_WINDOW_MS),
    uniqueExperiencers: contributions.people.size,
  };
};

/**
 * Whether a measured signal may be presented as current.
 *
 * The one question a reader actually asks of a lifecycle, answered in one place so
 * three surfaces cannot answer it three ways.
 */
export const signalIsCurrent = async (deps: EngineDeps, clusterId: string): Promise<boolean> =>
  (await clusterLifecycleFor(deps, clusterId))?.lifecycle.current ?? false;
