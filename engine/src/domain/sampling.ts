/**
 * Minimum-sample and confidence floors — Phase 38, E4.
 *
 * One policy, consulted by every reader. The alternative — a `MINIMUM_SAMPLE` beside
 * each surface — is how two pages come to disagree about whether the same number is
 * safe to show, and how the third page ships without a floor at all.
 *
 * The rule the whole band rests on: **a measure withheld beats a measure invented.**
 * Below its floor a measure is not shown small, rounded, hedged or estimated. It says
 * *not enough yet* and how far off it is.
 *
 * The type enforces that rather than trusting a caller to check a boolean. A
 * `Measure<T>` only carries `value` in the branch where `withheld` is `false`, so
 * rendering a withheld measure is a type error rather than a habit somebody has to
 * remember. That is deliberate: the failure mode being prevented is not
 * carelessness, it is a reasonable person reading `value ?? 0` and shipping a zero
 * that means "we do not know".
 */
export type MeasureKind =
  | 'responsiveness'
  | 'resolution_rate'
  | 'approval_rate'
  | 'severity_distribution'
  | 'benchmark';

/**
 * Floors, per kind.
 *
 * They differ because the harm differs. A responsiveness median over four cases
 * describes four cases, not an organization. A benchmark is a comparison *between*
 * parties, so it needs enough contributors that no single one is recoverable from it —
 * which is why its floor is the highest here and why Phase 39 adds a distinct-person
 * floor on top of it.
 */
export const SAMPLE_FLOORS: Readonly<Record<MeasureKind, number>> = {
  responsiveness: 5,
  resolution_rate: 5,
  approval_rate: 5,
  severity_distribution: 5,
  benchmark: 20,
};

export interface Withheld {
  readonly withheld: true;
  readonly sampleSize: number;
  readonly floor: number;
  /** How many more are needed. Said out loud so the caption can be specific. */
  readonly shortBy: number;
}

export interface Reported<T> {
  readonly withheld: false;
  readonly value: T;
  readonly sampleSize: number;
  readonly floor: number;
}

export type Measure<T> = Withheld | Reported<T>;

export const floorFor = (kind: MeasureKind): number => SAMPLE_FLOORS[kind];

/**
 * Compute a measure, or withhold it.
 *
 * `compute` is a thunk rather than a value so a caller does not do the arithmetic it
 * is not allowed to show. Passing an already-computed number would work, and would
 * mean the forbidden figure exists in a variable one console.log away from a surface.
 */
export const measure = <T>(kind: MeasureKind, sampleSize: number, compute: () => T): Measure<T> => {
  const floor = floorFor(kind);
  const size = Math.max(0, Math.trunc(sampleSize));
  if (size < floor) {
    return { withheld: true, sampleSize: size, floor, shortBy: floor - size };
  }
  return { withheld: false, value: compute(), sampleSize: size, floor };
};

/**
 * The caption for a withheld measure, in one voice everywhere.
 *
 * Centralised for the same reason the floors are: three surfaces writing their own
 * wording is three different implied promises about what the silence means.
 */
export const withheldCaption = (withheldMeasure: Withheld, noun = 'cases'): string =>
  `Too few ${noun} to describe a pattern yet (${withheldMeasure.sampleSize} of ${withheldMeasure.floor}).`;

/**
 * A withheld measure rendered for transport.
 *
 * `value` is deliberately absent rather than `null` or `0`. A JSON consumer doing
 * `value ?? 0` on a withheld measure would publish a zero that means "we do not
 * know" — and a zero response rate is a serious accusation to make by accident.
 */
export const toPayload = <T>(m: Measure<T>): Readonly<Record<string, unknown>> =>
  m.withheld
    ? { withheld: true, sampleSize: m.sampleSize, floor: m.floor, shortBy: m.shortBy }
    : { withheld: false, value: m.value, sampleSize: m.sampleSize, floor: m.floor };
