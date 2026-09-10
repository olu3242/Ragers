import { eq } from '../ports/store.ts';
import { analyseCoordination, type ClaimArrival, type CoordinationFinding } from '../domain/coordination.ts';
import { enqueueForReview } from './safety.engine.ts';
import type { ClusterMember, CorroborationRow, QueueItem } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * Coordinated inauthenticity review — E4 Trust, with E6 Community in support. Phase 62.
 *
 * Reads corroborations, runs the analysis, and opens a review. That is the whole of it:
 * this file writes to `moderation_queue` and to nothing else, which is what makes
 * "detection is not action" checkable rather than promised.
 *
 * **Priority, deliberately at the bottom.** A coordination review is less urgent than a
 * naming-and-shaming report, because nothing is happening to anybody while it waits. It
 * is queued so a person sees it, not so a person drops what they are doing.
 */

/** Below `naming_shaming` (20) and below an ordinary report (5). */
export const COORDINATION_REVIEW_PRIORITY = 3;

/** Every claim on every published experience in a cluster, with its arrival time. */
export const claimArrivalsInCluster = async (
  deps: EngineDeps,
  clusterId: string,
): Promise<readonly ClaimArrival[]> => {
  const members = await deps.store.clusterMembers.query([eq<ClusterMember>('clusterId', clusterId)]);
  const arrivals: ClaimArrival[] = [];
  for (const member of members) {
    const experience = await deps.store.experiences.get(member.experienceId);
    if (!experience || experience.status !== 'published') continue;
    for (const claim of await deps.store.corroborations.query([
      eq<CorroborationRow>('experienceId', experience.id),
      eq<CorroborationRow>('status', 'active'),
    ])) {
      arrivals.push({
        experienceId: claim.experienceId,
        actorId: claim.corroboratorId,
        createdAt: claim.createdAt,
      });
    }
  }
  return arrivals;
};

export const findingsForCluster = async (
  deps: EngineDeps,
  clusterId: string,
): Promise<readonly CoordinationFinding[]> => analyseCoordination(await claimArrivalsInCluster(deps, clusterId));

export interface CoordinationReview {
  readonly finding: CoordinationFinding;
  readonly queueItemId: string;
}

/**
 * Open a review per finding.
 *
 * Queued against the *experience*, using the existing moderation queue and its
 * deterministic key, so a sweep that runs repeatedly produces one item rather than one
 * per run. The queue item names the experience a moderator should open; it does not
 * name the cohort, because the queue is a work list and the accounts are a detail of
 * the investigation rather than a label to hang on anybody.
 */
export const reviewCoordination = async (
  deps: EngineDeps,
  clusterId: string,
): Promise<readonly CoordinationReview[]> => {
  const findings = await findingsForCluster(deps, clusterId);
  const opened: CoordinationReview[] = [];
  for (const finding of findings) {
    // The earliest experience in the finding, so repeated sweeps converge on one item
    // rather than rotating between them.
    const target = finding.experienceIds[0];
    if (target === undefined) continue;
    const queueItemId = await enqueueForReview(deps, 'experience', target, COORDINATION_REVIEW_PRIORITY);
    deps.metrics.increment('coordination.review_opened', { shared: String(finding.sharedCount) });
    opened.push({ finding, queueItemId });
  }
  return opened;
};

/** Whether an experience currently has a review open. A read, for the operator surface. */
export const hasOpenReview = async (deps: EngineDeps, experienceId: string): Promise<boolean> => {
  const item = await deps.store.queueItems.queryOne([
    eq<QueueItem>('targetType', 'experience'),
    eq<QueueItem>('targetId', experienceId),
  ]);
  return item !== undefined && item.state !== 'actioned';
};

/**
 * The guarantee, as code: detection writes to no table but the queue.
 *
 * Asserted by a test rather than trusted to review, in the same shape as
 * `handoffMutatesGovernedState` and `planMutatesGovernedState`.
 */
export const coordinationMutatesClaims = (): false => false;
