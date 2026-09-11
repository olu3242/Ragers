import type { ExperienceKind } from './types.ts';

/**
 * Phase 73 — relevance ranking, and the composite it replaces.
 *
 * ## What was here before
 *
 * Phase 16 shipped a ranking score, and it survived every band that came after because
 * nothing ever pointed a rule at it:
 *
 * ```
 * finalScore = (engagement * 0.5 + fairness * 0.3 + balance) * recencyDecay
 * engagement = reRage + reRave + same + fairPoint + replyCount
 * fairness   = totalVotes === 0 ? 0 : fairYes / totalVotes
 * ```
 *
 * Three things are wrong with it, and each breaks a rule this codebase states elsewhere:
 *
 * **1. It adds corroborations to reactions.** `reRageCount` is *somebody saying this
 * happened to me as well* — the trust primitive of the whole product. `same` is a tap and
 * `replyCount` is a comment. Summing them produces a number in which forty people
 * recognising their own experience is interchangeable with forty people tapping a button,
 * and that number decided what everybody saw. `corroboration != popularity` and
 * `engagement != truth` are both broken by one `+`. Shares were correctly kept out;
 * corroborations were not, and they are the more serious conflation because they are the
 * one input that actually means something happened.
 *
 * **2. It read "nobody has voted" as "the community judged this unfair."**
 * `totalVotes === 0 ? 0` gave a brand-new experience the same fairness contribution as a
 * unanimously-unfair one, at a 0.3 weight. That is the same defect class this codebase has
 * now found three times — the `?? 0` publishing "0% reported resolved",
 * `INSUFFICIENT_DATA != zero`, and a measure invented below its floor. Here it was worse
 * than a wrong display: it suppressed everything new.
 *
 * **3. It was one opaque number.** The weights lived in the arithmetic and nowhere else,
 * and nothing could tell an author or an operator why one account sat above another.
 *
 * ## What replaces it
 *
 * Named factors and a total comparison, which is the shape Phase 43 already uses for
 * priority: a band from stated rules, a lexicographic comparison over named dimensions,
 * and `explainOrder` naming the dimension where two items first differ. That pattern is
 * proven here, so this is a repair rather than an invention.
 *
 * The precedence below is the substance of the phase, and it is deliberately *not*
 * engagement-first:
 *
 *   1. **Context match** — does this answer what was asked for? Discovery is a question
 *      ("what happens at this company", "what happened in this category"), and something
 *      that does not answer it is not relevant however popular it is.
 *   2. **Corroboration** — how many *people* said it happened to them. The trust
 *      primitive, counted in people and never mixed with anything else.
 *   3. **Recency** — bucketed, not a continuous decay, so ordering is stable and
 *      explainable in words ("this week" beats "last month").
 *   4. **Fairness** — the community's read, **withheld below its floor** rather than
 *      defaulted, so an unvoted experience is ordered by the factors above it instead of
 *      being pushed down by a number nobody produced.
 *   5. **Engagement** — replies and reactions, last, and only as a tiebreak among things
 *      already equal on everything that means something.
 *
 * The order is the argument. Engagement is present because it carries *some* signal about
 * whether an account is legible to other people, and it is last because the moment it
 * outranks corroboration the product becomes a place where the most provocative account
 * of the smallest problem wins.
 *
 * **Trust is absent entirely.** Not zero-weighted — absent. Trust may constrain
 * amplification, and it may never rank, because "a more trusted person's experience ranks
 * above yours" is a caste system with a scoring function. Enforced by a discovery guard
 * rather than by this comment.
 */

/** Every factor that may participate in an ordering. The list is closed. */
export type RelevanceFactor =
  | 'context_match'
  | 'corroboration'
  | 'recency'
  | 'fairness'
  | 'engagement';

/**
 * Precedence, highest first. Total and stated, so an ordering is reproducible from the
 * factors alone and two readers comparing the same pair get the same answer.
 */
export const RELEVANCE_PRECEDENCE: readonly RelevanceFactor[] = [
  'context_match',
  'corroboration',
  'recency',
  'fairness',
  'engagement',
];

/**
 * Inputs that may never become a relevance factor, each with the reason.
 *
 * Enforced by a discovery guard over this module, in the Phase 48 pattern — a factor added
 * later whose name matches one of these fails the guard rather than shipping.
 */
export const FORBIDDEN_RELEVANCE_INPUTS: Readonly<Record<string, string>> = {
  trust: 'Trust may constrain amplification and may never rank. Ranking by trust is a caste system with a scoring function.',
  reputation: 'Reputation is neither popularity nor a rank. An author with a longer history does not get a better position.',
  severity:
    'Severity is what people asserted it cost them, and ranking by it would mean the platform deciding whose loss matters more.',
  shares:
    'A share is amplification and never a claim. Ranking by shares makes reach self-reinforcing, which is the whole failure mode.',
  views: 'Nothing records a view, and this keeps it that way.',
  dwell_time: 'Nothing records dwell time. Ranking by attention is ranking by provocation.',
};

/*
 * Payment is deliberately NOT in the list above, and its absence is the interesting one.
 *
 * The first version of this listed it, with the reason that a position in a list is an
 * outcome and payment reaches no outcome. The Phase 48 discovery guard immediately failed
 * the build — because that guard walks every module under `src/domain` and `src/engines` and
 * refuses the entitlement vocabulary in any spelling, so it *already* forbids payment from
 * reaching relevance, by discovery over the whole tree rather than by an entry in one list.
 *
 * Keeping my own entry would have meant two places asserting one rule, and the weaker of the
 * two would be the one somebody edits. So the entry is gone and the guard is the answer.
 * That guard catching its own reinforcement is a good sign about the guard.
 */

/**
 * How recent, in buckets.
 *
 * Bucketed rather than a continuous decay for two reasons that matter more than
 * precision. It is **stable**: a continuous decay reorders the list on every clock tick,
 * so a reader refreshing sees churn that means nothing. And it is **explainable in
 * words** — "this week is more recent than last month" is a sentence, where "0.437 beats
 * 0.416" is not.
 */
export type RecencyBucket = 'today' | 'this_week' | 'this_month' | 'this_quarter' | 'older';

export const RECENCY_BUCKETS: readonly RecencyBucket[] = [
  'today',
  'this_week',
  'this_month',
  'this_quarter',
  'older',
];

const DAY_MS = 24 * 60 * 60 * 1000;

export const recencyBucketOf = (publishedAt: number, now: number): RecencyBucket => {
  const ageDays = Math.max(0, now - publishedAt) / DAY_MS;
  if (ageDays < 1) return 'today';
  if (ageDays < 7) return 'this_week';
  if (ageDays < 31) return 'this_month';
  if (ageDays < 93) return 'this_quarter';
  return 'older';
};

const recencyRank = (bucket: RecencyBucket): number => RECENCY_BUCKETS.indexOf(bucket);

/**
 * Minimum fair votes before the community's read participates at all.
 *
 * Below this the factor is **withheld**, which is the whole correction: the previous
 * version defaulted it to zero and thereby ranked every new experience as though it had
 * been judged unfair.
 */
export const FAIRNESS_VOTE_FLOOR = 5;

/** Minimum people before corroboration participates, matching the person floors elsewhere. */
export const CORROBORATION_PERSON_FLOOR = 1;

/**
 * The factors for one candidate.
 *
 * `fairness` is optional on purpose and that is load-bearing: absent means *not enough
 * people have voted*, and the comparison skips the factor rather than substituting a
 * value. A number here would be a claim about the community's opinion.
 */
export interface RelevanceFactors {
  readonly experienceId: string;
  readonly kind: ExperienceKind;
  /** Whether, and how well, this answers the question that was asked. */
  readonly contextMatch: ContextMatch;
  /** Distinct people who said it happened to them. People, never rows. */
  readonly corroboratingPeople: number;
  readonly recency: RecencyBucket;
  /** Absent below `FAIRNESS_VOTE_FLOOR`. Absent is not zero. */
  readonly fairness?: number;
  /** Replies and reactions. Last in precedence, and deliberately not summed with above. */
  readonly engagement: number;
  readonly publishedAt: number;
}

/**
 * How well a candidate answers the question.
 *
 * Three values rather than a score, because the useful distinction is categorical: this
 * is *about* what you asked, or it is *near* it, or it merely came up.
 */
export type ContextMatch = 'direct' | 'adjacent' | 'none';

export const CONTEXT_MATCHES: readonly ContextMatch[] = ['direct', 'adjacent', 'none'];

const contextRank = (match: ContextMatch): number => CONTEXT_MATCHES.indexOf(match);

/**
 * Compare two candidates. Negative means `left` ranks above `right`.
 *
 * Total: every factor is compared in precedence order, and the final tiebreak is the id,
 * so the ordering is deterministic for fixed inputs. A ranking that reordered equal items
 * between two reads would be unexplainable by construction.
 */
export const compareRelevance = (left: RelevanceFactors, right: RelevanceFactors): number => {
  const byContext = contextRank(left.contextMatch) - contextRank(right.contextMatch);
  if (byContext !== 0) return byContext;

  // People, descending. Never mixed with anything below it.
  if (left.corroboratingPeople !== right.corroboratingPeople) {
    return right.corroboratingPeople - left.corroboratingPeople;
  }

  const byRecency = recencyRank(left.recency) - recencyRank(right.recency);
  if (byRecency !== 0) return byRecency;

  // Withheld fairness does not participate. Two candidates where one has a fairness read
  // and the other does not are *equal here* and fall through to engagement — the one with
  // a read is not advantaged for having been voted on, and the one without is not pushed
  // down for not having been.
  if (left.fairness !== undefined && right.fairness !== undefined && left.fairness !== right.fairness) {
    return right.fairness - left.fairness;
  }

  if (left.engagement !== right.engagement) return right.engagement - left.engagement;

  return left.experienceId < right.experienceId ? -1 : left.experienceId > right.experienceId ? 1 : 0;
};

/**
 * Which factor decided this pair, in words.
 *
 * The Phase 43 `explainOrder` pattern. This is what makes "explainable" true rather than
 * claimed: a reader can be told the reason without being shown a number, and an operator
 * arguing that the order is wrong has something specific to argue about.
 */
export const explainRelevance = (above: RelevanceFactors, below: RelevanceFactors): string => {
  if (above.contextMatch !== below.contextMatch) {
    return `${above.contextMatch === 'direct' ? 'directly about' : above.contextMatch === 'adjacent' ? 'related to' : 'not about'} what you asked for, where the other is ${below.contextMatch === 'direct' ? 'directly about it' : below.contextMatch === 'adjacent' ? 'related to it' : 'not about it'}`;
  }
  if (above.corroboratingPeople !== below.corroboratingPeople) {
    return `${above.corroboratingPeople} ${above.corroboratingPeople === 1 ? 'person' : 'people'} said it happened to them, against ${below.corroboratingPeople}`;
  }
  if (above.recency !== below.recency) {
    return `${above.recency.replace(/_/g, ' ')} is more recent than ${below.recency.replace(/_/g, ' ')}`;
  }
  if (above.fairness !== undefined && below.fairness !== undefined && above.fairness !== below.fairness) {
    return 'more people who read it thought it was fair';
  }
  if (above.engagement !== below.engagement) {
    // Named as the tiebreak it is, so nobody reads this as the reason something is
    // *important*. It is the reason something is above something otherwise identical.
    return 'equal on everything that means something, so the one people engaged with more is first';
  }
  return 'equal on every factor, so they are ordered by id to stay stable';
};

/**
 * There is no composite score, and this is the assertion of it.
 *
 * `relevanceCompositeScore` matches `priorityCompositeScore` and
 * `evolutionCompositeScore` — the third time this codebase has had to say it, and the
 * first time it has been able to say it about ranking.
 */
export const relevanceCompositeScore = (): undefined => undefined;

/** Trust constrains amplification and never ranks. Assertable rather than merely true. */
export const trustAffectsRelevance = (): false => false;

/**
 * Whether a fairness read has enough behind it to participate.
 *
 * Exported so the caller cannot accidentally build a `RelevanceFactors` with a fairness
 * value below the floor — the floor is a property of the factor, not of the caller.
 */
export const fairnessFor = (fairYes: number, fairNo: number): number | undefined => {
  const total = fairYes + fairNo;
  if (total < FAIRNESS_VOTE_FLOOR) return undefined;
  return Number((fairYes / total).toFixed(6));
};

/** Sort a set of candidates. Pure, so a ranking can be tested without a store. */
export const rankByRelevance = (
  candidates: readonly RelevanceFactors[],
): readonly RelevanceFactors[] => [...candidates].sort(compareRelevance);
