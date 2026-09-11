import { err, ok, type Result } from '../runtime/result.ts';
import { preconditionError, type EngineError } from '../runtime/errors.ts';

/**
 * The resolution lifecycle — what happened *after* the experience.
 *
 * This is a separate axis from publication status. Publication answers "may
 * anyone see this?"; resolution answers "did it get put right?". An experience
 * can be published and open, or removed and resolved.
 *
 * The rule that shapes the whole engine: an organization responding never
 * resolves anything. Only the people who lived the experience can say it was
 * resolved for them.
 */
export type ResolutionStatus =
  | 'open'
  | 'gaining_signal'
  | 'acknowledged'
  | 'under_review'
  | 'resolved'
  | 'partially_resolved'
  | 'disputed'
  | 'reopened';

export const RESOLUTION_STATUSES: readonly ResolutionStatus[] = [
  'open',
  'gaining_signal',
  'acknowledged',
  'under_review',
  'resolved',
  'partially_resolved',
  'disputed',
  'reopened',
];

const TRANSITIONS: Readonly<Record<ResolutionStatus, readonly ResolutionStatus[]>> = {
  // An experiencer's report is the most authoritative source there is, so it must
  // be recordable on a fresh experience. Requiring an acknowledgement first would
  // mean an organization's silence could hold an outcome open indefinitely.
  open: ['gaining_signal', 'acknowledged', 'under_review', 'partially_resolved', 'resolved', 'disputed'],
  gaining_signal: ['acknowledged', 'under_review', 'partially_resolved', 'resolved', 'disputed'],
  acknowledged: ['under_review', 'partially_resolved', 'resolved', 'disputed'],
  under_review: ['partially_resolved', 'resolved', 'disputed'],
  // Resolution is not permanent: an experience can come back.
  resolved: ['reopened', 'disputed'],
  partially_resolved: ['resolved', 'under_review', 'reopened', 'disputed'],
  disputed: ['under_review', 'partially_resolved', 'resolved'],
  reopened: ['acknowledged', 'under_review', 'partially_resolved', 'resolved', 'disputed'],
};

export const canTransitionResolution = (from: ResolutionStatus, to: ResolutionStatus): boolean =>
  (TRANSITIONS[from] ?? []).includes(to);

/** No resolution state is terminal: any experience can be reopened or disputed. */
export const isResolutionTerminal = (): boolean => false;

export type ResolutionSource = 'experiencer' | 'organization' | 'engine' | 'moderator';

export type ResolutionReportKind = 'resolved_for_me' | 'partially_resolved' | 'still_unresolved';

export const RESOLUTION_REPORT_KINDS: readonly ResolutionReportKind[] = [
  'resolved_for_me',
  'partially_resolved',
  'still_unresolved',
];

export interface ResolutionReport {
  readonly id: string;
  readonly experienceId: string;
  readonly reporterId: string;
  readonly kind: ResolutionReportKind;
  readonly note?: string;
  readonly reportedAt: number;
}

export interface ResolutionEvent {
  readonly id: string;
  readonly experienceId: string;
  readonly fromStatus?: ResolutionStatus;
  readonly toStatus: ResolutionStatus;
  readonly source: ResolutionSource;
  readonly actorId?: string;
  readonly detail?: string;
  readonly correlationId: string;
  readonly createdAt: number;
}

export interface ResolutionTally {
  readonly resolved: number;
  readonly partial: number;
  readonly unresolved: number;
  readonly reporters: number;
  /** Share of reporters saying it was resolved for them. */
  readonly resolvedShare: number;
}

export const tallyReports = (reports: readonly ResolutionReport[]): ResolutionTally => {
  const resolved = reports.filter((report) => report.kind === 'resolved_for_me').length;
  const partial = reports.filter((report) => report.kind === 'partially_resolved').length;
  const unresolved = reports.filter((report) => report.kind === 'still_unresolved').length;
  const reporters = reports.length;
  return {
    resolved,
    partial,
    unresolved,
    reporters,
    resolvedShare: reporters === 0 ? 0 : Number((resolved / reporters).toFixed(4)),
  };
};

/**
 * Derive the resolution status the reports justify, or undefined when they
 * justify no change.
 *
 * Deliberately conservative in two ways.
 *
 * **`resolved` needs everyone who claims the experience**, not merely everyone
 * who happened to report. If one of three experiencers says it was fixed for
 * them and the other two have said nothing, the experience is partially
 * resolved — reading it as resolved would let an organization close a pattern by
 * satisfying whoever complained loudest, and would do it before the others had a
 * chance to speak.
 *
 * **A resolution that stops holding is reopened.** When every report says it is
 * still unresolved, that means nothing new on a fresh experience, but on one
 * already marked resolved or partially resolved it means the fix did not hold.
 * Leaving it marked resolved would make the outcome a one-way door.
 */
export const resolutionFromReports = (
  reports: readonly ResolutionReport[],
  context: { readonly current: ResolutionStatus; readonly experiencers: number } = {
    current: 'open',
    experiencers: 0,
  },
): ResolutionStatus | undefined => {
  const tally = tallyReports(reports);
  if (tally.reporters === 0) return undefined;

  // Everyone who claims the experience has reported, and all of them say fixed.
  const everyoneReported = tally.reporters >= Math.max(1, context.experiencers);
  if (tally.resolved === tally.reporters && everyoneReported) return 'resolved';

  if (tally.resolved > 0 || tally.partial > 0) return 'partially_resolved';

  // Every report says it is still unresolved.
  if (context.current === 'resolved' || context.current === 'partially_resolved') return 'reopened';
  return undefined;
};

export interface ApplyResolutionInput {
  readonly current: ResolutionStatus;
  readonly to: ResolutionStatus;
  readonly source: ResolutionSource;
}

/**
 * Guard a resolution transition. Besides the state machine, one rule is
 * absolute: an organization cannot move an experience to a resolved state.
 * It can acknowledge, review, or dispute — the experiencers decide the rest.
 */
export const applyResolution = (
  input: ApplyResolutionInput,
): Result<ResolutionStatus, EngineError> => {
  if (input.current === input.to) return ok(input.current);

  if (
    input.source === 'organization' &&
    (input.to === 'resolved' || input.to === 'partially_resolved')
  ) {
    return err(
      preconditionError(
        'organization_cannot_resolve',
        'an organization response cannot mark an experience resolved; only the people who experienced it can',
        { to: input.to },
      ),
    );
  }

  if (!canTransitionResolution(input.current, input.to)) {
    return err(
      preconditionError('illegal_resolution_transition', `cannot move from ${input.current} to ${input.to}`, {
        from: input.current,
        to: input.to,
      }),
    );
  }

  return ok(input.to);
};

/** The status a fresh corroboration volume justifies, before anyone responds. */
export const signalStatusFor = (
  current: ResolutionStatus,
  corroborations: number,
  threshold = 3,
): ResolutionStatus | undefined => {
  if (current !== 'open') return undefined;
  if (corroborations < threshold) return undefined;
  return 'gaining_signal';
};
