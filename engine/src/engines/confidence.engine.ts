import { eq } from '../ports/store.ts';
import { ok } from '../runtime/result.ts';
import {
  assessConfidence,
  confidenceSeries,
  explainConfidence,
  type Confidence,
  type ConfidenceInput,
  type ConfidencePoint,
} from '../domain/confidence.ts';
import { analyseCoordination } from '../domain/coordination.ts';
import { isDiscoverable } from './discovery.engine.ts';
import type {
  ClusterMember,
  ConfidencePointRow,
  CorroborationRow,
  EvidenceAssessment,
  EvidenceRow,
} from '../ports/store.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { DomainEventEnvelope } from '../runtime/outbox.ts';
import type { EngineDeps } from './deps.ts';

/**
 * Corroboration confidence, and its history — E4 Trust, Phases 81 and 82.
 *
 * The decision is `src/domain/confidence.ts`'s and the argument for its shape is there. This
 * module's job is to gather the facts honestly, and there are exactly two ways it could
 * cheat:
 *
 * **By counting rows instead of people.** Every count here goes through a `Set` of actor
 * ids taken from the corroboration rows, never through `counters.corroboratorCount` — the
 * counter is maintained by a consumer and counts rows, and six accounts from one person is
 * one person. The number of people is the trust primitive; a row count wearing its name
 * would be the whole product quietly broken.
 *
 * **By reading a trust score.** It does not, and a discovery guard asserts it: no
 * `trustAssessments` read appears in this file or in the domain module. Confidence reads
 * facts about *claims* — did this one carry evidence, was that evidence contradicted, did
 * the set arrive independently. Never a figure about a claimant.
 */

/** How many corroborations one confidence read will consider. */
export const CONFIDENCE_CLAIM_LIMIT = 2_000;

/**
 * Gather the facts for one experience.
 *
 * The author is excluded from `independentPeople` and counted in `selfContributions`
 * instead — an author corroborating their own experience adds no independent person, and
 * saying so out loud is what makes "one actor cannot manufacture confidence" checkable
 * rather than incidental.
 */
export const confidenceInputFor = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<ConfidenceInput | undefined> => {
  const experience = await deps.store.experiences.get(experienceId);
  if (!experience) return undefined;

  const claims = (
    await deps.store.corroborations.query([
      eq<CorroborationRow>('experienceId', experienceId),
      eq<CorroborationRow>('status', 'active'),
    ])
  ).slice(0, CONFIDENCE_CLAIM_LIMIT);

  const people = new Set<string>();
  let selfContributions = 0;
  let duplicateRows = 0;
  let mostRecent = experience.publishedAt ?? experience.createdAt;

  for (const claim of claims) {
    mostRecent = Math.max(mostRecent, claim.createdAt);
    if (claim.corroboratorId === experience.actorId) {
      selfContributions += 1;
      continue;
    }
    if (people.has(claim.corroboratorId)) {
      duplicateRows += 1;
      continue;
    }
    people.add(claim.corroboratorId);
  }

  // Evidence, and how much of it somebody has assessed as contradicted. The assessment is
  // the checkable fact; the presence of evidence alone is not a claim about its content.
  const evidence = await deps.store.evidence.query([eq<EvidenceRow>('experienceId', experienceId)]);
  let evidenceContradicted = 0;
  for (const item of evidence) {
    const assessment = await deps.store.evidenceAssessments.queryOne([
      eq<EvidenceAssessment>('evidenceId', item.id),
    ]);
    if (assessment?.outcome === 'contradicted') evidenceContradicted += 1;
  }

  // Phase 62's signal, reused rather than reimplemented. A second coordination heuristic
  // would be a second answer to one question, and the two would drift.
  const coordination = analyseCoordination(
    claims.map((claim) => ({
      experienceId: claim.experienceId,
      actorId: claim.corroboratorId,
      createdAt: claim.createdAt,
    })),
  );

  return {
    independentPeople: people.size,
    selfContributions,
    duplicateRows,
    evidencePresent: evidence.length,
    evidenceContradicted,
    coordinationSuspected: coordination.length > 0,
    mostRecentContributionAt: mostRecent,
    // A single experience is trivially consistent with itself. Cluster consistency is a
    // cluster's question and is answered in `clusterConfidenceFor`.
    clusterConsistency: 1,
    now: deps.clock.now(),
  };
};

/** Confidence for one experience, or `undefined` when there is no such experience. */
export const confidenceFor = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<Confidence | undefined> => {
  const input = await confidenceInputFor(deps, experienceId);
  return input === undefined ? undefined : assessConfidence(input);
};

/**
 * Confidence for a whole cluster.
 *
 * Every member is re-checked against its experience row before contributing, for the reason
 * Phase 71 established: a projection or a membership row is a cache, and a member whose
 * experience has been removed must not support a confidence about a live pattern.
 */
export const clusterConfidenceFor = async (
  deps: EngineDeps,
  clusterId: string,
): Promise<Confidence | undefined> => {
  const cluster = await deps.store.clusters.get(clusterId);
  if (!cluster) return undefined;

  const members = await deps.store.clusterMembers.query([
    eq<ClusterMember>('clusterId', clusterId),
  ]);

  const people = new Set<string>();
  let selfContributions = 0;
  let duplicateRows = 0;
  let evidencePresent = 0;
  let evidenceContradicted = 0;
  let mostRecent = cluster.createdAt;
  let live = 0;
  const arrivals: { experienceId: string; actorId: string; createdAt: number }[] = [];

  for (const member of members) {
    const experience = await deps.store.experiences.get(member.experienceId);
    if (!isDiscoverable(experience)) continue;
    live += 1;

    // The author of each member is an independent person: they said it happened to them by
    // publishing it.
    people.add(experience.actorId);
    mostRecent = Math.max(mostRecent, experience.publishedAt ?? experience.createdAt);

    const input = await confidenceInputFor(deps, experience.id);
    if (input !== undefined) {
      selfContributions += input.selfContributions;
      duplicateRows += input.duplicateRows;
      evidencePresent += input.evidencePresent;
      evidenceContradicted += input.evidenceContradicted;
      mostRecent = Math.max(mostRecent, input.mostRecentContributionAt);
    }

    for (const claim of await deps.store.corroborations.query([
      eq<CorroborationRow>('experienceId', experience.id),
      eq<CorroborationRow>('status', 'active'),
    ])) {
      if (claim.corroboratorId === experience.actorId) continue;
      if (people.has(claim.corroboratorId)) duplicateRows += 1;
      else people.add(claim.corroboratorId);
      arrivals.push({
        experienceId: claim.experienceId,
        actorId: claim.corroboratorId,
        createdAt: claim.createdAt,
      });
    }
  }

  return assessConfidence({
    independentPeople: people.size,
    selfContributions,
    duplicateRows,
    evidencePresent,
    evidenceContradicted,
    coordinationSuspected: analyseCoordination(arrivals).length > 0,
    mostRecentContributionAt: mostRecent,
    // The share of the cluster's members still live. A cluster half of whose members have
    // been removed is less consistent evidence of a pattern than one intact.
    clusterConsistency: members.length === 0 ? 0 : Number((live / members.length).toFixed(3)),
    now: deps.clock.now(),
  });
};

/**
 * Record a confidence point for a subject.
 *
 * Idempotent by key: the id is `<subject>:<boundary>`, and the same boundary re-derived
 * produces the identical row. `compareAndSet` on absence rather than `put`, so a replay
 * cannot rewrite a point that already exists — which is the property that makes the whole
 * series replay-safe, because nothing here increments anything.
 */
export const recordConfidencePoint = async (
  deps: EngineDeps,
  subject: { readonly id: string; readonly kind: 'experience' | 'cluster' },
  confidence: Confidence,
  at: number,
): Promise<boolean> => {
  const row: ConfidencePointRow = {
    id: `${subject.id}:${at}`,
    subjectId: subject.id,
    subjectKind: subject.kind,
    at,
    band: confidence.band,
    independentPeople: confidence.independentPeople,
    deciding: explainConfidence(confidence),
    computedAt: deps.clock.now(),
  };
  const written = await deps.store.confidencePoints.compareAndSet(row, 'absent');
  if (written) deps.metrics.increment('confidence.recorded', { band: confidence.band });
  return written;
};

/** The recorded series for a subject, oldest first. */
export const confidenceHistoryFor = async (
  deps: EngineDeps,
  subjectId: string,
): Promise<readonly ConfidencePointRow[]> =>
  [...(await deps.store.confidencePoints.query([eq<ConfidencePointRow>('subjectId', subjectId)]))].sort(
    (left, right) => left.at - right.at,
  );

/**
 * Derive a series over boundaries without writing anything.
 *
 * Exported for the surface that wants to show movement without a sweep having run, and for
 * the test that asserts determinism: the same boundaries in any order give the same series,
 * because each point is computed from the whole set as of its own boundary.
 */
export const deriveConfidenceSeries = async (
  deps: EngineDeps,
  experienceId: string,
  boundaries: readonly number[],
): Promise<readonly ConfidencePoint[]> => {
  const base = await confidenceInputFor(deps, experienceId);
  if (base === undefined) return [];
  return confidenceSeries(boundaries, (boundary) => ({ ...base, now: boundary }));
};

/**
 * Confidence has no command, and this is where that is stated.
 *
 * A `confidence.set` would be a way for one person to declare how much a set of other
 * people's accounts is worth. There is no legitimate caller: confidence is derived from
 * claims and evidence, and an operator who disagrees with it has the coordination queue and
 * the evidence assessment — both of which change *facts*, which is the right level.
 */
export const confidenceAcceptsACommand = (): false => false;

/**
 * How wide one point in the series is.
 *
 * A day, not an event. Recording a point per event would make the series a log of
 * corroborations — which `experience_corroborations` already is, with more detail — and its
 * length would then be a proxy for activity, so a busy pattern would look like a moving one.
 * A daily boundary answers the question the series is for: on what day did confidence change,
 * and to what.
 *
 * It also makes replay free rather than merely safe. Every delivery inside the same day
 * derives the identical id, so the second one is absorbed by `compareAndSet` on absence with
 * no comparison of contents — which is the property that lets an at-least-once pipeline write
 * history without a deduplication table.
 */
export const CONFIDENCE_BOUNDARY_MS = 24 * 60 * 60 * 1000;

/** The start of the day an instant falls in. */
export const confidenceBoundaryFor = (at: number): number =>
  Math.floor(at / CONFIDENCE_BOUNDARY_MS) * CONFIDENCE_BOUNDARY_MS;

/**
 * Record the day's confidence when something that changes it happens.
 *
 * The four events are the whole set of things that can move confidence: a claim arriving
 * either way, a claim being withdrawn, and evidence being assessed. Notably **not**
 * `ExperienceShared` — the corroboration consumer listens for it to maintain a share count,
 * and a share is not a claim, so it changes nothing here. Subscribing to it anyway would have
 * been the quiet way to make amplification move a trust figure.
 *
 * A point is recorded for the experience and, when it belongs to one, for its cluster: the
 * two answer different questions, and a cluster's confidence can fall while a member's holds.
 */
export const createConfidencePointConsumer = (deps: EngineDeps): Consumer => ({
  name: 'confidence.record',
  events: ['ExperienceReRaged', 'ExperienceReRaved', 'CorroborationRetracted', 'EvidenceAssessed'],
  handle: async (event) => {
    const experienceId = await experienceIdFrom(deps, event);
    if (!experienceId) return ok(undefined);

    const at = confidenceBoundaryFor(deps.clock.now());
    const confidence = await confidenceFor(deps, experienceId);
    if (confidence !== undefined) {
      await recordConfidencePoint(deps, { id: experienceId, kind: 'experience' }, confidence, at);
    }

    const membership = await deps.store.clusterMembers.queryOne([
      eq<ClusterMember>('experienceId', experienceId),
    ]);
    if (membership) {
      const clusterConfidence = await clusterConfidenceFor(deps, membership.clusterId);
      if (clusterConfidence !== undefined) {
        await recordConfidencePoint(
          deps,
          { id: membership.clusterId, kind: 'cluster' },
          clusterConfidence,
          at,
        );
      }
    }
    return ok(undefined);
  },
});

/**
 * The experience an event is about.
 *
 * `EvidenceAssessed` carries the evidence rather than the experience, so it is resolved
 * through the row. Evidence may also hang off a corroboration rather than an experience, in
 * which case there is nothing to record and the consumer says so by returning undefined —
 * rather than guessing, which here would mean attributing an assessment to the wrong account.
 */
const experienceIdFrom = async (
  deps: EngineDeps,
  event: DomainEventEnvelope,
): Promise<string | undefined> => {
  const direct = String(event.payload['experienceId'] ?? '');
  if (direct) return direct;
  const evidenceId = String(event.payload['evidenceId'] ?? '');
  if (!evidenceId) return undefined;
  const evidence = await deps.store.evidence.get(evidenceId);
  return evidence?.experienceId;
};
