import { measure, type Measure } from './sampling.ts';

/**
 * Phase 56 — reputation evolution.
 *
 * Phase 15 answers "where does this person stand". Nothing answered "and which way
 * is it going", which is the question a moderator actually has when they open a
 * profile: a contributor whose evidence has been found consistent four times running
 * is not the same as one whose last four were inconclusive, and a single count cannot
 * tell them apart.
 *
 * **No raw popularity score.** No shares, no views, no reactions — the same rule that
 * governs every reputation read in the system, restated here because a *series* is
 * where somebody would be tempted to add engagement as a trend line.
 *
 * **No single opaque score.** Each component evolves on its own and is reported on
 * its own. Where a number would be published, every part of it is named and
 * separately readable; a composite that could be sorted would turn a profile into a
 * leaderboard, which is the thing the absent public trust score already refuses.
 * `evolutionCompositeScore()` returns `undefined` and says so.
 *
 * **Replayable.** Every point is a cumulative count over timestamped rows, so
 * recomputing from the log in any order gives the same series. That is what makes
 * evolution *derived* rather than accumulated: an accumulated series drifts the first
 * time a delivery is duplicated or arrives late, and nobody notices, because a series
 * that only ever goes up looks correct.
 */

/** The named things that evolve. There is no aggregate of these. */
export type EvolutionComponent =
  | 'experiences_published'
  | 'corroborated_experiences'
  | 'corroborations_given'
  | 'consistent_evidence'
  | 'approval_rate';

export const EVOLUTION_COMPONENTS: readonly EvolutionComponent[] = [
  'experiences_published',
  'corroborated_experiences',
  'corroborations_given',
  'consistent_evidence',
  'approval_rate',
];

export type EvolutionDirection = 'rising' | 'falling' | 'steady';

export interface EvolutionPoint {
  readonly asOf: number;
  /** Cumulative as of `asOf`. A count of the person's own facts, never a rate. */
  readonly value: number;
}

export interface ComponentSeries {
  readonly component: EvolutionComponent;
  readonly points: readonly EvolutionPoint[];
  readonly direction: EvolutionDirection;
}

/**
 * The approval-rate component is the one derived from *other people's* votes, so it
 * carries a floor and is a `Measure` rather than a number. The rest are counts of
 * what this person did, which need no floor: a person's own three contributions are
 * not a sample of anybody.
 */
export interface ApprovalSeries {
  readonly component: 'approval_rate';
  readonly points: readonly { readonly asOf: number; readonly value: Measure<number> }[];
  /** Withheld until enough points clear their floors to compare two of them. */
  readonly direction?: EvolutionDirection;
}

export interface ReputationEvolution {
  readonly actorId: string;
  readonly counts: readonly ComponentSeries[];
  readonly approval: ApprovalSeries;
}

/** A movement smaller than this is not a direction. */
export const EVOLUTION_STEADY_BAND = 0.05;

export const directionOf = (points: readonly { readonly value: number }[]): EvolutionDirection => {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined || points.length < 2) return 'steady';
  const delta = last.value - first.value;
  const width = Math.max(Math.abs(first.value) * EVOLUTION_STEADY_BAND, Number.EPSILON);
  if (Math.abs(delta) <= width) return 'steady';
  return delta > 0 ? 'rising' : 'falling';
};

/**
 * Cumulative count of timestamped facts as of each boundary.
 *
 * Order-independent by construction: each boundary counts the whole set rather than
 * folding over it, so a duplicated or late row changes nothing that a re-read would
 * not also change.
 */
export const cumulativeSeries = (
  component: EvolutionComponent,
  at: readonly number[],
  boundaries: readonly number[],
): ComponentSeries => {
  const points = [...boundaries]
    .sort((left, right) => left - right)
    .map((asOf) => ({ asOf, value: at.filter((moment) => moment <= asOf).length }));
  return { component, points, direction: directionOf(points) };
};

/**
 * The approval rate at each boundary, withheld where the votes behind it are too few.
 *
 * A direction is only stated when the first and last *reported* points both exist —
 * comparing a withheld point against a reported one would be comparing a number to
 * the absence of one.
 */
export const approvalSeries = (
  votes: readonly { readonly at: number; readonly inFavour: boolean }[],
  boundaries: readonly number[],
): ApprovalSeries => {
  const points = [...boundaries]
    .sort((left, right) => left - right)
    .map((asOf) => {
      const cast = votes.filter((vote) => vote.at <= asOf);
      return {
        asOf,
        value: measure('approval_rate', cast.length, () =>
          Number((cast.filter((vote) => vote.inFavour).length / Math.max(1, cast.length)).toFixed(4)),
        ),
      };
    });

  const reported = points.filter(
    (point): point is { asOf: number; value: Extract<Measure<number>, { withheld: false }> } =>
      point.value.withheld === false,
  );
  const first = reported[0];
  const last = reported.at(-1);
  if (first === undefined || last === undefined || reported.length < 2) {
    return { component: 'approval_rate', points };
  }
  return {
    component: 'approval_rate',
    points,
    direction: directionOf([{ value: first.value.value }, { value: last.value.value }]),
  };
};

/**
 * Deliberately absent: one number for a person.
 *
 * Not zero, not hidden behind a flag — absent, because a field at zero is one edit
 * away from being non-zero and a sortable reputation number is a leaderboard whatever
 * it is called.
 */
export const evolutionCompositeScore = (): undefined => undefined;

/** Also absent: any engagement input. Named so a reader looking for it finds the answer. */
export const EXCLUDED_FROM_EVOLUTION: readonly string[] = [
  'shares',
  'views',
  'reactions',
  'followers',
  'impressions',
];
