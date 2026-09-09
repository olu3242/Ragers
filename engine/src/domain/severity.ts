import type { EnrichmentDimension, EnrichmentValue } from './enrichment.ts';

/**
 * Severity classification — Phase 32, E8.
 *
 * The rule this module exists to enforce, and the one most likely to be quietly
 * broken later: **severity comes from what people asserted, never from how they
 * wrote it.** A furious sentence about a delayed parcel is not a severe experience;
 * a flat sentence about a fire door chained shut is.
 *
 * So the classifier takes structured assertions and a count of independent
 * experiencers. It never takes text. There is no parameter to pass text through,
 * which is the only version of this rule that survives contact with a deadline.
 *
 * It is a **band**, not a score. Four named steps a person can reason about, with the
 * dimensions that produced it attached, so an organization reading "serious" can see
 * *why* rather than dispute a number. A 0–100 severity score would invite exactly
 * the comparison across unlike experiences that the band refuses to support.
 */
export type SeverityBand = 'minor' | 'significant' | 'serious' | 'critical';

export const SEVERITY_BANDS: readonly SeverityBand[] = ['minor', 'significant', 'serious', 'critical'];

const BAND_ORDER: Readonly<Record<SeverityBand, number>> = {
  minor: 0,
  significant: 1,
  serious: 2,
  critical: 3,
};

export const isAtLeastBand = (band: SeverityBand, floor: SeverityBand): boolean =>
  BAND_ORDER[band] >= BAND_ORDER[floor];

/**
 * How much of the picture the assertions cover.
 *
 * Not a probability and not presented as one. It is the share of dimensions the
 * person actually answered, because a band drawn from one answered dimension deserves
 * to be read more cautiously than the same band drawn from five — and the reader is
 * told which it is instead of having to guess.
 */
export interface SeverityClassification {
  readonly band: SeverityBand;
  readonly confidence: number;
  /** The dimensions that moved the band, in the order they were considered. */
  readonly basis: readonly EnrichmentDimension[];
  /** Independent people who said this happened to them. Never a multiplier on band. */
  readonly independentExperiencers: number;
  /** True when nothing was asserted: the band is a floor, not a finding. */
  readonly unassessed: boolean;
}

export interface ClassifyInput {
  /** Asserted values only. Pass `assertedValues(enrichment)`, never raw values. */
  readonly asserted: readonly EnrichmentValue[];
  readonly independentExperiencers: number;
}

/** Thresholds are money in minor units of the asserted currency's major unit. */
const MONEY_SIGNIFICANT = 50;
const MONEY_SERIOUS = 500;
const MONEY_CRITICAL = 5_000;

const MINUTES_SIGNIFICANT = 60;
const MINUTES_SERIOUS = 60 * 8;
const MINUTES_CRITICAL = 60 * 48;

const PEOPLE_SERIOUS = 10;
const PEOPLE_CRITICAL = 100;

const highest = (bands: readonly SeverityBand[]): SeverityBand =>
  bands.reduce<SeverityBand>((best, band) => (BAND_ORDER[band] > BAND_ORDER[best] ? band : best), 'minor');

const numeric = (values: readonly EnrichmentValue[], dimension: EnrichmentDimension): number | undefined => {
  const found = values.find((value) => value.dimension === dimension);
  return found?.amount;
};

const flagged = (values: readonly EnrichmentValue[], dimension: EnrichmentDimension): boolean =>
  values.find((value) => value.dimension === dimension)?.flag === true;

/**
 * Classify.
 *
 * Each dimension proposes a band; the highest wins. Deliberately a maximum rather
 * than a weighted sum: safety involvement at `critical` must not be averaged down by
 * a small amount of money, and an averaging rule is how a serious thing gets sanded
 * into a moderate one.
 */
export const classifySeverity = (input: ClassifyInput): SeverityClassification => {
  const values = input.asserted;
  const proposals: SeverityBand[] = [];
  const basis: EnrichmentDimension[] = [];

  // Safety first, and on its own scale: if someone says safety was involved, no
  // amount of money or time makes that a minor experience.
  if (flagged(values, 'safety_involved')) {
    proposals.push('critical');
    basis.push('safety_involved');
  }

  const money = numeric(values, 'money_lost');
  if (money !== undefined) {
    basis.push('money_lost');
    proposals.push(
      money >= MONEY_CRITICAL
        ? 'critical'
        : money >= MONEY_SERIOUS
          ? 'serious'
          : money >= MONEY_SIGNIFICANT
            ? 'significant'
            : 'minor',
    );
  }

  const minutes = numeric(values, 'time_lost_minutes');
  if (minutes !== undefined) {
    basis.push('time_lost_minutes');
    proposals.push(
      minutes >= MINUTES_CRITICAL
        ? 'critical'
        : minutes >= MINUTES_SERIOUS
          ? 'serious'
          : minutes >= MINUTES_SIGNIFICANT
            ? 'significant'
            : 'minor',
    );
  }

  const people = numeric(values, 'people_affected');
  if (people !== undefined) {
    basis.push('people_affected');
    proposals.push(people >= PEOPLE_CRITICAL ? 'critical' : people >= PEOPLE_SERIOUS ? 'serious' : 'minor');
  }

  if (flagged(values, 'service_interrupted')) {
    proposals.push('significant');
    basis.push('service_interrupted');
  }

  // Recurrence raises a band by one step rather than setting one: "it keeps
  // happening" makes a problem worse, and says nothing on its own about how bad.
  const recurs = flagged(values, 'recurrence');
  if (recurs) basis.push('recurrence');

  const base = highest(proposals.length === 0 ? ['minor'] : proposals);
  const stepped =
    recurs && proposals.length > 0
      ? (SEVERITY_BANDS[Math.min(BAND_ORDER[base] + 1, SEVERITY_BANDS.length - 1)] ?? base)
      : base;

  const answered = new Set(basis).size;
  const confidence = Number((answered / 6).toFixed(3));

  return {
    band: stepped,
    confidence,
    basis,
    independentExperiencers: Math.max(0, Math.trunc(input.independentExperiencers)),
    // Nothing asserted means nothing classified. The band reads `minor` because a
    // band is required, and `unassessed` is what stops a reader believing it.
    unassessed: answered === 0,
  };
};

export const BAND_LABELS: Readonly<Record<SeverityBand, string>> = {
  minor: 'Minor',
  significant: 'Significant',
  serious: 'Serious',
  critical: 'Critical',
};

/**
 * Whether two classifications may be treated as equivalent.
 *
 * Exists because the Phase 32 certification is a negative: equal Re-Rage volume with
 * different asserted impact must not collapse into one thing anywhere. Ranking,
 * prioritisation and alerting all consult this rather than comparing volumes.
 */
export const areComparable = (left: SeverityClassification, right: SeverityClassification): boolean =>
  left.band === right.band && left.unassessed === right.unassessed;
