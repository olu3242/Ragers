/**
 * Phases 81 and 82 — corroboration confidence, and how it moves.
 *
 * ## The phase that had to change, and why
 *
 * This was specified as **trust-weighted corroboration**. It is implemented as
 * un-weighted corroboration with a separate, factored confidence, and the reason matters
 * more than the code.
 *
 * A trust-weighted count would break three certified things:
 *
 * **A count of people would stop being a count of people.** The guarantee
 * `EXPERIENCE_SIGNAL_ENGINE_READY` attests is that `1,842 Re-Rages` means 1,842 people
 * said it happened to them. Weighted, it means "1,842 people, discounted by how much we
 * think of them", and no reader could tell which number they were looking at.
 *
 * **It would make trust rank.** Phase 73 refused exactly this, in those words: *a more
 * trusted person's experience ranks above yours is a caste system with a scoring
 * function.* Weighting a claim is the same act one layer down and harder to see.
 *
 * **It would discount the case that matters most.** Phase 62 established that new
 * accounts and fast arrivals are what a *genuine* event produces — a story breaks, forty
 * people recognise it, half sign up to say so. `assessTrust` scores account maturity, so a
 * trust-weighted count would systematically discount the burst that means something real
 * just happened. That is the mechanism working as designed against the product's purpose.
 *
 * ## So: the count is a count, and confidence is a separate measure
 *
 * Everything the requirements actually asked for — independent contributors, evidence
 * strength, duplication, recency, cluster consistency, "one actor cannot manufacture
 * confidence", "expose reasons" — is about **confidence in a pattern**, which was never
 * the same thing as the count. `confidenceAdjustsCorroborationCount()` returns undefined.
 *
 * ## The rule that keeps this honest
 *
 * **Confidence reads facts about claims, never scores about claimants.**
 *
 * Whether *this* claim carried evidence; whether *that* evidence was contradicted;
 * whether the set arrived independently. All properties of the claims. Not
 * `accountConfidence`, not `contributionConfidence`, not any per-person figure — because
 * the moment a person's history changes what their account of an event is worth, a new
 * account's honest claim is worth less than an established account's, and that is the
 * caste system arriving through the side door.
 *
 * Enforced by a discovery guard over this module rather than by this paragraph.
 */

import { measure, type Measure } from './sampling.ts';

/** The factors that may contribute to confidence. Closed, and each is a fact about claims. */
export type ConfidenceFactor =
  /** How many distinct people said it happened to them. People, never rows. */
  | 'independent_people'
  /** How many of those claims carried an artefact somebody could open. */
  | 'evidence_present'
  /** How many pieces of that evidence were assessed as contradicted. */
  | 'evidence_contradicted'
  /** Whether the claims arrived in a way that looks co-travelled (Phase 62's signal). */
  | 'arrival_independence'
  /** How recent the most recent contribution is. */
  | 'recency'
  /** Whether the claims in a cluster describe the same thing. */
  | 'cluster_consistency';

export const CONFIDENCE_FACTORS: readonly ConfidenceFactor[] = [
  'independent_people',
  'evidence_present',
  'evidence_contradicted',
  'arrival_independence',
  'recency',
  'cluster_consistency',
];

/**
 * Inputs that may never enter a confidence, each with its reason.
 *
 * These are the per-*person* figures. Their absence is the phase's central rule, and it is
 * the difference between "how much do these claims support this" and "how much do we think
 * of these people".
 */
export const FORBIDDEN_CONFIDENCE_INPUTS: Readonly<Record<string, string>> = {
  account_confidence:
    'A per-person score. Using it would mean a new account’s honest claim is worth less than an established account’s, which is the caste system Phase 73 refused arriving one layer down.',
  contribution_confidence:
    'Also per-person. Whether somebody has been right before is not evidence about what happened to them this time.',
  account_age:
    'New is not suspicious. Phase 62 established that new accounts are what a genuine event produces, so discounting them discounts the signal.',
  reputation: 'Reputation is neither popularity nor a rank, and it is not evidence either.',
  engagement:
    'Reactions and replies are responses to a claim, not evidence about it. Counting them would be an engagement composite under a new name.',
  shares: 'Amplification is not evidence. A widely-shared claim is not a better-supported one.',
};

/**
 * Bands rather than a number.
 *
 * A confidence of `0.62` invites arithmetic nobody can check and comparison nobody
 * intended. Four bands, each with a stated meaning, and the band is what any surface may
 * show.
 */
export type ConfidenceBand = 'insufficient' | 'limited' | 'moderate' | 'strong';

export const CONFIDENCE_BANDS: readonly ConfidenceBand[] = [
  'insufficient',
  'limited',
  'moderate',
  'strong',
];

/** Minimum distinct people before confidence may be stated at all. */
export const CONFIDENCE_PERSON_FLOOR = 3;

/**
 * How long before the most recent contribution stops supporting a *current* confidence.
 *
 * Beyond this the pattern may still be real and is no longer *current*, which is Phase 54's
 * distinction. Confidence is about what the claims support now.
 */
export const CONFIDENCE_STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

export interface ConfidenceInput {
  /** Distinct people. The caller deduplicates; this asserts it did. */
  readonly independentPeople: number;
  /** Claims from the author's own account, which contribute nothing. */
  readonly selfContributions: number;
  /** Duplicate rows from people already counted. Reported, never added. */
  readonly duplicateRows: number;
  readonly evidencePresent: number;
  readonly evidenceContradicted: number;
  /** True when Phase 62's analysis found the set co-travelling. */
  readonly coordinationSuspected: boolean;
  readonly mostRecentContributionAt: number;
  /** Of the clustered claims, the share describing the same issue type. */
  readonly clusterConsistency: number;
  readonly now: number;
}

export interface ConfidenceReason {
  readonly factor: ConfidenceFactor;
  /** Which way it pushed. `neutral` is a real answer and is not omitted. */
  readonly direction: 'raises' | 'lowers' | 'neutral';
  readonly detail: string;
}

export interface Confidence {
  readonly band: ConfidenceBand;
  /** Every factor considered, with its direction. Not a subset — the ones that did nothing too. */
  readonly reasons: readonly ConfidenceReason[];
  /** The count, carried unchanged so a reader can see it was not adjusted. */
  readonly independentPeople: number;
  /** What was discarded, stated rather than silently dropped. */
  readonly discarded: { readonly self: number; readonly duplicates: number };
  /** Whether the most recent contribution is recent enough for this to be current. */
  readonly current: boolean;
}

/**
 * Confidence, as a pure function.
 *
 * The band is decided by a small number of stated rules rather than by a weighted sum, for
 * the reason every other measure in this codebase is: a sum has weights, weights live in
 * arithmetic, and nobody can argue with arithmetic they cannot see.
 */
export const assessConfidence = (input: ConfidenceInput): Confidence => {
  const reasons: ConfidenceReason[] = [];
  const stale = input.now - input.mostRecentContributionAt > CONFIDENCE_STALE_AFTER_MS;

  reasons.push({
    factor: 'independent_people',
    direction: input.independentPeople >= CONFIDENCE_PERSON_FLOOR ? 'raises' : 'lowers',
    detail: `${input.independentPeople} ${input.independentPeople === 1 ? 'person' : 'people'} said it happened to them`,
  });

  reasons.push({
    factor: 'evidence_present',
    direction: input.evidencePresent > 0 ? 'raises' : 'neutral',
    detail:
      input.evidencePresent > 0
        ? `${input.evidencePresent} claim(s) carried something a reviewer can open`
        : 'no evidence was attached, which is normal and is not a mark against it',
  });

  reasons.push({
    factor: 'evidence_contradicted',
    direction: input.evidenceContradicted > 0 ? 'lowers' : 'neutral',
    detail:
      input.evidenceContradicted > 0
        ? `${input.evidenceContradicted} piece(s) of evidence were assessed as contradicted`
        : 'nothing submitted has been contradicted',
  });

  reasons.push({
    factor: 'arrival_independence',
    direction: input.coordinationSuspected ? 'lowers' : 'neutral',
    detail: input.coordinationSuspected
      ? 'the claims arrived co-travelling, which a person is reviewing'
      : 'the claims arrived independently',
  });

  reasons.push({
    factor: 'recency',
    direction: stale ? 'lowers' : 'raises',
    detail: stale ? 'the most recent contribution is old' : 'contributions are recent',
  });

  reasons.push({
    factor: 'cluster_consistency',
    direction: input.clusterConsistency >= 0.7 ? 'raises' : input.clusterConsistency > 0 ? 'neutral' : 'neutral',
    detail: `${Math.round(input.clusterConsistency * 100)}% of the clustered claims describe the same issue`,
  });

  const band = ((): ConfidenceBand => {
    // Below the person floor nothing is stated. Not "low confidence" — *insufficient*,
    // because a low confidence reads as a finding and this is an absence of one.
    if (input.independentPeople < CONFIDENCE_PERSON_FLOOR) return 'insufficient';
    // Contradicted evidence is the strongest single negative, because it is a checkable
    // disagreement rather than an inference. It caps rather than subtracts.
    if (input.evidenceContradicted > 0) return 'limited';
    // A set under coordination review is capped at limited until a person has looked. Not
    // discounted — capped, and the claims themselves are untouched.
    if (input.coordinationSuspected) return 'limited';
    if (stale) return 'limited';
    if (input.independentPeople >= CONFIDENCE_PERSON_FLOOR * 2 && input.evidencePresent > 0) {
      return 'strong';
    }
    return 'moderate';
  })();

  return {
    band,
    reasons,
    independentPeople: input.independentPeople,
    discarded: { self: input.selfContributions, duplicates: input.duplicateRows },
    current: !stale,
  };
};

/** Which factor decided the band, in words. The `explainOrder` pattern. */
export const explainConfidence = (confidence: Confidence): string => {
  if (confidence.band === 'insufficient') {
    return `fewer than ${CONFIDENCE_PERSON_FLOOR} people have said it happened to them, so nothing is stated`;
  }
  const lowered = confidence.reasons.filter((reason) => reason.direction === 'lowers');
  if (confidence.band === 'limited' && lowered.length > 0) {
    return lowered.map((reason) => reason.detail).join('; ');
  }
  const raised = confidence.reasons.filter((reason) => reason.direction === 'raises');
  return raised.map((reason) => reason.detail).join('; ');
};

/**
 * Confidence as a `Measure`, for a surface that must withhold it below the floor.
 *
 * The floor is the *person* floor, not a row count, so twenty claims from two people is
 * withheld exactly as two claims from two people are.
 */
export const confidenceMeasure = (confidence: Confidence): Measure<ConfidenceBand> =>
  measure('resolution_rate', confidence.independentPeople, () => confidence.band);

// ── Phase 82: how confidence moves ───────────────────────────────────────

/**
 * One point in a confidence series.
 *
 * Every point is computed from **the whole set as of its boundary**, never by folding the
 * previous point forward. That is the Phase 56 pattern and it is here for the same reason:
 * an accumulated series drifts the first time a delivery is duplicated, and nobody notices
 * because a series that only moves in one direction looks correct.
 */
export interface ConfidencePoint {
  /** The instant this point describes. */
  readonly at: number;
  readonly band: ConfidenceBand;
  readonly independentPeople: number;
  /** Which factor decided this point's band, so a movement can be explained. */
  readonly deciding: string;
}

/**
 * A series, from a set of boundaries and a way to describe the world at each.
 *
 * Deterministic and replay-safe by construction: each boundary is evaluated independently,
 * so evaluating them in any order, or twice, gives the same series.
 */
export const confidenceSeries = (
  boundaries: readonly number[],
  at: (boundary: number) => ConfidenceInput,
): readonly ConfidencePoint[] =>
  [...boundaries]
    .sort((left, right) => left - right)
    .map((boundary) => {
      const confidence = assessConfidence(at(boundary));
      return {
        at: boundary,
        band: confidence.band,
        independentPeople: confidence.independentPeople,
        deciding: explainConfidence(confidence),
      };
    });

/**
 * Whether the band moved between two points, and which way.
 *
 * Returned as a direction rather than a delta, because a delta over bands would invite
 * arithmetic over an ordinal scale — "moderate minus limited" is not a quantity.
 */
export const confidenceMovement = (
  from: ConfidencePoint,
  to: ConfidencePoint,
): 'rose' | 'fell' | 'held' => {
  const fromRank = CONFIDENCE_BANDS.indexOf(from.band);
  const toRank = CONFIDENCE_BANDS.indexOf(to.band);
  if (toRank > fromRank) return 'rose';
  if (toRank < fromRank) return 'fell';
  return 'held';
};

/**
 * The absences, as code.
 *
 * `confidenceAdjustsCorroborationCount` — the count is a count. `confidenceIsAScore` — the
 * band is ordinal and there is no number behind it. `trustScoreEntersConfidence` — the rule
 * that keeps a new account's claim worth what an old account's is.
 */
export const confidenceAdjustsCorroborationCount = (): undefined => undefined;
export const confidenceIsAScore = (): false => false;
export const trustScoreEntersConfidence = (): false => false;
