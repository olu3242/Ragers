/**
 * Phase 55 — signal decay and recovery.
 *
 * A pattern reported forty times last year and twice this month is not the same
 * pattern as one reported forty times this month, and a raw count says they are.
 * Decay is how recency enters a measure without anybody deleting anything.
 *
 * **The historical record remains auditable.** Decay changes the *weight* a
 * contribution carries in a current measure. It changes no row, deletes no row and
 * hides no row: every contribution that was ever counted stays readable with its
 * date, because "this was true in March" is a fact and erasing it to make a number
 * tidier is a lie. Nothing in this module writes.
 *
 * **Recovery is measured, not declared.** A pattern that stopped and starts again
 * gains weight because new contributions have recent dates — not because anybody
 * revived it. There is no command here at all, so there is nothing to call.
 *
 * **Order cannot matter.** The weight is a sum of independent per-contribution terms,
 * so replaying the same contributions in any order gives the same answer. That is not
 * an accident of the implementation; it is the property that lets this be recomputed
 * from rows at any time, by any process, and agree with itself.
 */

const DAY = 86_400_000;

/**
 * Half-life: a contribution counts half as much after this long.
 *
 * Ninety days rather than something shorter because the thing being measured is
 * whether an organization has a *pattern*, and a pattern that fades inside a quarter
 * was an incident. Rather than something longer because a year-old complaint should
 * not outweigh this month's.
 */
export const HALF_LIFE_MS = 90 * DAY;

/**
 * Contributions older than this carry no weight at all.
 *
 * A floor rather than an asymptote, so a very large number of very old contributions
 * cannot sum their way back to significance — which is the arithmetic a pure
 * exponential permits and nobody expects.
 */
export const WEIGHT_HORIZON_MS = 540 * DAY;

export interface DecayInput {
  /** Every contribution's timestamp. The rows stay; only the weight decays. */
  readonly contributionsAt: readonly number[];
  readonly now: number;
}

export interface DecayedWeight {
  /** Sum of per-contribution weights. Order-independent by construction. */
  readonly weight: number;
  /** Rows counted, undecayed. Reported alongside so the decay is visible, not hidden. */
  readonly contributionCount: number;
  /** Rows past the horizon. Counted here rather than dropped silently. */
  readonly beyondHorizon: number;
  /** The most recent contribution, or undefined when there are none. */
  readonly lastContributionAt?: number;
}

/** One contribution's weight: 1 when new, halving every `HALF_LIFE_MS`, 0 past the horizon. */
export const weightAt = (contributedAt: number, now: number): number => {
  const age = Math.max(0, now - contributedAt);
  if (age >= WEIGHT_HORIZON_MS) return 0;
  return 2 ** (-age / HALF_LIFE_MS);
};

export const decayedWeightOf = (input: DecayInput): DecayedWeight => {
  let weight = 0;
  let beyondHorizon = 0;
  let lastContributionAt: number | undefined;
  for (const at of input.contributionsAt) {
    const term = weightAt(at, input.now);
    if (term === 0) beyondHorizon += 1;
    weight += term;
    if (lastContributionAt === undefined || at > lastContributionAt) lastContributionAt = at;
  }
  return {
    // Rounded once, at the end. Rounding per term would make the total depend on
    // how the contributions happened to be grouped.
    weight: Number(weight.toFixed(4)),
    contributionCount: input.contributionsAt.length,
    beyondHorizon,
    ...(lastContributionAt === undefined ? {} : { lastContributionAt }),
  };
};

/**
 * Whether a pattern is recovering: recent weight against the weight it would have
 * had at the start of the window.
 *
 * Stated as a named direction rather than a ratio, for the same reason priority is a
 * band and not a score — a ratio invites somebody to sort by it.
 */
export type RecoveryDirection = 'recovering' | 'fading' | 'steady';

export const RECOVERY_BAND = 0.1;

export const recoveryOf = (input: DecayInput, windowMs: number): RecoveryDirection => {
  const asOf = input.now - windowMs;
  const now = decayedWeightOf(input).weight;
  // Only what had actually happened by then. `weightAt` clamps a negative age to
  // zero, so passing the whole set would count contributions that did not yet exist
  // at full weight — and a pattern that only started this week would look flat.
  const then = decayedWeightOf({
    contributionsAt: input.contributionsAt.filter((moment) => moment <= asOf),
    now: asOf,
  }).weight;
  // Nothing had happened yet a window ago, so there is nothing to have recovered
  // from. A brand-new pattern is emerging, which is the lifecycle's word for it —
  // calling it "recovering" would have every new pattern claim a history it does not
  // have, and would draw a `pattern_recovered` conclusion about its first week.
  if (then === 0) return 'steady';
  const change = (now - then) / then;
  if (Math.abs(change) <= RECOVERY_BAND) return 'steady';
  return change > 0 ? 'recovering' : 'fading';
};

/**
 * Deliberately absent: anything that deletes or rewrites a decayed contribution.
 *
 * Returning `undefined` so the absence is assertable. Decay is a read-time weight; a
 * "prune old contributions" job would make the historical record unauditable and
 * would make every past measure unreproducible.
 */
export const pruneDecayedContributions = (): undefined => undefined;
