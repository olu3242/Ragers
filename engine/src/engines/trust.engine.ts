import { ok } from '../runtime/result.ts';
import { assessTrust, detectCoordinatedBurst, type RiskKind, type TrustInputs } from '../domain/trust.ts';
import { eq } from '../ports/store.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { CorroborationRow, EvidenceRow, RiskEvent, TrustAssessmentRow } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * Trust and Abuse Engine — internal.
 *
 * Nothing in this file is public. Assessments are readable by moderators
 * (`trust.read_internal`), and no read path exposes a score to a viewer. A
 * detection raises a flag and an event; it never removes content, never edits a
 * claim, and never changes a corroboration count. Deciding what a flag means is a
 * human's job, which is the whole reason the flag is separate from the action.
 */

export const recomputeTrust = async (deps: EngineDeps, actorId: string): Promise<TrustAssessmentRow | undefined> => {
  const actor = await deps.store.actors.get(actorId);
  if (!actor) return undefined;

  const experiences = await deps.store.experiences.query([eq('actorId', actorId)]);
  const claims = await deps.store.corroborations.query([eq<CorroborationRow>('corroboratorId', actorId)]);
  const reports = await deps.store.reports.query([eq('reporterActorId', actorId)]);
  const actions = await deps.store.moderationActions.all();

  // A report has no upheld/dismissed column, so its outcome is read from what
  // moderation actually did to the target: an action that removed something means
  // the report was right, and a closed report with no such action means it was
  // not. A still-open report counts as neither — pending is not a verdict.
  const removedTargets = new Set(
    actions.filter((action) => action.action === 'remove').map((action) => action.targetId),
  );
  const upheldReports = reports.filter((report) => removedTargets.has(report.targetId)).length;
  const dismissedReports = reports.filter(
    (report) => report.status === 'closed' && !removedTargets.has(report.targetId),
  ).length;

  const evidence = await deps.store.evidence.query([eq<EvidenceRow>('submittedBy', actorId)]);
  let evidenceContradicted = 0;
  for (const row of evidence) {
    const assessments = await deps.store.evidenceAssessments.query([eq('evidenceId', row.id)]);
    if (assessments.some((assessment) => assessment.outcome === 'contradicted')) evidenceContradicted += 1;
  }

  const existing = await deps.store.trustAssessments.get(actorId);
  const inputs: TrustInputs = {
    accountAgeMs: Math.max(0, deps.clock.now() - actor.createdAt),
    publishedExperiences: experiences.filter((row) => row.status === 'published').length,
    activeCorroborations: claims.filter((row) => row.status === 'active').length,
    retractedCorroborations: claims.filter((row) => row.status === 'retracted').length,
    upheldReports,
    dismissedReports,
    // Removals of this actor's own content, which is a fact about them; removals
    // of content they reported are not.
    moderationRemovals: actions.filter(
      (action) =>
        action.action === 'remove' && experiences.some((experience) => experience.id === action.targetId),
    ).length,
    evidenceAttached: evidence.length,
    evidenceContradicted,
    // Flags are raised by detection and cleared only by a moderator, so they are
    // carried forward rather than recomputed away.
    riskFlags: (existing?.riskFlags ?? []) as readonly RiskKind[],
  };

  const assessment = assessTrust(inputs);
  const row: TrustAssessmentRow = {
    id: actorId,
    actorId,
    accountConfidence: assessment.accountConfidence,
    contributionConfidence: assessment.contributionConfidence,
    evidenceConfidence: assessment.evidenceConfidence,
    riskFlags: assessment.riskFlags,
    updatedAt: deps.clock.now(),
  };
  await deps.store.trustAssessments.put(row);
  deps.metrics.increment('trust.recomputed');
  return row;
};

/** Trust follows durable facts, so it recomputes when those facts change. */
export const createTrustRecomputeConsumer = (deps: EngineDeps): Consumer => ({
  name: 'trust.recompute',
  events: [
    'ExperiencePublished',
    'ExperienceReRaged',
    'ExperienceReRaved',
    'CorroborationRetracted',
    'ContentRemoved',
    'ReportResolved',
    'EvidenceAssessed',
  ],
  handle: async (event) => {
    const actorIds = new Set<string>();
    for (const key of ['actorId', 'authorActorId', 'corroboratorActorId', 'reporterId']) {
      const value = event.payload[key];
      if (typeof value === 'string' && value.length > 0) actorIds.add(value);
    }
    // Fall back to the experience's author when the event names no actor.
    const experienceId = String(event.payload['experienceId'] ?? '');
    if (actorIds.size === 0 && experienceId) {
      const experience = await deps.store.experiences.get(experienceId);
      if (experience) actorIds.add(experience.actorId);
    }
    for (const actorId of actorIds) await recomputeTrust(deps, actorId);
    return ok(undefined);
  },
});

/**
 * Abuse detection on an experience's corroborations.
 *
 * Raises a risk event and flags the *experience's* cluster for review. It
 * deliberately does not flag the corroborators: arriving in a burst is not
 * evidence that any individual claim is false, and treating it that way would
 * punish people for a pattern they did not know they were part of.
 */
export const createAbuseDetectionConsumer = (deps: EngineDeps): Consumer => ({
  name: 'trust.detect_abuse',
  events: ['ExperienceReRaged', 'ExperienceReRaved'],
  handle: async (event, ctx) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    if (!experienceId) return ok(undefined);

    const claims = await deps.store.corroborations.query([
      eq<CorroborationRow>('experienceId', experienceId),
      eq<CorroborationRow>('status', 'active'),
    ]);
    const burst = detectCoordinatedBurst(claims);
    if (!burst.detected) return ok(undefined);

    // Keyed on the experience and window so repeated delivery records one
    // finding, not one per corroboration.
    const riskEvent: RiskEvent = {
      id: `risk_${experienceId}_${burst.windowStart ?? 0}`,
      kind: 'coordinated_corroboration',
      severity: burst.count >= 10 ? 'high' : 'medium',
      // A summary. Never the content, never the list of accounts.
      detail: { experienceId, distinctCorroborators: burst.count, windowStart: burst.windowStart ?? 0 },
      ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
      createdAt: deps.clock.now(),
    };
    await deps.store.riskEvents.put(riskEvent);
    deps.metrics.increment('trust.risk_detected', { kind: riskEvent.kind });

    await deps.outbox.append(
      [
        {
          aggregateType: 'experience',
          aggregateId: experienceId,
          eventName: 'RiskDetected',
          payload: { experienceId, kind: riskEvent.kind, severity: riskEvent.severity },
          ...(event.id === undefined ? {} : { causationId: event.id }),
        },
      ],
      event.correlationId,
    );
    return ok(undefined);
  },
});

/** Internal read. There is no public counterpart, by design. */
export const internalTrustFor = async (
  deps: EngineDeps,
  actorId: string,
): Promise<TrustAssessmentRow | undefined> => deps.store.trustAssessments.get(actorId);

export const riskEventsFor = async (
  deps: EngineDeps,
  actorId: string,
): Promise<readonly RiskEvent[]> => deps.store.riskEvents.query([eq<RiskEvent>('actorId', actorId)]);
