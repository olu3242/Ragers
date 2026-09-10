/**
 * The order personalization runs in — E1, Phase 86.
 *
 * Phase 74 built the profile and Phases 71–73 built the reads. What was never stated is the
 * **order**, and the order is the whole safety property:
 *
 * ```
 * eligibility → personalization → ordering
 * ```
 *
 * Eligibility decides what a person *may* see. Personalization decides which of those to
 * show. Ordering decides the sequence. Reversing the first two turns a preference into a
 * permission — and the failure is quiet, because a personalized feed that leaks looks exactly
 * like a personalized feed.
 *
 * ## Why this needed a module rather than a comment
 *
 * The ordering was already correct by accident: `discoverForActor` composed `discover` calls,
 * and `discover` re-checked status, so nothing could be personalized into visibility. Correct
 * by accident is the state a refactor ends.
 *
 * It was also **incomplete**, which is what writing this down found. `discover` has no viewer,
 * so it can check whether an experience is published and cannot check whether *this* person is
 * permitted to see it. `isBlockedBetween` carried the comment "Consulted on every read path"
 * and was consulted on exactly one — notifications. So somebody's blocked author's accounts
 * were served straight into their personalized feed. The eligibility stage existed; it had no
 * viewer.
 *
 * ## Why eligibility must not read the profile
 *
 * The two stages take disjoint inputs, declared below, and a test asserts the disjointness.
 * The reason is not tidiness. If eligibility could read the profile, then "what somebody is
 * interested in" would be an input to "what somebody may see", and the two failure modes that
 * follow are both bad: a person could widen their own access by declaring an interest, or
 * lose access to something by not declaring one. Neither is a thing a preference should be
 * able to do.
 */

/** The stages, in the only order they may run in. */
export const PERSONALIZATION_STAGES = ['eligibility', 'personalization', 'ordering'] as const;

export type PersonalizationStage = (typeof PERSONALIZATION_STAGES)[number];

/**
 * What the eligibility stage may read. Facts about the content and about the relationship
 * between two people — never about taste.
 */
export const ELIGIBILITY_INPUTS = [
  'status',
  'viewer_is_author',
  'blocked_either_way',
] as const;

/**
 * What the personalization stage may read. The Phase 74 profile, and nothing else — it has no
 * access to a status or a block, because by the time it runs those decisions are made.
 */
export const PERSONALIZATION_INPUTS = [
  'followed_subject_ids',
  'authored_categories',
  'watched_experience_ids',
  'corroborated_subject_ids',
] as const;

export type EligibilityInput = (typeof ELIGIBILITY_INPUTS)[number];
export type PersonalizationInput = (typeof PERSONALIZATION_INPUTS)[number];

/** Why an experience was refused, in the vocabulary of the stage that refused it. */
export type EligibilityRefusal = 'not_published' | 'blocked';

export interface EligibilityContext {
  /** Whether the experience is in a state anybody may read. */
  readonly published: boolean;
  /** The viewer wrote it. Kept as an input because an author reads their own drafts. */
  readonly viewerIsAuthor: boolean;
  /**
   * Either direction. Blocking is not symmetric as an *act* and is symmetric as a
   * *consequence*: if I blocked you I do not want to see you, and if you blocked me you do
   * not want me reading your accounts. One predicate for both, so neither side can be
   * implemented and the other forgotten.
   */
  readonly blockedEitherWay: boolean;
}

export interface Eligibility {
  readonly permitted: boolean;
  readonly refusedBy?: EligibilityRefusal;
}

/**
 * The eligibility decision, as a pure function.
 *
 * Status first, because an unpublished experience is refused to everybody and the block check
 * costs two reads. The author exemption applies only to status: **an author cannot see past a
 * block**, in either direction, and writing the exemption narrowly is what keeps that true.
 */
export const decideEligibility = (context: EligibilityContext): Eligibility => {
  if (context.blockedEitherWay) return { permitted: false, refusedBy: 'blocked' };
  if (!context.published && !context.viewerIsAuthor) {
    return { permitted: false, refusedBy: 'not_published' };
  }
  return { permitted: true };
};

/** Why a viewer did not see something, in words, for an operator diagnosing a complaint. */
export const explainEligibility = (eligibility: Eligibility): string => {
  if (eligibility.permitted) return 'permitted';
  return eligibility.refusedBy === 'blocked'
    ? 'one of the two people has blocked the other'
    : 'the experience is not in a readable state';
};

/**
 * The absences, as code.
 *
 * `personalizationBypassesEligibility` and `eligibilityReadsTheProfile` are the two halves of
 * one rule, kept separate because they fail differently: the first would let a preference grant
 * access, and the second would let a preference remove it.
 *
 * `relevanceIsAPermission` states the invariant this band added — `relevant != permitted`.
 */
export const personalizationBypassesEligibility = (): false => false;
export const eligibilityReadsTheProfile = (): false => false;
export const relevanceIsAPermission = (): false => false;
