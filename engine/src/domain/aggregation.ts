import { measure, type Measure, type MeasureKind } from './sampling.ts';

/**
 * Benchmark-safe aggregation — Phase 39, E11.
 *
 * An aggregate that compares organizations is the most re-identifying thing this
 * system could publish, and the danger is not the obvious case. The obvious case — one
 * complaint, one aggregate — is caught by any sample floor. The dangerous cases are:
 *
 *   1. **A group with enough rows but too few people.** Twenty accounts from three
 *      people is not twenty people's experience, and a median over it describes three
 *      people who can be named by anyone who knows them.
 *   2. **Differencing.** "All regions" minus "every region but one" is that one
 *      region. Two aggregates that are individually safe can be subtracted, so a
 *      group is refused when it differs from its parent by fewer than the person
 *      floor — which is what makes the subtraction uninformative.
 *
 * So there are two floors, and both must clear: rows (Phase 38's sample floor) and
 * *distinct contributors*. Small cells are **suppressed, not rounded**: rounding a
 * count of 2 to "fewer than 5" still says somebody is there, and in a group of one
 * organization that is an identification.
 */
export const MINIMUM_DISTINCT_CONTRIBUTORS = 5;

export interface AggregateInput<T> {
  readonly kind: MeasureKind;
  /** Rows in this group. */
  readonly sampleSize: number;
  /** Distinct people who contributed them. Never inferred from `sampleSize`. */
  readonly distinctContributors: number;
  /**
   * The group this one was cut from, when it is a subset. Supplied so the
   * differencing check can run; omitted for a top-level group.
   */
  readonly parentDistinctContributors?: number | undefined;
  readonly compute: () => T;
}

export type SuppressionReason = 'too_few_rows' | 'too_few_people' | 'differencing_risk';

export interface Suppressed {
  readonly suppressed: true;
  readonly reason: SuppressionReason;
  /** Said plainly so a surface can explain the gap rather than show a blank. */
  readonly explanation: string;
}

export interface Published<T> {
  readonly suppressed: false;
  readonly measure: Measure<T>;
  readonly distinctContributors: number;
}

export type Aggregate<T> = Suppressed | Published<T>;

const EXPLANATIONS: Readonly<Record<SuppressionReason, string>> = {
  too_few_rows: 'Not enough accounts in this group to describe a pattern.',
  too_few_people: 'Not enough different people in this group to report it without identifying them.',
  differencing_risk:
    'This group is too close in size to the one it was cut from — reporting both would reveal the difference.',
};

const suppress = (reason: SuppressionReason): Suppressed => ({
  suppressed: true,
  reason,
  explanation: EXPLANATIONS[reason],
});

export const aggregate = <T>(input: AggregateInput<T>): Aggregate<T> => {
  const people = Math.max(0, Math.trunc(input.distinctContributors));

  // People first. A group can clear the row floor on volume from a handful of
  // contributors, and the row floor would happily pass it.
  if (people < MINIMUM_DISTINCT_CONTRIBUTORS) return suppress('too_few_people');

  const computed = measure(input.kind, input.sampleSize, input.compute);
  if (computed.withheld) return suppress('too_few_rows');

  // Differencing. A subset whose contributor count is within the person floor of its
  // parent's leaves a remainder small enough to identify, even though both aggregates
  // pass their own floors.
  if (input.parentDistinctContributors !== undefined) {
    const remainder = Math.max(0, Math.trunc(input.parentDistinctContributors) - people);
    if (remainder > 0 && remainder < MINIMUM_DISTINCT_CONTRIBUTORS) {
      return suppress('differencing_risk');
    }
  }

  return { suppressed: false, measure: computed, distinctContributors: people };
};

/**
 * Whether a set of aggregates may be published together.
 *
 * Individually-safe aggregates can be unsafe as a set: if every sibling but one is
 * published alongside the parent, the missing one is arithmetic. Checked over the
 * whole set rather than per aggregate, because that is the only level at which the
 * property exists.
 */
export const publishableTogether = <T>(
  parentDistinctContributors: number,
  siblings: readonly { readonly distinctContributors: number; readonly published: boolean }[],
): boolean => {
  const shown = siblings.filter((sibling) => sibling.published);
  if (shown.length === 0) return true;
  const hidden = siblings.filter((sibling) => !sibling.published);
  if (hidden.length === 0) return true;
  const shownPeople = shown.reduce((total, sibling) => total + sibling.distinctContributors, 0);
  const remainder = Math.max(0, parentDistinctContributors - shownPeople);
  // Exactly one hidden sibling and a recoverable remainder is the differencing attack
  // in its simplest form.
  if (hidden.length === 1 && remainder > 0 && remainder < MINIMUM_DISTINCT_CONTRIBUTORS) return false;
  return true;
};
