import type { ResolutionEvent, ResolutionStatus } from './resolution.ts';

/**
 * Resolution lifecycle aging — Phase 33, E10.
 *
 * Derived on read from the resolution event log, never stored. That is the whole
 * design decision: a stored `daysUnresolved` is wrong the moment nobody recomputes
 * it, and a number that is silently stale is worse than no number. The event log is
 * append-only and already certified, so it can be replayed cheaply and always agrees
 * with itself.
 *
 * The second decision: **silence is aged as silence.** An organization that has said
 * nothing for sixty days produces a long `sinceOrganizationContact`, and nothing
 * anywhere converts that into rejection, admission or resolution. Silence is a fact
 * about elapsed time and nothing more.
 */
export interface AgingInput {
  readonly events: readonly ResolutionEvent[];
  readonly currentStatus: ResolutionStatus;
  readonly publishedAt: number;
  /** Most recent organization response, if any. */
  readonly lastOrganizationContactAt?: number | undefined;
  /** When a fix was proposed and left unconfirmed by the people it happened to. */
  readonly proposedResolutionAt?: number | undefined;
  readonly now: number;
}

export interface Aging {
  /** Since publication, whatever has happened since. */
  readonly ageMs: number;
  /** Time in the current resolution status. */
  readonly inCurrentStatusMs: number;
  /** Since the organization last said anything. Undefined when it never has. */
  readonly sinceOrganizationContactMs?: number;
  /** How long a proposed fix has gone unconfirmed. Undefined when none is open. */
  readonly proposedUnconfirmedMs?: number;
  /** True while the outcome is not settled either way. */
  readonly unresolved: boolean;
}

const RESOLVED_STATUSES: readonly ResolutionStatus[] = ['resolved', 'partially_resolved'];

export const ageOf = (input: AgingInput): Aging => {
  const now = input.now;
  const sorted = [...input.events].sort((left, right) => left.createdAt - right.createdAt);
  const lastTransition = sorted.filter((event) => event.toStatus === input.currentStatus).at(-1);
  const enteredCurrentAt = lastTransition?.createdAt ?? input.publishedAt;

  return {
    ageMs: Math.max(0, now - input.publishedAt),
    inCurrentStatusMs: Math.max(0, now - enteredCurrentAt),
    ...(input.lastOrganizationContactAt === undefined
      ? {}
      : { sinceOrganizationContactMs: Math.max(0, now - input.lastOrganizationContactAt) }),
    ...(input.proposedResolutionAt === undefined
      ? {}
      : { proposedUnconfirmedMs: Math.max(0, now - input.proposedResolutionAt) }),
    unresolved: !RESOLVED_STATUSES.includes(input.currentStatus),
  };
};

const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * Durations in plain words.
 *
 * Rounded on purpose. "17 days" is what somebody can act on; "16.83 days" is false
 * precision about a number derived from when a webhook happened to land.
 */
export const describeDuration = (ms: number): string => {
  if (ms < HOUR) return 'under an hour';
  if (ms < DAY) {
    const hours = Math.round(ms / HOUR);
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  const days = Math.round(ms / DAY);
  if (days < 14) return days === 1 ? '1 day' : `${days} days`;
  if (days < 60) {
    const weeks = Math.round(days / 7);
    return weeks === 1 ? '1 week' : `${weeks} weeks`;
  }
  const months = Math.round(days / 30);
  return months === 1 ? '1 month' : `${months} months`;
};

/** Whole days, for threshold comparisons that should not depend on the hour. */
export const daysOf = (ms: number): number => Math.floor(ms / DAY);
