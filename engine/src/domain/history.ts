import { aggregate, MINIMUM_DISTINCT_CONTRIBUTORS, type Aggregate } from './aggregation.ts';
import type { MeasureKind } from './sampling.ts';

/**
 * Phase 53 — organization pattern history.
 *
 * A series, where Phase 36 gave a snapshot. Responsiveness answers "how is this
 * organization doing now"; nothing answered "better or worse than it was", and the
 * difference matters because a single figure lets a bad quarter read as a track
 * record and a good one erase a bad year.
 *
 * **A history is not a ranking.** Nothing here orders organizations against each
 * other. That is Phase 47's question and it is data-blocked for reasons that apply
 * here with more force, not less: a comparison over time between *one* party's own
 * periods needs no other party's numbers, and inviting them in is how a history
 * becomes a league table nobody agreed to be in. `rankOrganizations` returns
 * `undefined` so the absence is assertable.
 *
 * **Every point carries the Phase 38 floors and the Phase 39 guards**, because a
 * series is exactly how a suppressed cell gets recovered by subtraction. Two
 * adjacent periods can each clear the person floor while the *change* between them
 * is carried by two people — and a published change is then a two-person group
 * reported out loud. `changeBetween` is where that is refused.
 */

export interface HistoryPointInput<T> {
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly sampleSize: number;
  readonly distinctContributors: number;
  /** Distinct contributors in this period who did not appear in the previous one. */
  readonly newContributors: number;
  readonly compute: () => T;
}

export interface HistoryPoint<T> {
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly aggregate: Aggregate<T>;
  readonly newContributors: number;
}

/** Named, and about one named metric. Never a composite of several. */
export type ChangeDirection = 'improved' | 'worsened' | 'steady';

export interface ChangeReported {
  readonly withheld: false;
  readonly direction: ChangeDirection;
  /** Later minus earlier, in the metric's own units. */
  readonly delta: number;
  readonly fromPeriodEnd: number;
  readonly toPeriodEnd: number;
}

export interface ChangeWithheld {
  readonly withheld: true;
  readonly reason: 'a_period_is_suppressed' | 'differencing_risk';
  readonly explanation: string;
}

export type Change = ChangeReported | ChangeWithheld;

export interface HistorySeries<T> {
  readonly subjectId: string;
  readonly kind: MeasureKind;
  readonly points: readonly HistoryPoint<T>[];
}

/**
 * Steadiness needs a width, or every series is noise.
 *
 * Expressed as a fraction of the earlier value rather than an absolute, so the same
 * rule works for a rate and for a duration in milliseconds.
 */
export const STEADY_BAND = 0.05;

export const seriesOf = <T>(
  subjectId: string,
  kind: MeasureKind,
  points: readonly HistoryPointInput<T>[],
): HistorySeries<T> => ({
  subjectId,
  kind,
  points: [...points]
    .sort((left, right) => left.periodStart - right.periodStart)
    .map((point) => ({
      periodStart: point.periodStart,
      periodEnd: point.periodEnd,
      newContributors: Math.max(0, Math.trunc(point.newContributors)),
      aggregate: aggregate({
        kind,
        sampleSize: point.sampleSize,
        distinctContributors: point.distinctContributors,
        compute: point.compute,
      }),
    })),
});

/**
 * The change between two consecutive points, or a refusal to state one.
 *
 * `higherIsBetter` is a parameter rather than a per-metric table because the caller
 * knows what its own metric means: a rising resolution rate is an improvement and a
 * rising time-to-first-response is not, and getting that wrong silently is worse than
 * asking.
 */
export const changeBetween = (
  earlier: HistoryPoint<number>,
  later: HistoryPoint<number>,
  options: { readonly higherIsBetter: boolean },
): Change => {
  if (earlier.aggregate.suppressed || later.aggregate.suppressed) {
    return {
      withheld: true,
      reason: 'a_period_is_suppressed',
      explanation: 'One of these periods has too little in it to describe, so the change between them is not stated.',
    };
  }
  if (earlier.aggregate.measure.withheld || later.aggregate.measure.withheld) {
    return {
      withheld: true,
      reason: 'a_period_is_suppressed',
      explanation: 'One of these periods has too little in it to describe, so the change between them is not stated.',
    };
  }

  // The differencing guard, applied to time rather than to nested groups. Both
  // periods can clear every floor while the movement between them is carried by a
  // handful of people, and stating the change would report that handful.
  if (later.newContributors > 0 && later.newContributors < MINIMUM_DISTINCT_CONTRIBUTORS) {
    return {
      withheld: true,
      reason: 'differencing_risk',
      explanation:
        'Too few different people separate these two periods — stating the change would describe just those few.',
    };
  }

  const from = earlier.aggregate.measure.value;
  const to = later.aggregate.measure.value;
  const delta = to - from;
  const width = Math.abs(from) * STEADY_BAND;
  const direction: ChangeDirection =
    Math.abs(delta) <= width ? 'steady' : (delta > 0) === options.higherIsBetter ? 'improved' : 'worsened';

  return {
    withheld: false,
    direction,
    delta: Number(delta.toFixed(4)),
    fromPeriodEnd: earlier.periodEnd,
    toPeriodEnd: later.periodEnd,
  };
};

/** Every consecutive change in a series, in order. */
export const changesAcross = (
  series: HistorySeries<number>,
  options: { readonly higherIsBetter: boolean },
): readonly Change[] =>
  series.points
    .slice(1)
    .map((point, index) => changeBetween(series.points[index] as HistoryPoint<number>, point, options));

/**
 * Deliberately absent: any ordering of organizations against each other.
 *
 * A history describes one party over time. Ranking is a different claim, needs a
 * different floor, and is Phase 47's — where it is data-blocked rather than built.
 */
export const rankOrganizations = (): undefined => undefined;
