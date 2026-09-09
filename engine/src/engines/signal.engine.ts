import { ok } from '../runtime/result.ts';
import { computeSignal, highestConcentration, isTrending, type SignalInputs } from '../domain/signal.ts';
import { measure, type Measure } from '../domain/sampling.ts';
import { eq } from '../ports/store.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { ClusterMember, EvidenceRow, SignalSnapshotRow } from '../ports/store.ts';
import type { ResolutionReport } from '../domain/resolution.ts';
import type { EngineDeps } from './deps.ts';

/**
 * Signal Engine — the measured shape of a repeated experience.
 *
 * Every metric is recomputed from rows into a snapshot, never incremented. A
 * snapshot is therefore reproducible: given the same rows it is the same
 * snapshot, which is what makes it defensible to show an organization.
 *
 * What this engine deliberately does not produce: a single "outrage score". The
 * metrics stay separate — how many people, how much context, how often it
 * repeats, how much of it is unresolved — because collapsing them into one number
 * is how a system starts optimising for the loudest thing rather than the most
 * serious one.
 */

const hasEvidenceFor = async (
  deps: EngineDeps,
  key: { experienceId?: string; corroborationId?: string },
): Promise<boolean> => {
  const criteria = key.experienceId
    ? [eq<EvidenceRow>('experienceId', key.experienceId)]
    : [eq<EvidenceRow>('corroborationId', key.corroborationId ?? '')];
  return (await deps.store.evidence.countWhere(criteria)) > 0;
};

/** Gather the rows a snapshot is computed from. */
export const signalInputsForCluster = async (
  deps: EngineDeps,
  clusterId: string,
): Promise<SignalInputs> => {
  const members = await deps.store.clusterMembers.query([eq<ClusterMember>('clusterId', clusterId)]);

  const experiences: SignalInputs['experiences'][number][] = [];
  const corroborations: SignalInputs['corroborations'][number][] = [];
  const reports: ResolutionReport[] = [];
  const respondedExperienceIds: string[] = [];

  for (const member of members) {
    const experience = await deps.store.experiences.get(member.experienceId);
    if (!experience || experience.status !== 'published') continue;

    // Resolution timing comes from when the transition was recorded. Both of
    // these are declarative so they push down to SQL rather than scanning.
    const resolvedEvent = await deps.store.resolutionEvents.queryOne([
      eq('experienceId', experience.id),
      eq('toStatus', 'resolved'),
    ]);
    const reopenedCount = await deps.store.resolutionEvents.countWhere([
      eq('experienceId', experience.id),
      eq('toStatus', 'reopened'),
    ]);

    experiences.push({
      id: experience.id,
      kind: experience.kind,
      actorId: experience.actorId,
      publishedAt: experience.publishedAt ?? experience.createdAt,
      ...(experience.locationId === undefined ? {} : { locationId: experience.locationId }),
      hasVoice: experience.mediaAssetId !== undefined,
      hasNarrative: experience.bodyText.length > 0,
      hasEvidence: await hasEvidenceFor(deps, { experienceId: experience.id }),
      resolutionStatus: experience.resolutionStatus ?? 'open',
      ...(resolvedEvent === undefined ? {} : { resolvedAt: resolvedEvent.createdAt }),
      reopenedCount,
    });

    for (const claim of await deps.store.corroborations.query([
      eq('experienceId', experience.id),
      eq('status', 'active'),
    ])) {
      corroborations.push({
        experienceId: claim.experienceId,
        corroboratorId: claim.corroboratorId,
        type: claim.type,
        createdAt: claim.createdAt,
        ...(claim.locationId === undefined ? {} : { locationId: claim.locationId }),
        hasVoice: claim.mediaAssetId !== undefined,
        hasNarrative: claim.narrative !== undefined,
        hasEvidence: await hasEvidenceFor(deps, { corroborationId: claim.id }),
      });
    }

    for (const report of await deps.store.resolutionReports.query([eq('experienceId', experience.id)])) {
      reports.push(report);
    }

    if ((await deps.store.organizationResponses.countWhere([eq('experienceId', experience.id)])) > 0) {
      respondedExperienceIds.push(experience.id);
    }
  }

  return { experiences, corroborations, reports, respondedExperienceIds, now: deps.clock.now() };
};

/**
 * Recompute a cluster's snapshot.
 *
 * Keyed on (subject, window) so a re-delivery overwrites the snapshot rather than
 * appending a second one for the same moment. History is the sequence of windows,
 * not the sequence of deliveries.
 */
export const recomputeClusterSignal = async (
  deps: EngineDeps,
  clusterId: string,
): Promise<SignalSnapshotRow | undefined> => {
  const cluster = await deps.store.clusters.get(clusterId);
  if (!cluster) return undefined;

  const metrics = computeSignal(await signalInputsForCluster(deps, clusterId));
  const snapshot: SignalSnapshotRow = {
    id: `sig_${clusterId}_all`,
    clusterId,
    windowSpan: 'all',
    rageCount: metrics.rageCount,
    raveCount: metrics.raveCount,
    reRageCount: metrics.reRageCount,
    reRaveCount: metrics.reRaveCount,
    uniqueExperiencers: metrics.uniqueExperiencers,
    contextSupportedCount: metrics.contextSupportedCount,
    voiceSupportedCount: metrics.voiceSupportedCount,
    evidenceSupportedCount: metrics.evidenceSupportedCount,
    responseRate: metrics.responseRate,
    resolutionRate: metrics.resolutionRate,
    ...(metrics.medianResolutionMs === undefined ? {} : { medianResolutionMs: metrics.medianResolutionMs }),
    repeatIncidence: metrics.repeatIncidence,
    geographicConcentration: metrics.geographicConcentration,
    growthRate: metrics.growthRate,
    signalAcceleration: metrics.signalAcceleration,
    reopenRate: metrics.reopenRate,
    computedAt: metrics.computedAt,
  };
  await deps.store.signalSnapshots.put(snapshot);
  deps.metrics.increment('signal.snapshot_recomputed');
  return snapshot;
};

/**
 * Snapshots follow every event that can change what they measure.
 *
 * Listed explicitly rather than by wildcard: a metric that silently stops
 * updating because an event was renamed is worse than one that never existed.
 */
export const createSignalSnapshotConsumer = (deps: EngineDeps): Consumer => ({
  name: 'signal.recompute',
  events: [
    'ClusterMembershipChanged',
    'ExperienceReRaged',
    'ExperienceReRaved',
    'CorroborationRetracted',
    'ResolutionReported',
    'ResolutionStatusChanged',
    'OrganizationResponded',
    'EvidenceAttached',
    'ExperienceDeleted',
    'ContentRemoved',
  ],
  handle: async (event) => {
    const clusterId = String(event.payload['clusterId'] ?? '');
    if (clusterId) {
      await recomputeClusterSignal(deps, clusterId);
      return ok(undefined);
    }

    const experienceId = String(event.payload['experienceId'] ?? '');
    if (!experienceId) return ok(undefined);
    const membership = await deps.store.clusterMembers.queryOne([
      eq<ClusterMember>('experienceId', experienceId),
    ]);
    // An experience outside any cluster still has no cluster signal — that is a
    // correct absence, not a missing computation.
    if (!membership) return ok(undefined);
    await recomputeClusterSignal(deps, membership.clusterId);
    return ok(undefined);
  },
});

/** The public view of a cluster's signal. Named metrics, never a single score. */
export interface PublicSignal {
  readonly clusterId: string;
  readonly headline: string;
  readonly peopleAffected: number;
  readonly experiences: number;
  readonly corroborations: number;
  readonly withContext: number;
  readonly withVoice: number;
  readonly withEvidence: number;
  /**
   * Rates, through the Phase 38 floor.
   *
   * `Measure` rather than `number` because a rate over two experiences describes two
   * experiences, and the page that used to render `resolutionRate ?? 0` published
   * "0% reported resolved" whenever there was no data — a serious thing to say about
   * an organization by accident. A withheld measure has no value to fall back to.
   */
  readonly responseRate: Measure<number>;
  readonly resolutionRate: Measure<number>;
  readonly repeatIncidence: number;
  /** The location carrying the most claims, with how many. Never a precise place. */
  readonly topLocation?: { readonly locationId: string; readonly count: number };
  readonly trending: boolean;
  readonly computedAt: number;
}

export const publicSignalFor = async (
  deps: EngineDeps,
  clusterId: string,
): Promise<PublicSignal | undefined> => {
  const cluster = await deps.store.clusters.get(clusterId);
  const snapshot = await deps.store.signalSnapshots.get(`sig_${clusterId}_all`);
  if (!cluster || !snapshot) return undefined;

  const top = highestConcentration(snapshot.geographicConcentration);
  const experienceCount = snapshot.rageCount + snapshot.raveCount;
  return {
    clusterId,
    headline: cluster.headline,
    peopleAffected: snapshot.uniqueExperiencers,
    experiences: snapshot.rageCount + snapshot.raveCount,
    corroborations: snapshot.reRageCount + snapshot.reRaveCount,
    withContext: snapshot.contextSupportedCount,
    withVoice: snapshot.voiceSupportedCount,
    withEvidence: snapshot.evidenceSupportedCount,
    // The denominator is experiences in the pattern, which is what the rate is over.
    responseRate: measure('resolution_rate', experienceCount, () => snapshot.responseRate),
    resolutionRate: measure('resolution_rate', experienceCount, () => snapshot.resolutionRate),
    repeatIncidence: snapshot.repeatIncidence,
    ...(top === undefined ? {} : { topLocation: top }),
    trending: isTrending(
      {
        ...snapshot,
        // `isTrending` reads only these two, and reads them from the snapshot so
        // the decision is reproducible from stored rows.
        uniqueExperiencers: snapshot.uniqueExperiencers,
        growthRate: snapshot.growthRate,
      },
      deps.config.trendMinVolume,
    ),
    computedAt: snapshot.computedAt,
  };
};
