import { ok } from '../runtime/result.ts';
import { ageOf, daysOf } from '../domain/aging.ts';
import { assertedValues } from '../domain/enrichment.ts';
import { estimateImpact, type Impact } from '../domain/impact.ts';
import { isContested } from '../domain/dispute.ts';
import { prioritise, rank, type Priority } from '../domain/priority.ts';
import { urgencyOf, type Urgency } from '../domain/urgency.ts';
import { eq, isNull } from '../ports/store.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { ResolutionStatus } from '../domain/resolution.ts';
import type { SeverityBand } from '../domain/severity.ts';
import type {
  ClusterMember,
  CorroborationRow,
  DisputeRow,
  EscalationRow,
  OrganizationResponse,
  PriorityRow,
  ResolutionEventRow,
  ResolutionReportRow,
} from '../ports/store.ts';
import type { Experience } from '../domain/experience.ts';
import type { EngineDeps } from './deps.ts';
import { enrichmentKey } from './enrichment.engine.ts';
import { severityKey } from './severity.engine.ts';

/**
 * Urgency, impact and priority — Phases 41–43, E8.
 *
 * One engine for three phases because they are one read: priority is a function of
 * urgency and impact, and computing them apart would mean three passes over the same
 * rows and three chances for them to disagree about what the rows said.
 *
 * Everything here is **derived**, and the stored row is a cache of a derivation rather
 * than a source of truth — which is why there is no command to set any of it. A
 * `priority.set` would be a way to move somebody's complaint up or down the queue by
 * hand, and the whole point of Phase 43 being explainable is that its position is
 * answerable from the rows instead.
 *
 * Impact is estimated at **cluster** level, not per experience. A single account has one
 * experiencer, and "impact" over one person is not an estimate — it is that person's own
 * assertion, which Phase 31 already records without extrapolating from it.
 */
export const priorityKey = (experienceId: string): string => `pri:${experienceId}`;

const agingFor = async (deps: EngineDeps, experience: Experience) => {
  const events = await deps.store.resolutionEvents.query([
    eq<ResolutionEventRow>('experienceId', experience.id),
  ]);
  const responses = await deps.store.organizationResponses.query([
    eq<OrganizationResponse>('experienceId', experience.id),
  ]);
  const latest = (rows: readonly { createdAt: number }[]): number | undefined =>
    rows.reduce<number | undefined>(
      (best, row) => (best === undefined || row.createdAt > best ? row.createdAt : best),
      undefined,
    );
  const status = (experience.resolutionStatus ?? 'open') as ResolutionStatus;
  const settled = status === 'resolved' || status === 'partially_resolved';
  const proposed = latest(
    responses.filter((row) => row.kind === 'publish_resolution' || row.kind === 'remediation_instructions'),
  );

  return {
    status,
    aging: ageOf({
      events,
      currentStatus: status,
      publishedAt: experience.publishedAt ?? experience.createdAt,
      ...(latest(responses) === undefined ? {} : { lastOrganizationContactAt: latest(responses) as number }),
      ...(proposed === undefined || settled ? {} : { proposedResolutionAt: proposed }),
      now: deps.clock.now(),
    }),
  };
};

/**
 * Impact for the pattern an experience belongs to.
 *
 * Reads asserted dimensions from every member, and nothing else. There is deliberately
 * no path here to a counter, a share count or a reaction — engagement is not impact, and
 * the absence of the parameter is what enforces that rather than a comment asking
 * nicely.
 */
export const impactForCluster = async (deps: EngineDeps, clusterId: string): Promise<Impact> => {
  const members = await deps.store.clusterMembers.query([eq<ClusterMember>('clusterId', clusterId)]);
  const experienceIds = members.map((member) => member.experienceId);

  const moneyAsserted: number[] = [];
  const minutesAsserted: number[] = [];
  let recurrenceYes = 0;
  let recurrenceAnswered = 0;
  const severityBands: SeverityBand[] = [];
  const experiencers = new Set<string>();
  const locations = new Set<string>();
  let resolved = 0;
  let reportTotal = 0;
  let earliest = deps.clock.now();

  for (const experienceId of experienceIds) {
    const experience = await deps.store.experiences.get(experienceId);
    if (!experience || experience.status !== 'published') continue;
    experiencers.add(experience.actorId);
    if (experience.locationId) locations.add(experience.locationId);
    const publishedAt = experience.publishedAt ?? experience.createdAt;
    if (publishedAt < earliest) earliest = publishedAt;

    // People who said it happened to them too are experiencers as well: that is what a
    // corroboration means, and counting only authors would understate the population
    // every estimate below is drawn over.
    for (const claim of await deps.store.corroborations.query([
      eq<CorroborationRow>('experienceId', experienceId),
      eq<CorroborationRow>('status', 'active'),
    ])) {
      experiencers.add(claim.corroboratorId);
    }

    const enrichment = await deps.store.enrichments.get(enrichmentKey(experienceId));
    if (enrichment) {
      for (const value of assertedValues(enrichment)) {
        if (value.dimension === 'money_lost' && value.amount !== undefined) moneyAsserted.push(value.amount);
        if (value.dimension === 'time_lost_minutes' && value.amount !== undefined) minutesAsserted.push(value.amount);
        if (value.dimension === 'recurrence') {
          recurrenceAnswered += 1;
          if (value.flag === true) recurrenceYes += 1;
        }
      }
    }

    const severity = await deps.store.severities.get(severityKey(experienceId));
    if (severity && !severity.unassessed) severityBands.push(severity.band);

    const reports = await deps.store.resolutionReports.query([
      eq<ResolutionReportRow>('experienceId', experienceId),
    ]);
    reportTotal += reports.length;
    resolved += reports.filter((report) => report.kind === 'resolved_for_me').length;
  }

  return estimateImpact({
    distinctExperiencers: experiencers.size,
    experiences: experienceIds.length,
    moneyAsserted,
    minutesAsserted,
    recurrenceAsserted: { yes: recurrenceYes, answered: recurrenceAnswered },
    severityBands,
    runningForDays: daysOf(deps.clock.now() - earliest),
    locations: locations.size,
    resolutionReports: { resolved, total: reportTotal },
  });
};

export interface PriorityView {
  readonly priority: Priority;
  readonly urgency: Urgency;
  readonly impact: Impact;
}

/** Derive urgency, impact and priority for one experience. Pure read, then cached. */
export const priorityFor = async (deps: EngineDeps, experienceId: string): Promise<PriorityView | undefined> => {
  const experience = await deps.store.experiences.get(experienceId);
  if (!experience || experience.status !== 'published') return undefined;

  const severity = await deps.store.severities.get(severityKey(experienceId));
  const enrichment = await deps.store.enrichments.get(enrichmentKey(experienceId));
  const safetyAsserted =
    enrichment !== undefined &&
    assertedValues(enrichment).some((value) => value.dimension === 'safety_involved' && value.flag === true);

  const { status, aging } = await agingFor(deps, experience);
  const openEscalations = await deps.store.escalations.countWhere([
    eq<EscalationRow>('experienceId', experienceId),
    isNull<EscalationRow>('resolvedAt'),
  ]);
  const disputes = await deps.store.disputes.query([eq<DisputeRow>('experienceId', experienceId)]);

  const urgency = urgencyOf({
    ...(severity === undefined || severity.unassessed ? {} : { band: severity.band }),
    severityUnassessed: severity?.unassessed ?? true,
    safetyAsserted,
    aging,
    openEscalations,
    contested: isContested(disputes),
    acknowledged: status !== 'open' && status !== 'gaining_signal',
    beingWorked: status === 'under_review' || status === 'acknowledged',
  });

  const impact: Impact =
    experience.clusterId === undefined
      ? {
          outcome: 'INSUFFICIENT_DATA',
          peopleAffected: 0,
          floor: 5,
          shortBy: 5,
          explanation: 'This account is not yet part of a pattern, so there is nothing to estimate across.',
        }
      : await impactForCluster(deps, experience.clusterId);

  const priority = prioritise({
    subjectId: experienceId,
    ...(severity === undefined || severity.unassessed ? {} : { band: severity.band }),
    severityUnassessed: severity?.unassessed ?? true,
    urgency: urgency.level,
    urgencyUnassessed: urgency.unassessed,
    impact,
    unresolvedDays: aging.unresolved ? daysOf(aging.inCurrentStatusMs) : 0,
  });

  return { priority, urgency, impact };
};

const persist = async (deps: EngineDeps, experienceId: string): Promise<PriorityRow | undefined> => {
  const view = await priorityFor(deps, experienceId);
  if (!view) return undefined;
  const row: PriorityRow = {
    id: priorityKey(experienceId),
    experienceId,
    band: view.priority.band,
    reason: view.priority.reason,
    dominant: [...view.priority.dominant],
    urgency: view.urgency.level,
    urgencyFactors: view.urgency.factors.map((factor) => factor.because),
    ...(view.priority.severity === undefined ? {} : { severity: view.priority.severity }),
    ...(view.priority.peopleAffected === undefined ? {} : { peopleAffected: view.priority.peopleAffected }),
    impactKnown: view.priority.impactKnown,
    ...(view.priority.confidence === undefined ? {} : { confidence: view.priority.confidence }),
    unresolvedDays: view.priority.unresolvedDays,
    unassessed: view.priority.unassessed,
    computedAt: deps.clock.now(),
  };
  await deps.store.priorities.put(row);
  return row;
};

/**
 * Recompute on any event that changes an input.
 *
 * A recompute-from-rows, like the counters and the severity band, so two consumers
 * running in either order cannot disagree and a replay cannot double anything.
 */
export const createPriorityConsumer = (deps: EngineDeps): Consumer => ({
  name: 'priority.recompute',
  events: [
    'ExperienceEnriched',
    'ExperienceReRaged',
    'ExperienceReRaved',
    'CorroborationRetracted',
    'ResolutionReported',
    'ResolutionStatusChanged',
    'DisputeOpened',
    'DisputeWithdrawn',
    'OrganizationResponded',
  ],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    if (!experienceId) return ok(undefined);
    const row = await persist(deps, experienceId);
    if (row) deps.metrics.increment('priority.recomputed', { band: row.band });
    return ok(undefined);
  },
});

export const recomputePriority = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<PriorityRow | undefined> => persist(deps, experienceId);

/**
 * The queue, ordered and positioned.
 *
 * Position is derived here rather than stored, because a stored position is wrong the
 * moment anything else in the queue changes — and a queue where position nine is stale
 * is worse than one with no positions at all.
 */
export const prioritisedQueue = async (
  deps: EngineDeps,
  limit = 100,
): Promise<readonly (Priority & { position: number })[]> => {
  const rows = await deps.store.priorities.query([eq<PriorityRow>('unassessed', false)], {
    orderBy: { field: 'computedAt', direction: 'desc' },
    limit,
  });
  const priorities: Priority[] = rows.map((row) => ({
    subjectId: row.experienceId,
    band: row.band,
    reason: row.reason,
    dominant: row.dominant as Priority['dominant'],
    ...(row.severity === undefined ? {} : { severity: row.severity }),
    urgency: row.urgency,
    ...(row.peopleAffected === undefined ? {} : { peopleAffected: row.peopleAffected }),
    impactKnown: row.impactKnown,
    ...(row.confidence === undefined ? {} : { confidence: row.confidence }),
    unresolvedDays: row.unresolvedDays,
    unassessed: row.unassessed,
  }));
  return rank(priorities);
};
