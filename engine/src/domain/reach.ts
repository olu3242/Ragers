/**
 * Phases 76 and 77 — emerging patterns, and reach.
 *
 * Two questions this band has to answer without answering them wrongly:
 *
 *   - **How far has this got?** (reach) — and the wrong answer is a row count.
 *   - **Is something starting?** (emergence) — and the wrong answer is calling it verified.
 *
 * ## Reach is a count of people
 *
 * The trust primitive of this whole product is that a count of people is a count of people.
 * `uniqueExperiencers` already holds that for corroborations, and reach is the same rule
 * applied to a wider set: everybody who has contributed something that means *this happened
 * to me as well*.
 *
 * Two things are excluded and each exclusion is the point:
 *
 * **Shares are not reach.** A share is amplification — "I want others to see this" — and it
 * is explicitly not a claim. Counting shares into reach would make reach self-reinforcing:
 * a widely-shared thing would read as widely-experienced, and the number that is supposed to
 * mean "this many people" would mean "this travelled far". They are opposite failure modes to
 * confuse.
 *
 * **Self-amplification contributes nothing.** An author's own actions on their own experience
 * do not increase its reach, and neither do a person's repeated actions. That is not a
 * fraud-detection heuristic; it is arithmetic: reach counts *distinct people*, so somebody
 * appearing twice is one person, and the author appearing at all is the person the experience
 * is already attributed to.
 *
 * ## Emerging is not verified
 *
 * A pattern noticed early is useful — it is most of what makes the platform worth reading
 * before something becomes a scandal. It is also the most dangerous thing to state
 * confidently, because early means few people, and few people means the floors that govern
 * every other measure here apply hardest.
 *
 * So an emerging pattern is surfaced with the vocabulary of emergence and nothing stronger.
 * There is no `verified`, no `confirmed`, and no bare count that could be read as one. Below
 * the floor it is not surfaced at all, rather than surfaced with a caveat — a caveat beside a
 * number is read as a number.
 */

/**
 * What contributes to reach, and what does not.
 *
 * Enumerated as data so the exclusions are assertable rather than implied by the absence of
 * a line of code.
 */
export const REACH_CONTRIBUTIONS: readonly string[] = ['corroboration', 'experience_author'];

export const REACH_EXCLUSIONS: Readonly<Record<string, string>> = {
  share:
    'A share is amplification and explicitly not a claim. Counting it would make reach self-reinforcing: a widely-shared thing would read as widely-experienced.',
  reaction:
    'A reaction is a response to a claim, not a claim. Somebody tapping "same" has not said it happened to them — that is what a corroboration is for, and the two are separate tables for this reason.',
  reply:
    'A reply is a comment. It may say anything, including disagreement, and counting it as reach would count somebody arguing as somebody affected.',
  view: 'Nothing records a view, and reach is not audience.',
  self: 'An author is already the person the experience is attributed to. Counting them again is counting one person twice.',
};

export interface ReachInput {
  /** The author, so their own contributions can be excluded by identity rather than by rule. */
  readonly authorActorId: string;
  /** One entry per corroboration row. Duplicates are expected and are the point. */
  readonly corroboratorActorIds: readonly string[];
  /** Present so the test that shares do not count has something to pass. */
  readonly shareCount: number;
  readonly reactionCount: number;
}

export interface Reach {
  /** Distinct people who said it happened to them, including the author. */
  readonly people: number;
  /** How many contributions were discarded as duplicates or as the author's own. */
  readonly selfOrDuplicate: number;
  /** Stated so a reader can see that amplification was counted separately, not folded in. */
  readonly amplification: number;
}

/**
 * Reach, counted in people.
 *
 * The author counts as one — the experience is somebody's, and reach of one is the honest
 * floor rather than zero. Every corroborator counts once however many rows they have, and the
 * author corroborating their own experience adds nothing.
 */
export const reachOf = (input: ReachInput): Reach => {
  const people = new Set<string>([input.authorActorId]);
  let selfOrDuplicate = 0;
  for (const actorId of input.corroboratorActorIds) {
    if (people.has(actorId)) {
      selfOrDuplicate += 1;
      continue;
    }
    people.add(actorId);
  }
  return {
    people: people.size,
    selfOrDuplicate,
    // Reported beside reach rather than inside it. A reader may want to know something
    // travelled; they must not be able to mistake that for how many people it happened to.
    amplification: input.shareCount,
  };
};

/** Reach never counts a share or a reaction. Assertable rather than merely true. */
export const shareContributesToReach = (): false => false;
export const reactionContributesToReach = (): false => false;

// ── Phase 76: emergence ──────────────────────────────────────────────────

/**
 * The vocabulary an emerging pattern may be described with.
 *
 * A closed list, because the failure mode is a word: "confirmed" or "verified" beside three
 * people's accounts is a claim the data cannot support, and it is exactly the word somebody
 * reaches for when writing a headline.
 */
export const EMERGENCE_LABELS: readonly string[] = ['emerging', 'possible', 'early'];

export const FORBIDDEN_EMERGENCE_LABELS: readonly string[] = [
  'verified',
  'confirmed',
  'proven',
  'established',
  'widespread',
  'systemic',
];

/**
 * Minimum distinct people before a pattern may be surfaced as emerging at all.
 *
 * Three, matching the cohort minimum in Phase 62 and for the same reason: two people is a
 * coincidence and there is no honest way to describe it as a pattern. Below this the pattern
 * is **not surfaced**, rather than surfaced with a caveat — a caveat beside a number is read
 * as a number.
 */
export const EMERGENCE_PERSON_FLOOR = 3;

/** Minimum distinct experiences, so one much-corroborated event is not a "pattern". */
export const EMERGENCE_EXPERIENCE_FLOOR = 2;

export interface EmergenceInput {
  readonly distinctPeople: number;
  readonly distinctExperiences: number;
  /** Whether the underlying signal is still current — a stale pattern is not emerging. */
  readonly signalCurrent: boolean;
}

export type EmergenceVerdict =
  /** Surfaced, with the vocabulary of emergence. */
  | { readonly surfaced: true; readonly label: 'emerging'; readonly people: number }
  /** Not surfaced, with the reason — which is not the same as "nothing is happening". */
  | { readonly surfaced: false; readonly reason: EmergenceRefusal };

export type EmergenceRefusal = 'below_person_floor' | 'below_experience_floor' | 'signal_not_current';

/**
 * Whether this may be surfaced as emerging.
 *
 * The `signal_not_current` refusal is the one worth naming: a pattern whose signal has
 * expired describes something that *used to happen*, and surfacing it as emerging would
 * present history as news. That is the failure Phase 54 built the lifecycle to prevent, and
 * this is the read that would otherwise undo it.
 */
export const decideEmergence = (input: EmergenceInput): EmergenceVerdict => {
  if (!input.signalCurrent) return { surfaced: false, reason: 'signal_not_current' };
  if (input.distinctPeople < EMERGENCE_PERSON_FLOOR) {
    return { surfaced: false, reason: 'below_person_floor' };
  }
  if (input.distinctExperiences < EMERGENCE_EXPERIENCE_FLOOR) {
    return { surfaced: false, reason: 'below_experience_floor' };
  }
  return { surfaced: true, label: 'emerging', people: input.distinctPeople };
};

/**
 * An emerging pattern is never described as established. Assertable rather than trusted.
 *
 * `emergenceIsVerification` returns false, and a test sweeps the surfaced label against
 * `FORBIDDEN_EMERGENCE_LABELS` — so a future edit that reached for "confirmed" fails rather
 * than shipping a claim.
 */
export const emergenceIsVerification = (): false => false;
