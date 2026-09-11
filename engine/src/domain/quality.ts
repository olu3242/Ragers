import { measure, type Measure } from './sampling.ts';

/**
 * Phases 84 and 85 — response quality, and resolution quality.
 *
 * ## Why these are not the measures that already exist
 *
 * `responsiveness_snapshots` measures **timing**: medians to acknowledgement, first
 * response and resolution, plus rates, all floored and all withheld below their sample
 * size. It is correct and it answers a different question.
 *
 * **Timing is not quality.** Answering within the hour and doing nothing is fast and bad,
 * and a responsiveness figure cannot tell that from fast and good. Collapsing the two
 * would make a form-letter operation look like a well-run one — and worse, it would tell
 * organizations that the way to score well is to reply quickly, which is the one lesson
 * this product must not teach.
 *
 * The same distinction runs through `resolutionFromReports`, which decides **whether**
 * something is resolved. **`resolved != well resolved`.** A resolution that the people it
 * happened to disputed, or that recurred a month later, is resolved and was not resolved
 * well. Those are different facts about the same event and a single status cannot hold
 * both.
 *
 * ## Named dimensions, never a score
 *
 * Both measures return dimensions with directions and a band, in the shape Phase 43 uses
 * for priority and Phase 81 uses for confidence. The reason is the same each time: a
 * quality *score* beside a company's name is a judgement, it invites comparison nobody
 * intended, and its weights live in arithmetic nobody can argue with.
 *
 * And neither is a ranking. Phase 75 refused a league table of organizations for reasons
 * that apply here with more force, because a quality table would be more plausible and
 * therefore more used.
 */

// ── Phase 84: did the response do anything? ──────────────────────────────

/** The dimensions of a response's quality. Each is a fact about what happened. */
export type ResponseDimension =
  /** Did they acknowledge at all? Distinct from how fast. */
  | 'acknowledged'
  /** Did they describe an action, as opposed to describing a policy? */
  | 'action_described'
  /** Did the people it happened to accept the outcome? */
  | 'outcome_accepted'
  /** Did the same thing happen again afterwards? */
  | 'recurrence'
  /** Is anything still open and getting older? */
  | 'aging_open';

export const RESPONSE_DIMENSIONS: readonly ResponseDimension[] = [
  'acknowledged',
  'action_described',
  'outcome_accepted',
  'recurrence',
  'aging_open',
];

export type QualityBand = 'insufficient' | 'poor' | 'mixed' | 'good';

export const QUALITY_BANDS: readonly QualityBand[] = ['insufficient', 'poor', 'mixed', 'good'];

export interface QualityReason {
  readonly dimension: string;
  readonly direction: 'raises' | 'lowers' | 'neutral';
  readonly detail: string;
}

export interface ResponseQualityInput {
  /** Cases in the window. The sample the floor applies to. */
  readonly cases: number;
  readonly acknowledged: number;
  /** Responses that described an action taken, rather than a position held. */
  readonly actionDescribed: number;
  /** Of the outcomes reported by experiencers, how many said resolved. */
  readonly outcomesAccepted: number;
  readonly outcomesReported: number;
  /** Experiences in the same cluster that arrived *after* a resolution was claimed. */
  readonly recurrences: number;
  /** Cases still open past the aging threshold. */
  readonly agingOpen: number;
}

export interface ResponseQuality {
  readonly band: QualityBand;
  readonly reasons: readonly QualityReason[];
  readonly sampleSize: number;
}

/**
 * Response quality, floored.
 *
 * The floor is `responsiveness`'s, deliberately shared: both measures describe an
 * organization from a set of cases, and a quality read over four cases is as misleading as
 * a median over four. Below it the band is `insufficient` — not `poor`, because "we do not
 * know" and "they are bad at this" are opposite statements and the second is defamatory.
 */
export const assessResponseQuality = (input: ResponseQualityInput): ResponseQuality => {
  const reasons: QualityReason[] = [];

  const ackRate = input.cases === 0 ? 0 : input.acknowledged / input.cases;
  reasons.push({
    dimension: 'acknowledged',
    direction: ackRate >= 0.8 ? 'raises' : ackRate >= 0.4 ? 'neutral' : 'lowers',
    detail: `${input.acknowledged} of ${input.cases} case(s) were acknowledged`,
  });

  // The dimension that separates this from responsiveness. A reply is not an action.
  const actionRate = input.cases === 0 ? 0 : input.actionDescribed / input.cases;
  reasons.push({
    dimension: 'action_described',
    direction: actionRate >= 0.5 ? 'raises' : actionRate > 0 ? 'neutral' : 'lowers',
    detail:
      input.actionDescribed === 0
        ? 'no response described an action taken'
        : `${input.actionDescribed} response(s) described something done`,
  });

  // Acceptance is the experiencers' verdict, and it is the only one that decides whether a
  // thing was resolved. An organization saying so is a claim; this is the answer.
  reasons.push({
    dimension: 'outcome_accepted',
    direction:
      input.outcomesReported === 0
        ? 'neutral'
        : input.outcomesAccepted / input.outcomesReported >= 0.6
          ? 'raises'
          : 'lowers',
    detail:
      input.outcomesReported === 0
        ? 'nobody has reported an outcome yet'
        : `${input.outcomesAccepted} of ${input.outcomesReported} reported outcome(s) said it was resolved`,
  });

  reasons.push({
    dimension: 'recurrence',
    direction: input.recurrences > 0 ? 'lowers' : 'neutral',
    detail:
      input.recurrences > 0
        ? `${input.recurrences} account(s) of the same thing arrived after a resolution was claimed`
        : 'nothing recurred after a resolution was claimed',
  });

  reasons.push({
    dimension: 'aging_open',
    direction: input.agingOpen > 0 ? 'lowers' : 'neutral',
    detail:
      input.agingOpen > 0
        ? `${input.agingOpen} case(s) are still open and getting older`
        : 'nothing is sitting open',
  });

  const lowered = reasons.filter((reason) => reason.direction === 'lowers').length;
  const raised = reasons.filter((reason) => reason.direction === 'raises').length;

  return {
    band: ((): QualityBand => {
      // A fast non-answer must not read as good. Acknowledging everything and doing nothing
      // gives one raise and one lower, which lands at `mixed` — never `good`.
      if (input.actionDescribed === 0 && input.cases > 0) return lowered >= 2 ? 'poor' : 'mixed';
      if (lowered === 0 && raised >= 3) return 'good';
      if (lowered >= 3) return 'poor';
      return 'mixed';
    })(),
    reasons,
    sampleSize: input.cases,
  };
};

/** The band as a `Measure`, so a surface cannot show it below the floor. */
export const responseQualityMeasure = (quality: ResponseQuality): Measure<QualityBand> =>
  measure('responsiveness', quality.sampleSize, () => quality.band);

// ── Phase 85: was it resolved *well*? ────────────────────────────────────

export type ResolutionDimension =
  /** Did the people it happened to accept it? */
  | 'acceptance'
  /** Was it partial rather than complete? */
  | 'completeness'
  /** Was it disputed after being called resolved? */
  | 'disputed'
  /** Did it happen again? */
  | 'recurrence'
  /** Was there any follow-up, or did it go quiet? */
  | 'follow_up'
  /** Was anything openable attached to the claim? */
  | 'evidence';

export const RESOLUTION_DIMENSIONS: readonly ResolutionDimension[] = [
  'acceptance',
  'completeness',
  'disputed',
  'recurrence',
  'follow_up',
  'evidence',
];

export interface ResolutionQualityInput {
  /** Whether the aggregate status says resolved. The *input*, not the answer. */
  readonly statusResolved: boolean;
  readonly reportsResolved: number;
  readonly reportsPartial: number;
  readonly reportsUnresolved: number;
  /** Open or upheld disputes about this experience. */
  readonly openDisputes: number;
  readonly upheldDisputes: number;
  readonly recurrences: number;
  readonly followUpResponses: number;
  readonly evidenceAttached: number;
}

export interface ResolutionQuality {
  readonly band: QualityBand;
  readonly reasons: readonly QualityReason[];
  /** Reported alongside, so `resolved` and `well resolved` are visibly two facts. */
  readonly statusResolved: boolean;
  readonly sampleSize: number;
}

/**
 * Resolution quality.
 *
 * `statusResolved` is an *input* and is carried through to the output beside the band, so a
 * reader sees both facts at once. A resolution that is disputed reads as
 * `resolved: true, band: poor`, which is the honest shape — and it is the shape a single
 * status field cannot express, which is why this phase exists.
 */
export const assessResolutionQuality = (input: ResolutionQualityInput): ResolutionQuality => {
  const reasons: QualityReason[] = [];
  const reports = input.reportsResolved + input.reportsPartial + input.reportsUnresolved;

  reasons.push({
    dimension: 'acceptance',
    direction:
      reports === 0 ? 'neutral' : input.reportsResolved / reports >= 0.6 ? 'raises' : 'lowers',
    detail:
      reports === 0
        ? 'nobody it happened to has reported an outcome'
        : `${input.reportsResolved} of ${reports} said it was resolved for them`,
  });

  reasons.push({
    dimension: 'completeness',
    direction: input.reportsPartial > 0 ? 'lowers' : 'neutral',
    detail:
      input.reportsPartial > 0
        ? `${input.reportsPartial} said it was only partly resolved`
        : 'nobody reported a partial resolution',
  });

  // A dispute after a claimed resolution is the strongest single negative here, because it
  // is somebody with standing saying the account of what happened is wrong.
  reasons.push({
    dimension: 'disputed',
    direction: input.openDisputes + input.upheldDisputes > 0 ? 'lowers' : 'neutral',
    detail:
      input.upheldDisputes > 0
        ? `${input.upheldDisputes} dispute(s) were upheld`
        : input.openDisputes > 0
          ? `${input.openDisputes} dispute(s) are open`
          : 'nothing is disputed',
  });

  reasons.push({
    dimension: 'recurrence',
    direction: input.recurrences > 0 ? 'lowers' : 'neutral',
    detail:
      input.recurrences > 0
        ? `${input.recurrences} account(s) of the same thing arrived afterwards`
        : 'it has not happened again',
  });

  reasons.push({
    dimension: 'follow_up',
    direction: input.followUpResponses > 0 ? 'raises' : 'neutral',
    detail:
      input.followUpResponses > 0
        ? `${input.followUpResponses} follow-up response(s)`
        : 'no follow-up after the resolution was claimed',
  });

  reasons.push({
    dimension: 'evidence',
    direction: input.evidenceAttached > 0 ? 'raises' : 'neutral',
    detail:
      input.evidenceAttached > 0
        ? `${input.evidenceAttached} openable reference(s) attached`
        : 'nothing openable was attached, which is normal',
  });

  const lowered = reasons.filter((reason) => reason.direction === 'lowers').length;

  return {
    band: ((): QualityBand => {
      if (reports === 0) return 'insufficient';
      // **`resolved` + disputed is never good.** The single most important rule in this
      // module: a status of resolved with a dispute against it is a contested account, and
      // a surface that showed it as a success would be taking one party's word for it.
      if (input.openDisputes + input.upheldDisputes > 0) return lowered >= 2 ? 'poor' : 'mixed';
      if (input.recurrences > 0) return 'poor';
      if (input.reportsPartial > 0) return 'mixed';
      if (lowered === 0 && input.reportsResolved > 0) return 'good';
      return lowered >= 2 ? 'poor' : 'mixed';
    })(),
    reasons,
    statusResolved: input.statusResolved,
    sampleSize: reports,
  };
};

/** Which dimension decided the band. */
export const explainQuality = (quality: ResponseQuality | ResolutionQuality): string => {
  if (quality.band === 'insufficient') return 'not enough has been reported to say';
  const lowered = quality.reasons.filter((reason) => reason.direction === 'lowers');
  if (lowered.length > 0) return lowered.map((reason) => reason.detail).join('; ');
  return quality.reasons
    .filter((reason) => reason.direction === 'raises')
    .map((reason) => reason.detail)
    .join('; ');
};

/**
 * The absences, as code.
 *
 * `qualityIsAScore` — bands and dimensions, never a number. `qualityRanksOrganizations` —
 * Phase 75 refused a league table for organizations and this one would be more plausible
 * and therefore more used. `qualityReadsTrustScore` — quality is about what an organization
 * did, and a per-person trust figure has no place in it.
 */
export const qualityIsAScore = (): false => false;
export const qualityRanksOrganizations = (): undefined => undefined;
export const qualityReadsTrustScore = (): false => false;
