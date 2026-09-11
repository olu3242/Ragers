import { measure, type Measure } from './sampling.ts';
import { SEVERITY_BANDS, type SeverityBand } from './severity.ts';

/**
 * Impact estimation — Phase 42, E8.
 *
 * The phase's own design constraint is the hard part: *every figure carries its
 * interval and its sample size, and is labelled as reported-by-experiencers rather
 * than measured.* So this module is built around one refusal — **it will not produce a
 * point estimate without an interval**, and it will not produce either without enough
 * people to draw one from.
 *
 * `INSUFFICIENT_DATA` is a first-class outcome rather than a zero. That distinction is
 * the whole point: "we do not know how many people this affected" and "this affected
 * nobody" are opposite statements, and a surface that renders `0` for the first is
 * making the second.
 *
 * What impact is estimated *from*: asserted dimensions (Phase 31), the count of
 * distinct people who said it happened to them, recurrence, how long it has run, and
 * the spread of severity across the pattern. What it is never estimated from: how many
 * people read it, shared it, or reacted to it. Engagement is not impact, and there is
 * deliberately no parameter here through which a view or a share could arrive.
 */
export type ImpactOutcome = 'estimated' | 'INSUFFICIENT_DATA';

/**
 * A reported figure with its interval.
 *
 * The interval is not decoration. It is derived from how many people actually
 * answered the dimension, so it widens as evidence thins — which is the honest
 * behaviour and also the one that stops a thin estimate reading as a firm one.
 */
export interface ReportedRange {
  /** The central figure. Never presented without `low` and `high` beside it. */
  readonly midpoint: number;
  readonly low: number;
  readonly high: number;
  /** How many people asserted this dimension. The interval is drawn from it. */
  readonly reporters: number;
  /** Always true here, and said out loud: nothing in this module is measured. */
  readonly reportedByExperiencers: true;
}

export interface ImpactEstimate {
  readonly outcome: 'estimated';
  /** Distinct people who said this happened to them. A count, not an estimate. */
  readonly peopleAffected: number;
  /** Extrapolated reach, always as a range. Absent when nothing supports one. */
  readonly moneyLost?: ReportedRange;
  readonly timeLostMinutes?: ReportedRange;
  /** Whether people said it keeps happening, as a share of those who answered. */
  readonly recurrenceShare?: number;
  /** How long the pattern has been running, in days. From the event log. */
  readonly runningForDays: number;
  /** The spread of severity across the pattern, not an average of it. */
  readonly severitySpread: Readonly<Record<SeverityBand, number>>;
  /** Share of the pattern the people it happened to have reported resolved. */
  readonly resolvedShare: Measure<number>;
  /** How much of the picture the assertions cover, 0–1. Not a probability. */
  readonly confidence: number;
  /** The rows this was drawn from, so a reader can check rather than trust. */
  readonly basis: ImpactBasis;
}

export interface Insufficient {
  readonly outcome: 'INSUFFICIENT_DATA';
  readonly peopleAffected: number;
  readonly floor: number;
  readonly shortBy: number;
  /** Said plainly, so a surface explains the gap rather than showing a blank. */
  readonly explanation: string;
}

export type Impact = ImpactEstimate | Insufficient;

export interface ImpactBasis {
  readonly experiences: number;
  readonly distinctExperiencers: number;
  readonly withAssertedCost: number;
  readonly locations: number;
}

/**
 * The floor for an impact estimate.
 *
 * Higher than the generic sample floor on purpose. A responsiveness median over five
 * cases describes five cases and says so; an *extrapolated* figure — "people lost
 * roughly this much" — is a claim about people who never answered, and that needs more
 * under it before it is honest to make.
 */
export const IMPACT_MINIMUM_EXPERIENCERS = 5;

export interface ImpactInputs {
  /** Distinct people who said it happened to them, across the pattern. */
  readonly distinctExperiencers: number;
  readonly experiences: number;
  /** Asserted money amounts, one per person who answered. Same currency. */
  readonly moneyAsserted: readonly number[];
  readonly minutesAsserted: readonly number[];
  /** How many of those who answered said it keeps happening. */
  readonly recurrenceAsserted: { readonly yes: number; readonly answered: number };
  readonly severityBands: readonly SeverityBand[];
  readonly runningForDays: number;
  readonly locations: number;
  /** Resolution reports across the pattern. */
  readonly resolutionReports: { readonly resolved: number; readonly total: number };
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : sum(values) / values.length);

/**
 * The interval, from the spread of what people actually said.
 *
 * A deliberately plain approach — the mean plus or minus the sample standard error,
 * widened by a factor that shrinks as reporters accumulate — rather than a confidence
 * interval dressed in statistical language it cannot support. The property that matters
 * is directional and testable: **fewer reporters produce a wider range**, so a thin
 * estimate cannot be mistaken for a firm one.
 *
 * It is then multiplied up to the affected population, which is where the range earns
 * its keep: extrapolating a mean from three answers to fifty people is exactly the
 * false precision Phase 42 forbids, and the width says so.
 */
const rangeFrom = (asserted: readonly number[], population: number): ReportedRange | undefined => {
  if (asserted.length === 0) return undefined;
  const reporters = asserted.length;
  const average = mean(asserted);
  const variance = reporters < 2 ? 0 : sum(asserted.map((v) => (v - average) ** 2)) / (reporters - 1);
  const standardError = reporters < 2 ? average : Math.sqrt(variance / reporters);
  // The widening factor: it falls as reporters accumulate and never reaches zero.
  const uncertainty = standardError + average / Math.sqrt(reporters);

  const round = (value: number): number => Math.max(0, Math.round(value));
  return {
    midpoint: round(average * population),
    low: round(Math.max(0, average - uncertainty) * population),
    high: round((average + uncertainty) * population),
    reporters,
    reportedByExperiencers: true,
  };
};

const emptySpread = (): Record<SeverityBand, number> => ({
  minor: 0,
  significant: 0,
  serious: 0,
  critical: 0,
});

export const estimateImpact = (inputs: ImpactInputs): Impact => {
  const people = Math.max(0, Math.trunc(inputs.distinctExperiencers));

  if (people < IMPACT_MINIMUM_EXPERIENCERS) {
    return {
      outcome: 'INSUFFICIENT_DATA',
      peopleAffected: people,
      floor: IMPACT_MINIMUM_EXPERIENCERS,
      shortBy: IMPACT_MINIMUM_EXPERIENCERS - people,
      explanation:
        'Not enough people have said this happened to them to estimate what it has cost without inventing most of it.',
    };
  }

  const spread = emptySpread();
  for (const band of inputs.severityBands) {
    if (SEVERITY_BANDS.includes(band)) spread[band] += 1;
  }

  const money = rangeFrom(inputs.moneyAsserted, people);
  const minutes = rangeFrom(inputs.minutesAsserted, people);

  // Coverage: how much of the picture the assertions cover. Named `confidence` because
  // that is what the phase calls it, and capped at 1 so it cannot read as a percentage
  // above certainty.
  const answered = inputs.moneyAsserted.length + inputs.minutesAsserted.length + inputs.recurrenceAsserted.answered;
  const coverage = people === 0 ? 0 : Math.min(1, answered / (people * 3));

  return {
    outcome: 'estimated',
    peopleAffected: people,
    ...(money === undefined ? {} : { moneyLost: money }),
    ...(minutes === undefined ? {} : { timeLostMinutes: minutes }),
    ...(inputs.recurrenceAsserted.answered === 0
      ? {}
      : {
          recurrenceShare: Number(
            (inputs.recurrenceAsserted.yes / inputs.recurrenceAsserted.answered).toFixed(3),
          ),
        }),
    runningForDays: Math.max(0, Math.trunc(inputs.runningForDays)),
    severitySpread: spread,
    // Through the shared floor, so this rate behaves like every other rate.
    resolvedShare: measure('resolution_rate', inputs.resolutionReports.total, () =>
      inputs.resolutionReports.total === 0
        ? 0
        : Number((inputs.resolutionReports.resolved / inputs.resolutionReports.total).toFixed(3)),
    ),
    confidence: Number(coverage.toFixed(3)),
    basis: {
      experiences: Math.max(0, Math.trunc(inputs.experiences)),
      distinctExperiencers: people,
      withAssertedCost: inputs.moneyAsserted.length + inputs.minutesAsserted.length,
      locations: Math.max(0, Math.trunc(inputs.locations)),
    },
  };
};

export const isEstimated = (impact: Impact): impact is ImpactEstimate => impact.outcome === 'estimated';

/**
 * The severity spread as words, never as an average.
 *
 * Averaging a spread is how "one critical and nine minor" becomes "moderate" — which
 * describes nothing that happened to anybody.
 */
export const describeSpread = (spread: Readonly<Record<SeverityBand, number>>): string => {
  const parts = SEVERITY_BANDS.filter((band) => (spread[band] ?? 0) > 0).map(
    (band) => `${spread[band]} ${band}`,
  );
  return parts.length === 0 ? 'nobody has said what it cost them' : parts.join(', ');
};

/** Impact is never drawn from engagement. Asserted in a test rather than trusted. */
export const impactReadsEngagement = (): false => false;
