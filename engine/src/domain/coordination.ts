/**
 * Phase 62 — coordinated inauthenticity.
 *
 * Corroboration is the trust primitive: `1,842 Re-Rages` means 1,842 people saying it
 * happened to them, and the whole product rests on that being true. The Phase 38 and
 * 39 floors protect against reading too much into a *small* sample. Nothing protected
 * against a *manufactured* large one, and this is that.
 *
 * **Detection opens a review and nothing else.** There is no field in a finding for a
 * verdict, a weight, a discount or a penalty, and there is no function here that
 * returns one. The output is a reason to look, and looking is a person's job. That is
 * not caution for its own sake: a claim wrongly discounted is somebody being told their
 * experience did not happen, which is the single worst thing this system could do, and
 * an automated system will be wrong sometimes.
 *
 * **It never adjusts a count.** `uniqueExperiencers` keeps counting people. A suspicion
 * is not a subtraction, and a count that quietly moved because a heuristic fired would
 * make every figure in the product unfalsifiable.
 *
 * ### What is actually detected, and why not the obvious thing
 *
 * The obvious signals — a burst of claims in minutes, brand-new accounts — are also
 * exactly what a genuine news event produces. A local story breaks, forty people
 * recognise it, half of them sign up to say so. Flagging that would train moderators
 * to dismiss the queue, and would put the heaviest suspicion on the moments when the
 * product is working.
 *
 * The discriminator is **co-travelling**: the same several accounts appearing together
 * across several *different* experiences. A genuine burst converges on one account of
 * one thing. A ring has to hit multiple targets to be worth operating, and that leaves
 * a shape chance does not easily produce. So the rule is a cohort of accounts whose
 * claims *overlap* across enough experiences, with each overlap temporally tight.
 */

/** One claim, as the analysis needs it. Nothing about the claim's content. */
export interface ClaimArrival {
  readonly experienceId: string;
  readonly actorId: string;
  readonly createdAt: number;
}

/** Fewer accounts than this is not a cohort, it is a coincidence. */
export const COHORT_MINIMUM_ACTORS = 3;
/** And fewer shared experiences than this is two people with similar taste. */
export const COHORT_MINIMUM_SHARED = 3;
/**
 * Claims on one experience count as co-arriving inside this window.
 *
 * Six hours rather than minutes: a ring does not have to be fast, and requiring speed
 * would make the check trivially evadable by adding a delay. Wide enough to catch a
 * patient ring, narrow enough that three regular users happening to read the same
 * three clusters over a fortnight do not look like one.
 */
export const CO_ARRIVAL_WINDOW_MS = 6 * 60 * 60 * 1_000;

/** A bound on the work. Beyond this the analysis reports nothing rather than crawling. */
export const MAX_CLAIMS_ANALYSED = 5_000;

export interface CoordinationFinding {
  /**
   * The accounts that travelled together. Internal only — this never reaches a public
   * surface, and the queue item it produces names the experience, not these.
   */
  readonly cohort: readonly string[];
  /** The experiences they co-arrived on. */
  readonly experienceIds: readonly string[];
  /** Named, not scored. A finding says what was observed, never how bad it is. */
  readonly because: 'cohort_co_arrived_across_experiences';
  /** How many experiences the whole cohort shares. The observation, not a verdict. */
  readonly sharedCount: number;
}

/** Claims grouped by experience, each group ordered. */
const byExperience = (claims: readonly ClaimArrival[]): Map<string, ClaimArrival[]> => {
  const grouped = new Map<string, ClaimArrival[]>();
  for (const claim of claims) {
    grouped.set(claim.experienceId, [...(grouped.get(claim.experienceId) ?? []), claim]);
  }
  for (const [id, group] of grouped) {
    grouped.set(id, [...group].sort((left, right) => left.createdAt - right.createdAt));
  }
  return grouped;
};

/**
 * Experiences on which two accounts arrived within the co-arrival window.
 *
 * Pairwise rather than over all subsets, because "every subset of accounts" is
 * exponential and a cohort can be assembled from pairs. The pair is the unit that is
 * cheap to compute and easy to explain.
 */
const coArrivalsByPair = (claims: readonly ClaimArrival[]): Map<string, Set<string>> => {
  const shared = new Map<string, Set<string>>();
  for (const [experienceId, group] of byExperience(claims)) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const one = group[left] as ClaimArrival;
        const other = group[right] as ClaimArrival;
        if (one.actorId === other.actorId) continue;
        if (Math.abs(other.createdAt - one.createdAt) > CO_ARRIVAL_WINDOW_MS) continue;
        const key = one.actorId < other.actorId ? `${one.actorId}|${other.actorId}` : `${other.actorId}|${one.actorId}`;
        shared.set(key, new Set([...(shared.get(key) ?? []), experienceId]));
      }
    }
  }
  return shared;
};

/**
 * Find cohorts.
 *
 * Accounts are joined when they co-arrived on at least `COHORT_MINIMUM_SHARED`
 * experiences. Connected components of that graph are candidate cohorts, and a
 * candidate is reported only when the *whole* component shares that many experiences —
 * a chain of pairs is not a group, and reporting one would name accounts that never
 * appeared together.
 */
export const analyseCoordination = (claims: readonly ClaimArrival[]): readonly CoordinationFinding[] => {
  if (claims.length === 0 || claims.length > MAX_CLAIMS_ANALYSED) return [];

  const pairs = coArrivalsByPair(claims);
  const adjacency = new Map<string, Set<string>>();
  for (const [key, experiences] of pairs) {
    if (experiences.size < COHORT_MINIMUM_SHARED) continue;
    const [one, other] = key.split('|') as [string, string];
    adjacency.set(one, new Set([...(adjacency.get(one) ?? []), other]));
    adjacency.set(other, new Set([...(adjacency.get(other) ?? []), one]));
  }

  const seen = new Set<string>();
  const findings: CoordinationFinding[] = [];

  for (const start of [...adjacency.keys()].sort()) {
    if (seen.has(start)) continue;

    // Breadth-first over the co-travelling graph.
    const component: string[] = [];
    const frontier = [start];
    while (frontier.length > 0) {
      const actorId = frontier.pop() as string;
      if (seen.has(actorId)) continue;
      seen.add(actorId);
      component.push(actorId);
      for (const neighbour of adjacency.get(actorId) ?? []) {
        if (!seen.has(neighbour)) frontier.push(neighbour);
      }
    }
    if (component.length < COHORT_MINIMUM_ACTORS) continue;

    // What the whole component shares, not what a chain of pairs shares.
    const claimsByActor = new Map<string, Set<string>>();
    for (const claim of claims) {
      claimsByActor.set(claim.actorId, new Set([...(claimsByActor.get(claim.actorId) ?? []), claim.experienceId]));
    }
    let common: Set<string> | undefined;
    for (const actorId of component) {
      const own = claimsByActor.get(actorId) ?? new Set<string>();
      common = common === undefined ? new Set(own) : new Set([...common].filter((id) => own.has(id)));
    }
    const shared = common ?? new Set<string>();
    if (shared.size < COHORT_MINIMUM_SHARED) continue;

    findings.push({
      cohort: [...component].sort(),
      experienceIds: [...shared].sort(),
      because: 'cohort_co_arrived_across_experiences',
      sharedCount: shared.size,
    });
  }

  return findings;
};

/**
 * Deliberately absent: any adjustment to a count, a weight or a standing.
 *
 * `undefined`, so the absence is assertable. A corroboration that a heuristic
 * disbelieved is still a person saying something happened to them, and the only
 * legitimate response is for somebody to look.
 */
export const coordinationAdjustsCount = (): undefined => undefined;

/** And absent: any sanction. A finding is a queue item; it is not an outcome. */
export const coordinationSanction = (): undefined => undefined;
