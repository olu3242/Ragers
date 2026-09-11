import { eq } from '../ports/store.ts';
import {
  assessResolutionQuality,
  assessResponseQuality,
  explainQuality,
  responseQualityMeasure,
  type QualityBand,
  type ResolutionQuality,
  type ResponseQuality,
} from '../domain/quality.ts';
import { measure, type Measure } from '../domain/sampling.ts';
import { PROPOSAL_RESPONSE_KINDS } from '../domain/outcome-presentation.ts';
import { isDiscoverable } from './discovery.engine.ts';
import type {
  ClusterMember,
  CorroborationRow,
  DisputeRow,
  EvidenceRow,
  OrganizationCaseRow,
  OrganizationResponse,
  ResolutionEventRow,
  ResolutionReportRow,
} from '../ports/store.ts';
import type { Experience } from '../domain/experience.ts';
import type { EngineDeps } from './deps.ts';

/**
 * Quality reads — E11, Phases 83, 84 and 85.
 *
 * Three questions the existing measures do not answer:
 *
 *   - **Has this contributor's account of things held up?** (reliability, 83)
 *   - **Did the responses do anything?** (response quality, 84 — as distinct from how fast,
 *     which `responsiveness_snapshots` already measures)
 *   - **Was it resolved *well*?** (resolution quality, 85 — as distinct from whether it is
 *     resolved, which `resolutionFromReports` already decides)
 *
 * Everything here composes governed reads and applies the floors that already exist. Nothing
 * computes a new judgement about a person, and nothing ranks.
 */

/** How many cases or reports one read will consider. */
export const QUALITY_SAMPLE_LIMIT = 1_000;

// ── Phase 83: community reliability ──────────────────────────────────────

/**
 * What may be said about a contributor, and it is deliberately little.
 *
 * Bands and counts of *their own* activity, with `INSUFFICIENT_DATA` below the floor. No
 * trust figure, no comparison to anybody else, and no ordering — because the moment
 * contributors can be ordered, the ordering is the product and everything else bends towards
 * it. `reliabilityLeaderboard()` returns undefined for that reason, and Phase 75 refused the
 * same thing for organizations where the harm is smaller.
 */
export interface Reliability {
  readonly actorId: string;
  /** How much they have contributed. Their own activity, not a rank. */
  readonly contributions: number;
  /** Of their corroborations, the share still standing rather than retracted. */
  readonly standingRate: Measure<number>;
  /** Outcomes about their content that were overturned — removals and upheld disputes. */
  readonly overturned: number;
  readonly band: Measure<QualityBand>;
  readonly reasons: readonly string[];
}

/**
 * Reliability for one contributor.
 *
 * **Reads facts about their contributions, never a trust score.** `assessTrust` produces
 * `accountConfidence` and `contributionConfidence` and neither is touched here: those are
 * internal moderation inputs, and surfacing a band derived from them would be publishing the
 * trust score with a coat on.
 *
 * What this reads instead: how many experiences they published, how many of their
 * corroborations still stand, and how many outcomes about their content were overturned. All
 * durable facts about *what happened to their contributions*, which is what "has their
 * account of things held up" actually means.
 */
export const reliabilityFor = async (deps: EngineDeps, actorId: string): Promise<Reliability> => {
  const published = await deps.store.experiences.query([eq<Experience>('actorId', actorId)]);
  const claims = await deps.store.corroborations.query([
    eq<CorroborationRow>('corroboratorId', actorId),
  ]);
  const standing = claims.filter((claim) => claim.status === 'active').length;
  const retracted = claims.filter((claim) => claim.status === 'retracted').length;

  // Overturned: their content removed by moderation, or a dispute against it upheld. Both are
  // decisions somebody made about what they said, which is the honest meaning of "did not
  // hold up".
  const removed = published.filter((row) => row.status === 'removed').length;
  let upheldDisputes = 0;
  for (const experience of published) {
    const disputes = await deps.store.disputes.query([
      eq<DisputeRow>('experienceId', experience.id),
    ]);
    upheldDisputes += disputes.filter((row) => row.status === 'upheld').length;
  }

  const contributions = published.length + claims.length;
  const claimTotal = standing + retracted;
  const reasons: string[] = [];
  if (retracted > 0) reasons.push(`${retracted} corroboration(s) were retracted`);
  if (removed > 0) reasons.push(`${removed} experience(s) were removed by moderation`);
  if (upheldDisputes > 0) reasons.push(`${upheldDisputes} dispute(s) against their accounts were upheld`);
  if (reasons.length === 0) reasons.push('nothing they have contributed has been overturned');

  return {
    actorId,
    contributions,
    standingRate: measure('approval_rate', claimTotal, () =>
      claimTotal === 0 ? 1 : Number((standing / claimTotal).toFixed(3)),
    ),
    overturned: removed + upheldDisputes,
    // Withheld below the floor. `INSUFFICIENT_DATA` and "unreliable" are opposite statements
    // and the second one is defamatory, which is why the floor is not a rounding decision.
    band: measure('approval_rate', contributions, (): QualityBand => {
      const overturned = removed + upheldDisputes;
      if (overturned === 0 && retracted === 0) return 'good';
      if (overturned > 2 || (claimTotal > 0 && retracted / claimTotal > 0.5)) return 'poor';
      return 'mixed';
    }),
    reasons,
  };
};

/** There is no ordering across contributors, and there is no way to ask for one. */
export const reliabilityLeaderboard = (): undefined => undefined;

// ── Phase 84: response quality ───────────────────────────────────────────

/** How long a case may sit open before it counts as aging. */
export const AGING_OPEN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Response quality for an organization.
 *
 * The dimension that separates this from responsiveness is `action_described`: whether a
 * response said something was *done*, as opposed to describing a position. A form letter
 * within the hour is fast and is not an answer, and `assessResponseQuality` refuses to call
 * a zero-action record `good` however good the timing.
 */
export const responseQualityFor = async (
  deps: EngineDeps,
  organizationId: string,
): Promise<ResponseQuality> => {
  const cases = (
    await deps.store.organizationCases.query([
      eq<OrganizationCaseRow>('organizationId', organizationId),
    ])
  ).slice(0, QUALITY_SAMPLE_LIMIT);

  let acknowledged = 0;
  let actionDescribed = 0;
  let outcomesAccepted = 0;
  let outcomesReported = 0;
  let recurrences = 0;
  let agingOpen = 0;
  const now = deps.clock.now();

  for (const row of cases) {
    const responses = await deps.store.organizationResponses.query([
      eq<OrganizationResponse>('experienceId', row.experienceId),
    ]);
    if (responses.length > 0) acknowledged += 1;
    // Which response kinds assert that something was *done* is already decided, by
    // `PROPOSAL_RESPONSE_KINDS` — `publish_resolution` and `remediation_instructions`. Reused
    // rather than restated: a second list would drift from the first the moment a kind is
    // added, and the drift would be invisible because both lists would still look plausible.
    // An acknowledgement, a position, or a dispute is not an action.
    if (responses.some((response) => PROPOSAL_RESPONSE_KINDS.includes(response.kind))) {
      actionDescribed += 1;
    }

    const reports = await deps.store.resolutionReports.query([
      eq<ResolutionReportRow>('experienceId', row.experienceId),
    ]);
    outcomesReported += reports.length;
    outcomesAccepted += reports.filter((report) => report.kind === 'resolved_for_me').length;

    if (row.state !== 'closed' && now - row.openedAt > AGING_OPEN_MS) agingOpen += 1;

    recurrences += await recurrenceCountFor(deps, row.experienceId);
  }

  return assessResponseQuality({
    cases: cases.length,
    acknowledged,
    actionDescribed,
    outcomesAccepted,
    outcomesReported,
    recurrences,
    agingOpen,
  });
};

/**
 * How many accounts of the same thing arrived *after* a resolution was claimed.
 *
 * The single most informative quality signal available, and the one an organization's own
 * reporting cannot contain: it did not work. Counted from the cluster, over experiences that
 * are still live — a recurrence whose account was removed is not evidence of anything.
 */
export const recurrenceCountFor = async (deps: EngineDeps, experienceId: string): Promise<number> => {
  const experience = await deps.store.experiences.get(experienceId);
  if (!experience) return 0;
  const events = await deps.store.resolutionEvents.query([
    eq<ResolutionEventRow>('experienceId', experienceId),
  ]);
  const resolvedAt = events
    .filter((event) => event.toStatus === 'resolved' || event.toStatus === 'partially_resolved')
    .map((event) => event.createdAt)
    .sort((left, right) => left - right)[0];
  if (resolvedAt === undefined) return 0;

  const membership = await deps.store.clusterMembers.queryOne([
    eq<ClusterMember>('experienceId', experienceId),
  ]);
  if (!membership) return 0;
  const siblings = await deps.store.clusterMembers.query([
    eq<ClusterMember>('clusterId', membership.clusterId),
  ]);

  let recurrences = 0;
  for (const sibling of siblings) {
    if (sibling.experienceId === experienceId) continue;
    const other = await deps.store.experiences.get(sibling.experienceId);
    // Live only, and published after the resolution was claimed.
    if (!isDiscoverable(other)) continue;
    if ((other.publishedAt ?? other.createdAt) > resolvedAt) recurrences += 1;
  }
  return recurrences;
};

/** The band as a `Measure`, so a surface cannot show it below the floor. */
export const responseQualityBand = (quality: ResponseQuality): Measure<QualityBand> =>
  responseQualityMeasure(quality);

// ── Phase 85: resolution quality ─────────────────────────────────────────

/**
 * Resolution quality for one experience.
 *
 * `statusResolved` travels through to the output beside the band, so `resolved` and
 * `well resolved` are visibly two facts. A resolution with a dispute against it reads as
 * `resolved: true, band: poor` — the shape a single status field cannot express, which is
 * the whole reason this phase exists.
 */
export const resolutionQualityFor = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<ResolutionQuality | undefined> => {
  const experience = await deps.store.experiences.get(experienceId);
  if (!experience) return undefined;

  const reports = await deps.store.resolutionReports.query([
    eq<ResolutionReportRow>('experienceId', experienceId),
  ]);
  const disputes = await deps.store.disputes.query([eq<DisputeRow>('experienceId', experienceId)]);
  const responses = await deps.store.organizationResponses.query([
    eq<OrganizationResponse>('experienceId', experienceId),
  ]);
  const evidence = await deps.store.evidence.query([eq<EvidenceRow>('experienceId', experienceId)]);

  const events = await deps.store.resolutionEvents.query([
    eq<ResolutionEventRow>('experienceId', experienceId),
  ]);
  const firstResolvedAt = events
    .filter((event) => event.toStatus === 'resolved' || event.toStatus === 'partially_resolved')
    .map((event) => event.createdAt)
    .sort((left, right) => left - right)[0];

  return assessResolutionQuality({
    statusResolved: experience.resolutionStatus === 'resolved',
    reportsResolved: reports.filter((report) => report.kind === 'resolved_for_me').length,
    reportsPartial: reports.filter((report) => report.kind === 'partially_resolved').length,
    reportsUnresolved: reports.filter((report) => report.kind === 'still_unresolved').length,
    openDisputes: disputes.filter((row) => row.status === 'open' || row.status === 'under_review').length,
    upheldDisputes: disputes.filter((row) => row.status === 'upheld').length,
    recurrences: await recurrenceCountFor(deps, experienceId),
    // Follow-up: a response *after* the resolution was claimed. Before it, it is the
    // resolution itself rather than a follow-up.
    followUpResponses:
      firstResolvedAt === undefined
        ? 0
        : responses.filter((response) => response.createdAt > firstResolvedAt).length,
    evidenceAttached: evidence.length,
  });
};

/** Why the band landed where it did, for a surface that shows the reason. */
export const explainResolutionQuality = (quality: ResolutionQuality): string => explainQuality(quality);

/**
 * The absences, as code.
 *
 * `qualityAcceptsACommand` — quality is derived from what happened, and a command to set it
 * would be a way for one party to declare how well they handled something. The organization
 * already has `organization.respond`, which asserts a *claim* that is then measured; that is
 * the right level.
 */
export const qualityAcceptsACommand = (): false => false;
