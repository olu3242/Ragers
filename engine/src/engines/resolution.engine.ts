import { err, ok } from '../runtime/result.ts';
import { notFoundError, preconditionError, validationError } from '../runtime/errors.ts';
import {
  applyResolution,
  RESOLUTION_REPORT_KINDS,
  resolutionFromReports,
  signalStatusFor,
  tallyReports,
  type ResolutionEvent,
  type ResolutionReport,
  type ResolutionReportKind,
  type ResolutionSource,
  type ResolutionStatus,
} from '../domain/resolution.ts';
import {
  presentOutcome,
  PROPOSAL_RESPONSE_KINDS,
  type OutcomePresentation,
} from '../domain/outcome-presentation.ts';
import { eq } from '../ports/store.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { CorroborationRow } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { experienceResource, loadExperience } from './support.ts';

/**
 * Resolution Engine — outcome, reported by the people who lived it.
 *
 * The load-bearing rule: **a response is not a resolution.** An organization can
 * acknowledge, investigate, or dispute; only the experiencers can say whether
 * anything was actually fixed for them. That is enforced in the domain
 * (`applyResolution` refuses an organization-sourced move to a resolved state)
 * and again here, so neither layer alone is the guarantee.
 *
 * The second rule: `resolved` requires that *every* reporter says it was resolved
 * for them. Satisfying one complainant is not fixing the pattern, and reading it
 * as such would let an organization close a cluster by handling its loudest case.
 */

/** Who may report: the author, or someone with an active corroboration. */
export const mayReportResolution = async (
  deps: EngineDeps,
  experienceId: string,
  actorId: string,
): Promise<boolean> => {
  const experience = await deps.store.experiences.get(experienceId);
  if (!experience) return false;
  if (experience.actorId === actorId) return true;
  const claim = await deps.store.corroborations.queryOne([
    eq<CorroborationRow>('experienceId', experienceId),
    eq<CorroborationRow>('corroboratorId', actorId),
    eq<CorroborationRow>('status', 'active'),
  ]);
  return claim !== undefined;
};

const currentStatus = (status: string | undefined): ResolutionStatus =>
  (status ?? 'open') as ResolutionStatus;

/**
 * Record a transition and move the experience.
 *
 * The event row is the history: statuses are not terminal — an experience can be
 * reopened or disputed — so the sequence of transitions is the only place the
 * story survives.
 */
export const recordResolution = async (
  deps: EngineDeps,
  input: {
    readonly experienceId: string;
    readonly to: ResolutionStatus;
    readonly source: ResolutionSource;
    readonly actorId?: string;
    readonly detail?: string;
    readonly correlationId: string;
  },
): Promise<{ readonly changed: boolean; readonly status: ResolutionStatus } | undefined> => {
  const experience = await deps.store.experiences.get(input.experienceId);
  if (!experience) return undefined;

  const from = currentStatus(experience.resolutionStatus);
  const decided = applyResolution({ current: from, to: input.to, source: input.source });
  if (!decided.ok) return { changed: false, status: from };
  if (decided.value === from) return { changed: false, status: from };

  const event: ResolutionEvent = {
    id: deps.ids.next('rse'),
    experienceId: input.experienceId,
    fromStatus: from,
    toStatus: decided.value,
    source: input.source,
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    correlationId: input.correlationId,
    createdAt: deps.clock.now(),
  };
  await deps.store.resolutionEvents.put(event);
  await deps.store.experiences.put({
    ...experience,
    resolutionStatus: decided.value,
    resolutionStatusAt: deps.clock.now(),
  });
  deps.metrics.increment('resolution.transition', { to: decided.value, source: input.source });
  return { changed: true, status: decided.value };
};

export interface ReportResolutionInput {
  readonly experienceId: string;
  readonly kind: ResolutionReportKind;
  readonly note?: string;
}

export interface ReportResolutionResult {
  readonly reportId: string;
  readonly kind: ResolutionReportKind;
  /** The aggregate after this report, recomputed from every report. */
  readonly resolvedShare: number;
  readonly reporters: number;
  readonly status: ResolutionStatus;
}

export const registerResolutionEngine = (deps: EngineDeps): void => {
  const report: CommandHandler<ReportResolutionInput, ReportResolutionResult> = {
    name: 'resolution.report',
    action: 'resolution.report',
    resolveResource: async (input) => experienceResource(deps.store, input.experienceId),
    handle: async (input, ctx) => {
      const loaded = await loadExperience(deps.store, input.experienceId);
      if (!loaded.ok) return loaded;

      if (!RESOLUTION_REPORT_KINDS.includes(input.kind)) {
        return err(validationError('invalid_report_kind', 'a report is resolved, partially resolved, or still unresolved'));
      }

      // Only someone who claims the experience may report on its outcome. This is
      // not expressible as ownership in the policy matrix — a corroborator is not
      // the owner — so it is resolved here, and again by a database trigger.
      if (!(await mayReportResolution(deps, input.experienceId, ctx.actor.actorId))) {
        return err(
          preconditionError(
            'not_an_experiencer',
            'only the people this happened to can say whether it was resolved',
          ),
        );
      }

      // One report per person per experience, keyed naturally so changing your
      // mind updates rather than double-counting.
      const reportId = `${input.experienceId}:${ctx.actor.actorId}`;
      const row: ResolutionReport = {
        id: reportId,
        experienceId: input.experienceId,
        reporterId: ctx.actor.actorId,
        kind: input.kind,
        ...(input.note === undefined ? {} : { note: input.note }),
        reportedAt: ctx.clock.now(),
      };
      await deps.store.resolutionReports.put(row);

      const reports = await deps.store.resolutionReports.query([eq('experienceId', input.experienceId)]);
      const tally = tallyReports(reports);

      // Everyone who claims the experience: its author plus its active
      // corroborators. `resolved` needs all of them, not just whoever reported.
      const experiencers =
        1 +
        (await deps.store.corroborations.countWhere([
          eq<CorroborationRow>('experienceId', input.experienceId),
          eq<CorroborationRow>('status', 'active'),
        ]));

      // The status the reports justify — conservative by construction.
      const derived = resolutionFromReports(reports, {
        current: currentStatus(loaded.value.resolutionStatus),
        experiencers,
      });
      let status = currentStatus(loaded.value.resolutionStatus);
      if (derived !== undefined) {
        const applied = await recordResolution(deps, {
          experienceId: input.experienceId,
          to: derived,
          source: 'experiencer',
          actorId: ctx.actor.actorId,
          correlationId: ctx.correlationId,
        });
        if (applied) status = applied.status;
      }

      return ok({
        value: {
          reportId,
          kind: input.kind,
          resolvedShare: tally.resolvedShare,
          reporters: tally.reporters,
          status,
        },
        events: [
          {
            aggregateType: 'experience',
            aggregateId: input.experienceId,
            eventName: 'ResolutionReported',
            payload: {
              experienceId: input.experienceId,
              kind: input.kind,
              reporters: tally.reporters,
              resolvedShare: tally.resolvedShare,
              status,
            },
          },
        ],
      });
    },
  };

  deps.bus.register(report);
};

/**
 * Volume alone moves an experience from `open` to `gaining_signal` and no
 * further. It is a statement about how many people have said this happened to
 * them — never a statement about whether anything was fixed.
 */
export const createSignalStatusConsumer = (deps: EngineDeps): Consumer => ({
  name: 'resolution.signal_status',
  events: ['ExperienceReRaged', 'ExperienceReRaved'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    if (!experienceId) return ok(undefined);
    const experience = await deps.store.experiences.get(experienceId);
    if (!experience) return ok(undefined);

    const corroborations = await deps.store.corroborations.countWhere([
      eq<CorroborationRow>('experienceId', experienceId),
      eq<CorroborationRow>('status', 'active'),
    ]);
    const next = signalStatusFor(currentStatus(experience.resolutionStatus), corroborations);
    if (next === undefined) return ok(undefined);

    const applied = await recordResolution(deps, {
      experienceId,
      to: next,
      source: 'engine',
      correlationId: event.correlationId,
    });
    if (applied?.changed) {
      await deps.outbox.append(
        [
          {
            aggregateType: 'experience',
            aggregateId: experienceId,
            eventName: 'ResolutionStatusChanged',
            payload: { experienceId, status: applied.status, source: 'engine' },
            ...(event.id === undefined ? {} : { causationId: event.id }),
          },
        ],
        event.correlationId,
      );
    }
    return ok(undefined);
  },
});

/** The public outcome view. Reports are counted, never attributed. */
export interface ResolutionSummary {
  readonly status: ResolutionStatus;
  readonly reporters: number;
  readonly resolvedShare: number;
  readonly partial: number;
  readonly unresolved: number;
  /** True when an organization has responded, which is not the same as resolved. */
  readonly organizationResponded: boolean;
  /**
   * True when an organization has described a fix. Reported separately from
   * `organizationResponded` because a described fix nobody has confirmed is a
   * *proposal*, and a surface that cannot tell the two apart will eventually
   * present one as the other.
   */
  readonly resolutionProposed: boolean;
  /** How the five distinguishable outcomes resolve for this experience. */
  readonly presentation: OutcomePresentation;
  readonly history: readonly { readonly toStatus: ResolutionStatus; readonly source: ResolutionSource; readonly at: number }[];
}

export const resolutionSummaryFor = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<ResolutionSummary | undefined> => {
  const experience = await deps.store.experiences.get(experienceId);
  if (!experience) return undefined;

  const reports = await deps.store.resolutionReports.query([eq('experienceId', experienceId)]);
  const tally = tallyReports(reports);
  const events = await deps.store.resolutionEvents.query([eq('experienceId', experienceId)], {
    orderBy: { field: 'createdAt', direction: 'asc' },
  });

  const responses = await deps.store.organizationResponses.query([eq('experienceId', experienceId)]);
  const status = currentStatus(experience.resolutionStatus);
  const resolutionProposed = responses.some((response) =>
    PROPOSAL_RESPONSE_KINDS.includes(response.kind),
  );

  return {
    status,
    reporters: tally.reporters,
    resolvedShare: tally.resolvedShare,
    partial: tally.partial,
    unresolved: tally.unresolved,
    organizationResponded: responses.length > 0,
    resolutionProposed,
    presentation: presentOutcome({
      status,
      hasResponse: responses.length > 0,
      hasProposedResolution: resolutionProposed,
      reporters: tally.reporters,
    }),
    history: events.map((event) => ({
      toStatus: event.toStatus,
      source: event.source,
      at: event.createdAt,
    })),
  };
};

export const notFoundResolution = () => err(notFoundError('experience_not_found', 'no such experience'));
