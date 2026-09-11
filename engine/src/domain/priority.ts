import { isEstimated, type Impact } from './impact.ts';
import { isAtLeastBand, type SeverityBand } from './severity.ts';
import { isAtLeastUrgency, type UrgencyLevel } from './urgency.ts';

/**
 * Prioritization — Phase 43, E8.
 *
 * The roadmap asks for `LOW | MEDIUM | HIGH | CRITICAL`, so a band is required. What it
 * also asks for is *deterministic and explainable, with the contributing factors
 * recorded alongside the output* — and those two requirements together rule out the
 * obvious implementation.
 *
 * So there is **no composite score.** Not a weighted sum, not a 0–100 number, not a
 * hidden ranking key. A composite would satisfy "deterministic" and quietly fail
 * "explainable": a reader shown `73.4` cannot tell whether it came from one serious
 * thing or six trivial ones, and neither can the person maintaining the weights.
 *
 * Instead the band comes from **stated rules over named inputs**, and ordering is a
 * lexicographic comparison over those same named inputs in a fixed, documented
 * sequence. Every position is therefore answerable: *why is this above that?* has an
 * answer that names a dimension rather than pointing at a number.
 *
 * The three inputs are kept distinct all the way through, because they are three
 * different questions:
 *
 *   **severity** — how bad it was (asserted, Phase 32)
 *   **urgency**  — how soon somebody should look (derived, Phase 41)
 *   **impact**   — how many people and how much, with an interval (Phase 42)
 */
export type PriorityBand = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const PRIORITY_BANDS: readonly PriorityBand[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const BAND_ORDER: Readonly<Record<PriorityBand, number>> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/** Which dimension decided the band. Recorded so the reason names a cause. */
export type DominantFactor = 'severity' | 'urgency' | 'impact' | 'aging' | 'none';

export interface PriorityInputs {
  readonly subjectId: string;
  readonly band?: SeverityBand | undefined;
  readonly severityUnassessed: boolean;
  readonly urgency: UrgencyLevel;
  readonly urgencyUnassessed: boolean;
  readonly impact: Impact;
  readonly unresolvedDays: number;
}

export interface Priority {
  readonly subjectId: string;
  readonly band: PriorityBand;
  /** One sentence naming why, e.g. "serious, and unresolved for 40 days". */
  readonly reason: string;
  /** The dimensions that decided it, most decisive first. */
  readonly dominant: readonly DominantFactor[];
  /** The named inputs, carried through rather than collapsed. */
  readonly severity?: SeverityBand;
  readonly urgency: UrgencyLevel;
  readonly peopleAffected?: number;
  readonly impactKnown: boolean;
  readonly confidence?: number;
  readonly unresolvedDays: number;
  /** True when nothing under this was assessed. A band is required; this qualifies it. */
  readonly unassessed: boolean;
}

const DAYS_LONG = 45;
const PEOPLE_BROAD = 20;

/**
 * Decide the band from stated rules.
 *
 * Read as a list of claims a person can argue with, which is the point. Each rule names
 * the dimension that triggered it, and the first rule that matches wins — so the
 * ordering of the rules *is* the policy, visible rather than encoded in weights.
 */
export const prioritise = (inputs: PriorityInputs): Priority => {
  const assessedSeverity = !inputs.severityUnassessed && inputs.band !== undefined;
  const impact = inputs.impact;
  const known = isEstimated(impact);
  const people = known ? impact.peopleAffected : undefined;
  const confidence = known ? impact.confidence : undefined;
  const broad = people !== undefined && people >= PEOPLE_BROAD;
  const longUnresolved = inputs.unresolvedDays >= DAYS_LONG;

  const dominant: DominantFactor[] = [];
  let band: PriorityBand = 'LOW';
  let reason = 'nothing about this is outstanding';

  // Safety and immediacy first. `immediate` is only reachable from an asserted safety
  // concern or an open escalation, so it is never a mere function of elapsed time.
  if (isAtLeastUrgency(inputs.urgency, 'immediate')) {
    band = 'CRITICAL';
    dominant.push('urgency');
    reason = 'needs attention now';
    if (assessedSeverity && isAtLeastBand(inputs.band, 'critical')) {
      dominant.push('severity');
      reason = 'needs attention now, and what it cost was reported as critical';
    }
  } else if (assessedSeverity && isAtLeastBand(inputs.band, 'critical') && broad) {
    band = 'CRITICAL';
    dominant.push('severity', 'impact');
    reason = `reported as critical by ${people} people`;
  } else if (assessedSeverity && isAtLeastBand(inputs.band, 'serious') && isAtLeastUrgency(inputs.urgency, 'prompt')) {
    band = 'HIGH';
    dominant.push('severity', 'urgency');
    reason = `reported as ${inputs.band}, and needs attention`;
  } else if (broad && isAtLeastUrgency(inputs.urgency, 'soon')) {
    // Breadth on its own is a legitimate reason to move something up, and saying so
    // plainly is better than folding it into a number that also contains severity.
    band = 'HIGH';
    dominant.push('impact');
    reason = `${people} people say this happened to them, and it is still open`;
  } else if (longUnresolved) {
    band = 'HIGH';
    dominant.push('aging');
    reason = `unresolved for ${inputs.unresolvedDays} days`;
  } else if (assessedSeverity && isAtLeastBand(inputs.band, 'serious')) {
    band = 'MEDIUM';
    dominant.push('severity');
    reason = `what it cost was reported as ${inputs.band}`;
  } else if (isAtLeastUrgency(inputs.urgency, 'soon')) {
    band = 'MEDIUM';
    dominant.push('urgency');
    reason = 'worth a look';
  }

  const unassessed = inputs.severityUnassessed && inputs.urgencyUnassessed && !known;
  if (unassessed) {
    dominant.length = 0;
    dominant.push('none');
    reason = 'nobody has said what this cost, and nothing has aged';
  }

  return {
    subjectId: inputs.subjectId,
    band,
    reason,
    dominant,
    ...(assessedSeverity && inputs.band !== undefined ? { severity: inputs.band } : {}),
    urgency: inputs.urgency,
    ...(people === undefined ? {} : { peopleAffected: people }),
    impactKnown: known,
    ...(confidence === undefined ? {} : { confidence }),
    unresolvedDays: Math.max(0, Math.trunc(inputs.unresolvedDays)),
    unassessed,
  };
};

const URGENCY_ORDER: Readonly<Record<UrgencyLevel, number>> = {
  routine: 0,
  soon: 1,
  prompt: 2,
  immediate: 3,
};

const SEVERITY_ORDER: Readonly<Record<SeverityBand, number>> = {
  minor: 0,
  significant: 1,
  serious: 2,
  critical: 3,
};

/**
 * Ordering: a lexicographic comparison over named dimensions, in a fixed sequence.
 *
 * Band, then urgency, then severity, then people affected, then days unresolved, then
 * subject id. Deterministic by construction — the final tiebreak is the id, so two
 * items are never ordered by insertion accident — and answerable at every step: the
 * first dimension where two items differ is the reason one is above the other.
 *
 * This is deliberately not `score(a) - score(b)`. A comparator over named dimensions
 * can be explained to the person whose complaint is in position nine; a difference of
 * two composites cannot.
 */
export const comparePriority = (left: Priority, right: Priority): number => {
  const byBand = BAND_ORDER[right.band] - BAND_ORDER[left.band];
  if (byBand !== 0) return byBand;

  const byUrgency = URGENCY_ORDER[right.urgency] - URGENCY_ORDER[left.urgency];
  if (byUrgency !== 0) return byUrgency;

  const leftSeverity = left.severity === undefined ? -1 : SEVERITY_ORDER[left.severity];
  const rightSeverity = right.severity === undefined ? -1 : SEVERITY_ORDER[right.severity];
  if (rightSeverity !== leftSeverity) return rightSeverity - leftSeverity;

  // An unknown impact sorts below a known one of any size: absence of information is
  // not evidence of breadth, and must not borrow a position from it.
  const leftPeople = left.impactKnown ? (left.peopleAffected ?? 0) : -1;
  const rightPeople = right.impactKnown ? (right.peopleAffected ?? 0) : -1;
  if (rightPeople !== leftPeople) return rightPeople - leftPeople;

  if (right.unresolvedDays !== left.unresolvedDays) return right.unresolvedDays - left.unresolvedDays;

  // The last resort, so the sort is total and stable across runs and processes.
  return left.subjectId < right.subjectId ? -1 : left.subjectId > right.subjectId ? 1 : 0;
};

/** Sorted, with positions attached. The position is derived, never stored. */
export const rank = (priorities: readonly Priority[]): readonly (Priority & { position: number })[] =>
  [...priorities].sort(comparePriority).map((priority, index) => ({ ...priority, position: index + 1 }));

/**
 * Why one item is above another, naming the dimension that decided it.
 *
 * This is the function that makes "explainable" true rather than claimed. If it cannot
 * name a dimension, the two are genuinely tied and it says so.
 */
export const explainOrder = (above: Priority, below: Priority): string => {
  if (above.band !== below.band) return `${above.band} outranks ${below.band}`;
  if (above.urgency !== below.urgency) return `${above.urgency} is sooner than ${below.urgency}`;
  if (above.severity !== below.severity) {
    return `${above.severity ?? 'unassessed'} is worse than ${below.severity ?? 'unassessed'}`;
  }
  const aboveKnown = above.impactKnown ? (above.peopleAffected ?? 0) : -1;
  const belowKnown = below.impactKnown ? (below.peopleAffected ?? 0) : -1;
  if (aboveKnown !== belowKnown) {
    if (belowKnown === -1) return 'how many people it affected is known here and not there';
    return `${aboveKnown} people is more than ${belowKnown}`;
  }
  if (above.unresolvedDays !== below.unresolvedDays) {
    return `${above.unresolvedDays} days unresolved is longer than ${below.unresolvedDays}`;
  }
  return 'they are equal on every dimension, so they are ordered by id to stay stable';
};

/** There is no composite score. Asserted in a test rather than trusted to review. */
export const priorityCompositeScore = (): undefined => undefined;
