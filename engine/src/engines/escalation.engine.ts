import { ok } from '../runtime/result.ts';
import { ageOf } from '../domain/aging.ts';
import { escalationsFor } from '../domain/escalation.ts';
import { isContested } from '../domain/dispute.ts';
import { eq, isNull } from '../ports/store.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type {
  CorroborationRow,
  DisputeRow,
  EscalationRow,
  OrganizationResponse,
  ResolutionEventRow,
} from '../ports/store.ts';
import type { ResolutionStatus } from '../domain/resolution.ts';
import type { EngineDeps } from './deps.ts';
import { enqueueForReview } from './safety.engine.ts';
import { classifyNow, severityKey } from './severity.engine.ts';

/**
 * Escalation — Phase 34, E10.
 *
 * Escalation opens a review and does nothing else. This file writes to exactly two
 * tables — `experience_escalations` and the shared moderation queue — and to no
 * others. In particular it never touches `experiences`: it cannot change a resolution
 * status, cannot hide anything, and applies no sanction. If a future edit needs it to,
 * that is a different command with a different name and its own authorization.
 *
 * It reuses the safety engine's queue rather than growing a second one. Two queues
 * would mean two definitions of "claimed", and an operator working one while items
 * pile up in the other.
 */
export interface EscalationSweepResult {
  readonly considered: number;
  readonly opened: number;
}

const agingFor = async (
  deps: EngineDeps,
  experienceId: string,
  publishedAt: number,
  status: ResolutionStatus,
) => {
  const events = await deps.store.resolutionEvents.query([
    eq<ResolutionEventRow>('experienceId', experienceId),
  ]);
  const responses = await deps.store.organizationResponses.query([
    eq<OrganizationResponse>('experienceId', experienceId),
  ]);
  const lastContact = responses.reduce<number | undefined>(
    (latest, row) => (latest === undefined || row.createdAt > latest ? row.createdAt : latest),
    undefined,
  );
  // A proposed fix is an organization response of that kind with nothing since from
  // the people it happened to. Read from the response log rather than a flag, so it
  // cannot drift out of agreement with what was actually said.
  const proposed = responses
    .filter((row) => row.kind === 'publish_resolution')
    .reduce<number | undefined>(
      (latest, row) => (latest === undefined || row.createdAt > latest ? row.createdAt : latest),
      undefined,
    );
  const settled = status === 'resolved' || status === 'partially_resolved';

  return ageOf({
    events,
    currentStatus: status,
    publishedAt,
    ...(lastContact === undefined ? {} : { lastOrganizationContactAt: lastContact }),
    ...(proposed === undefined || settled ? {} : { proposedResolutionAt: proposed }),
    now: deps.clock.now(),
  });
};

/**
 * Evaluate one experience and open any escalation whose rule now fires.
 *
 * Idempotent by the escalation key, which is `experienceId:ruleId`. A sweep that runs
 * every hour therefore opens each escalation once, instead of burying the queue in
 * duplicates of one case.
 */
export const evaluateEscalations = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<readonly EscalationRow[]> => {
  const experience = await deps.store.experiences.get(experienceId);
  if (!experience || experience.status !== 'published' || experience.publishedAt === undefined) return [];

  const severity = await deps.store.severities.get(severityKey(experienceId));
  const status = (experience.resolutionStatus ?? 'open') as ResolutionStatus;
  const aging = await agingFor(deps, experienceId, experience.publishedAt, status);
  const independent = await deps.store.corroborations.countWhere([
    eq<CorroborationRow>('experienceId', experienceId),
    eq<CorroborationRow>('status', 'active'),
  ]);
  const disputes = await deps.store.disputes.query([eq<DisputeRow>('experienceId', experienceId)]);

  const candidates = escalationsFor({
    experienceId,
    band: severity?.band ?? 'minor',
    // An absent severity row is unassessed, not minor. Treating it as minor would be
    // a finding drawn from the absence of information.
    unassessedSeverity: severity?.unassessed ?? true,
    aging,
    independentExperiencers: independent,
    hasLiveDispute: isContested(disputes),
    acknowledged: status !== 'open' && status !== 'gaining_signal',
  });

  const opened: EscalationRow[] = [];
  for (const candidate of candidates) {
    const existing = await deps.store.escalations.get(candidate.escalationKey);
    if (existing) continue;
    const queueItemId = await enqueueForReview(deps, 'experience', experienceId, 60);
    const row: EscalationRow = {
      id: candidate.escalationKey,
      experienceId,
      ruleId: candidate.ruleId,
      because: candidate.because,
      queueItemId,
      createdAt: deps.clock.now(),
    };
    // compareAndSet, not put: a sweep and an event-driven evaluation can race, and the
    // loser must not overwrite the winner's queue item id with its own.
    const won = await deps.store.escalations.compareAndSet(row, 'absent');
    if (!won) continue;
    deps.metrics.increment('escalation.opened', { rule: candidate.ruleId });
    opened.push(row);
  }
  return opened;
};

/**
 * Re-evaluate when an input changes.
 *
 * Deliberately event-driven as well as sweepable: a critical experience should not
 * wait for the next sweep, and a sweep is what catches the rules that fire purely
 * because time passed.
 *
 * It subscribes to the same source events the severity consumer does, and classifies
 * itself before reading a band, rather than subscribing to a `SeverityClassified`
 * event. Two reasons: a consumer cannot emit events, so no such event exists to
 * subscribe to; and two consumers on one source event have no defined order, so
 * reading whatever band happened to be written first would make escalation depend on
 * scheduling. Classification is a recompute from rows, so doing it twice costs a query
 * and cannot disagree with itself.
 */
export const createEscalationConsumer = (deps: EngineDeps): Consumer => ({
  name: 'escalation.evaluate',
  events: [
    'ExperienceEnriched',
    'ExperienceReRaged',
    'ExperienceReRaved',
    'ResolutionStatusChanged',
    'ResolutionReported',
    'DisputeOpened',
    'OrganizationResponded',
  ],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    if (!experienceId) return ok(undefined);
    await classifyNow(deps, experienceId);
    await evaluateEscalations(deps, experienceId);
    return ok(undefined);
  },
});

/**
 * Open escalations, newest first. Internal: moderator-only by policy.
 *
 * Filtered in SQL rather than read-all-then-filter: an unbounded read truncates at
 * the adapter's row limit, and the rows it drops would be the oldest escalations —
 * exactly the ones somebody most needs to see.
 */
export const openEscalations = async (deps: EngineDeps): Promise<readonly EscalationRow[]> =>
  deps.store.escalations.query([isNull<EscalationRow>('resolvedAt')], {
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: 100,
  });

export const escalationsOf = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<readonly EscalationRow[]> =>
  deps.store.escalations.query([eq<EscalationRow>('experienceId', experienceId)]);
