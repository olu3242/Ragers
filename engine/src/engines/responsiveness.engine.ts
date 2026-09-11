import { ok } from '../runtime/result.ts';
import { median } from '../domain/signal.ts';
import { floorFor, measure, withheldCaption } from '../domain/sampling.ts';
import { eq } from '../ports/store.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { Experience } from '../domain/experience.ts';
import type {
  OrganizationResponse,
  ResponsivenessSnapshot,
} from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { resolutionSummaryFor } from './resolution.engine.ts';

/**
 * Responsiveness — E11, organization side.
 *
 * Deliberately *not* called an SLA. No service-level agreement exists, and naming
 * a platform measurement after a contractual commitment would assert one nobody
 * made. There is no overdue indicator either, for the same reason: overdue against
 * what?
 *
 * Every median travels with `sampleSize`, and a caller that ignores it can be
 * caught by `describeResponsiveness`, which refuses to characterise a record below
 * the floor. Two answered cases is not a track record.
 */
/**
 * The floor, from the one governed policy rather than a constant of its own.
 *
 * Kept as a named re-export because callers and tests already reference it, and
 * because the alternative — this engine holding its own 5 while Phase 39's aggregates
 * hold a different one — is exactly how two surfaces come to disagree about whether
 * the same number is safe to show.
 */
export const MINIMUM_SAMPLE = floorFor('responsiveness');

const roundRate = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));

export const recomputeResponsiveness = async (
  deps: EngineDeps,
  organizationId: string,
): Promise<ResponsivenessSnapshot | undefined> => {
  const profile = await deps.store.organizationProfiles.get(organizationId);
  if (!profile) return undefined;

  const experiences = await deps.store.experiences.query([
    eq<Experience>('entityId', profile.entityId),
    eq<Experience>('status', 'published'),
  ]);

  const acknowledgements: number[] = [];
  const firstResponses: number[] = [];
  const resolutions: number[] = [];
  let answered = 0;
  let confirmedResolved = 0;
  let open = 0;
  let oldestOpenMs: number | undefined;
  const now = deps.clock.now();

  for (const experience of experiences) {
    const publishedAt = experience.publishedAt ?? experience.createdAt;
    const responses = await deps.store.organizationResponses.query(
      [eq<OrganizationResponse>('experienceId', experience.id)],
      { orderBy: { field: 'createdAt', direction: 'asc' } },
    );

    if (responses.length > 0) {
      answered += 1;
      const first = responses[0];
      if (first) firstResponses.push(Math.max(0, first.createdAt - publishedAt));
      // Acknowledgement is measured only where one was actually given; treating any
      // response as an acknowledgement would flatter the number.
      const acknowledgement = responses.find(
        (response) => response.kind === 'acknowledge' || response.kind === 'known_incident',
      );
      if (acknowledgement) acknowledgements.push(Math.max(0, acknowledgement.createdAt - publishedAt));
    }

    const summary = await resolutionSummaryFor(deps, experience.id);
    if (summary?.status === 'resolved') {
      confirmedResolved += 1;
      const resolvedEvent = await deps.store.resolutionEvents.queryOne([
        eq('experienceId', experience.id),
        eq('toStatus', 'resolved'),
      ]);
      if (resolvedEvent) resolutions.push(Math.max(0, resolvedEvent.createdAt - publishedAt));
    } else {
      open += 1;
      const age = Math.max(0, now - publishedAt);
      if (oldestOpenMs === undefined || age > oldestOpenMs) oldestOpenMs = age;
    }
  }

  const medianAcknowledgement = median(acknowledgements);
  const medianFirstResponse = median(firstResponses);
  const medianResolution = median(resolutions);

  const snapshot: ResponsivenessSnapshot = {
    id: organizationId,
    organizationId,
    casesTotal: experiences.length,
    casesAnswered: answered,
    casesConfirmedResolved: confirmedResolved,
    casesOpen: open,
    ...(medianAcknowledgement === undefined ? {} : { medianAcknowledgementMs: medianAcknowledgement }),
    ...(medianFirstResponse === undefined ? {} : { medianFirstResponseMs: medianFirstResponse }),
    ...(medianResolution === undefined ? {} : { medianResolutionMs: medianResolution }),
    ...(oldestOpenMs === undefined ? {} : { oldestOpenMs }),
    responseRate: roundRate(answered, experiences.length),
    // Confirmed by the people it happened to. Answering does not move it.
    resolutionRate: roundRate(confirmedResolved, experiences.length),
    sampleSize: experiences.length,
    computedAt: now,
  };
  await deps.store.responsiveness.put(snapshot);
  deps.metrics.increment('responsiveness.recomputed');
  return snapshot;
};

/** Recomputed on anything that changes what it measures. */
export const createResponsivenessConsumer = (deps: EngineDeps): Consumer => ({
  name: 'responsiveness.recompute',
  events: [
    'OrganizationResponded',
    'ResolutionReported',
    'ResolutionStatusChanged',
    'ExperienceNormalizationConfirmed',
    'ExperienceDeleted',
    'ContentRemoved',
  ],
  handle: async (event) => {
    // Which organization: named on the event, or resolved from the experience's
    // entity when it is not.
    let organizationId = String(event.payload['organizationId'] ?? '');
    if (!organizationId) {
      const experienceId = String(event.payload['experienceId'] ?? '');
      if (!experienceId) return ok(undefined);
      const experience = await deps.store.experiences.get(experienceId);
      if (!experience?.entityId) return ok(undefined);
      const profile = await deps.store.organizationProfiles.queryOne([
        eq('entityId', experience.entityId),
      ]);
      if (!profile) return ok(undefined);
      organizationId = profile.id;
    }

    const before = await deps.store.responsiveness.get(organizationId);
    const after = await recomputeResponsiveness(deps, organizationId);
    if (!after) return ok(undefined);

    // Only emit when something a viewer would see actually moved, so the event is
    // a signal rather than a heartbeat.
    const changed =
      before === undefined ||
      before.casesAnswered !== after.casesAnswered ||
      before.casesConfirmedResolved !== after.casesConfirmedResolved ||
      before.casesTotal !== after.casesTotal;
    if (changed) {
      await deps.outbox.append(
        [
          {
            aggregateType: 'organization',
            aggregateId: organizationId,
            eventName: 'ResponsivenessUpdated',
            payload: {
              organizationId,
              casesTotal: after.casesTotal,
              casesAnswered: after.casesAnswered,
              casesConfirmedResolved: after.casesConfirmedResolved,
            },
            ...(event.id === undefined ? {} : { causationId: event.id }),
          },
        ],
        event.correlationId,
      );
    }
    return ok(undefined);
  },
});

/**
 * The viewer-safe read.
 *
 * Below the sample floor it says so explicitly rather than showing a median from
 * two cases. "Not enough yet" is an honest answer; a precise-looking number from a
 * tiny sample is not.
 */
export interface PublicResponsiveness {
  readonly organizationId: string;
  readonly displayName: string;
  readonly casesTotal: number;
  readonly casesAnswered: number;
  readonly casesConfirmedResolved: number;
  readonly casesOpen: number;
  readonly responseRate: number;
  readonly resolutionRate: number;
  /** Present only when the sample supports it. */
  readonly medianAcknowledgementMs?: number;
  readonly medianFirstResponseMs?: number;
  readonly medianResolutionMs?: number;
  readonly oldestOpenMs?: number;
  readonly sampleSize: number;
  /** True when there is too little to characterise. */
  readonly insufficientSample: boolean;
  readonly caption: string;
}

export const publicResponsivenessFor = async (
  deps: EngineDeps,
  organizationId: string,
): Promise<PublicResponsiveness | undefined> => {
  const profile = await deps.store.organizationProfiles.get(organizationId);
  if (!profile) return undefined;
  const snapshot =
    (await deps.store.responsiveness.get(organizationId)) ??
    (await recomputeResponsiveness(deps, organizationId));
  if (!snapshot) return undefined;

  // Through the shared policy, so "withheld" means the same thing here as everywhere.
  const timings = measure('responsiveness', snapshot.sampleSize, () => ({
    ...(snapshot.medianAcknowledgementMs === undefined
      ? {}
      : { medianAcknowledgementMs: snapshot.medianAcknowledgementMs }),
    ...(snapshot.medianFirstResponseMs === undefined
      ? {}
      : { medianFirstResponseMs: snapshot.medianFirstResponseMs }),
    ...(snapshot.medianResolutionMs === undefined ? {} : { medianResolutionMs: snapshot.medianResolutionMs }),
  }));
  const insufficient = timings.withheld;
  return {
    organizationId,
    displayName: profile.displayName,
    casesTotal: snapshot.casesTotal,
    casesAnswered: snapshot.casesAnswered,
    casesConfirmedResolved: snapshot.casesConfirmedResolved,
    casesOpen: snapshot.casesOpen,
    responseRate: snapshot.responseRate,
    resolutionRate: snapshot.resolutionRate,
    // Timings are withheld below the floor, not rounded or hedged. Spread from the
    // measure's own branch, so a withheld measure has no `value` to leak.
    ...(timings.withheld ? {} : timings.value),
    ...(snapshot.oldestOpenMs === undefined ? {} : { oldestOpenMs: snapshot.oldestOpenMs }),
    sampleSize: snapshot.sampleSize,
    insufficientSample: insufficient,
    caption: timings.withheld
      ? withheldCaption(timings)
      : '“Confirmed resolved” counts only what the people it happened to said. Answering does not move it.',
  };
};
