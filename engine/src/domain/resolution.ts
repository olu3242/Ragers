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
  open: ['gaining_signal', 'acknowledged', 'under_review', 'disputed'],
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
 * Deliberately conservative: `resolved` requires that every reporter says it was
 * resolved for them. One person being made whole is not the experience being
 * resolved, and treating it as such would let an organization satisfy one
 * complainant and claim the pattern was fixed.
 */
export const resolutionFromReports = (
  reports: readonly ResolutionReport[],
): ResolutionStatus | undefined => {
  const tally = tallyReports(reports);
  if (tally.reporters === 0) return undefined;
  if (tally.resolved === tally.reporters) return 'resolved';
  if (tally.resolved > 0 || tally.partial > 0) return 'partially_resolved';
  // Everyone still says it is unresolved, which is not a new state.
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
