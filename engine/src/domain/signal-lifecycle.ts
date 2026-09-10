import { floorFor } from './sampling.ts';

/**
 * Phase 54 — signal lifecycle.
 *
 * Nothing in phases 1–50 lets a signal stop being current. A cluster measured in
 * March and never touched again reads exactly like one measured this morning, and a
 * reader has no way to tell — which is the single most misleading thing this system
 * could do with a number it computed correctly.
 *
 * **A signal is not permanent truth.** It emerges, is active, stabilises, and either
 * settles or expires. The state is *derived* from measured inputs and elapsed time on
 * every read. No command sets it, no organization can move it, and there is no column
 * anywhere that stores it — a stored lifecycle state is a stale one the moment nobody
 * recomputes it, which is the same argument that keeps aging derived.
 *
 * **`resolved` here is about the signal, not about anybody's experience.** It means
 * the pattern is no longer live: people stopped reporting it and the ones who did
 * confirmed it was fixed. It does not read, write or imply any experience's
 * `resolution_status`, which only the people it happened to can move. The two words
 * are the same and the claims are not, so the type below is named for the signal and
 * the doc comment says so where somebody will read it.
 */
export type SignalLifecycleState = 'emerging' | 'active' | 'stabilizing' | 'resolved' | 'expired';

export const SIGNAL_LIFECYCLE_STATES: readonly SignalLifecycleState[] = [
  'emerging',
  'active',
  'stabilizing',
  'resolved',
  'expired',
];

const DAY = 86_400_000;

/**
 * Thresholds, named so the derivation is readable rather than magic.
 *
 * `EMERGING_MAX_EXPERIENCERS` is one below the Phase 38 person floor on purpose: a
 * pattern that cannot yet be reported publicly is exactly what "emerging" means, so
 * the two boundaries are the same boundary and are derived from one place.
 */
export const RECENT_WINDOW_MS = 14 * DAY;
export const STABILIZING_AFTER_MS = 30 * DAY;
export const EXPIRES_AFTER_MS = 180 * DAY;
export const EMERGING_MAX_EXPERIENCERS = floorFor('responsiveness') - 1;
/** How much of the reporting population must confirm a fix before a signal settles. */
export const RESOLVED_SHARE = 0.75;

export interface SignalLifecycleInput {
  /** When the first contribution to this pattern arrived. */
  readonly firstContributionAt: number;
  /** When the most recent one did. Equal to `firstContributionAt` for a new pattern. */
  readonly lastContributionAt: number;
  /** Distinct people, never accounts — the same count the person floor governs. */
  readonly uniqueExperiencers: number;
  /** Contributions inside `RECENT_WINDOW_MS`. Growth, measured rather than guessed. */
  readonly recentContributions: number;
  /** Of the people who reported an outcome, the share who said it was resolved. */
  readonly resolvedShare: number;
  /** How many people reported an outcome at all. Governs whether the share may decide. */
  readonly outcomeReporters: number;
  readonly now: number;
}

export interface SignalLifecycle {
  readonly state: SignalLifecycleState;
  /** The rule that decided it, named. Not prose assembled for a human. */
  readonly because:
    | 'no_contribution_within_expiry'
    | 'outcome_confirmed_by_reporters'
    | 'no_recent_contribution'
    | 'below_reporting_floor'
    | 'recent_contribution';
  readonly sinceLastContributionMs: number;
  readonly ageMs: number;
  /** True only for `active` and `emerging`. What a reader means by "is this current". */
  readonly current: boolean;
}

/**
 * Derive the state. Precedence is explicit and total, because two rules can hold at
 * once and a reader has to be able to say which one won.
 *
 *   1. **expired** — nothing has arrived for `EXPIRES_AFTER_MS`. Whatever else is
 *      true of a pattern nobody has reported in six months, it is not current.
 *   2. **resolved** — enough people reported an outcome, and enough of them said it
 *      was fixed. Gated on `outcomeReporters` clearing the sample floor, so one
 *      satisfied reporter cannot settle a pattern.
 *   3. **stabilizing** — nothing recent, but not yet expired. Slowing down is not
 *      the same as stopping and neither is the same as being fixed.
 *   4. **emerging** — too few distinct people to report publicly at all.
 *   5. **active** — otherwise. Something arrived recently and the pattern is live.
 */
export const lifecycleOf = (input: SignalLifecycleInput): SignalLifecycle => {
  const sinceLastContributionMs = Math.max(0, input.now - input.lastContributionAt);
  const ageMs = Math.max(0, input.now - input.firstContributionAt);
  const base = { sinceLastContributionMs, ageMs };

  if (sinceLastContributionMs >= EXPIRES_AFTER_MS) {
    return { ...base, state: 'expired', because: 'no_contribution_within_expiry', current: false };
  }

  if (
    input.outcomeReporters >= floorFor('resolution_rate') &&
    input.resolvedShare >= RESOLVED_SHARE &&
    input.recentContributions === 0
  ) {
    return { ...base, state: 'resolved', because: 'outcome_confirmed_by_reporters', current: false };
  }

  if (sinceLastContributionMs >= STABILIZING_AFTER_MS) {
    return { ...base, state: 'stabilizing', because: 'no_recent_contribution', current: false };
  }

  if (input.uniqueExperiencers <= EMERGING_MAX_EXPERIENCERS) {
    return { ...base, state: 'emerging', because: 'below_reporting_floor', current: true };
  }

  return { ...base, state: 'active', because: 'recent_contribution', current: true };
};

/**
 * Deliberately absent: any command that sets a lifecycle state.
 *
 * An organization being able to mark a pattern about itself resolved is the whole
 * failure this band has to avoid, and the way to avoid it is for the verb not to
 * exist. There is no `signal.setState`, and this returns `undefined` so a test can
 * assert the absence rather than a reader having to notice it.
 */
export const setLifecycleState = (): undefined => undefined;
