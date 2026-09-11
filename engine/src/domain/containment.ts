/**
 * Failure containment — Phase 95.
 *
 * Phase 67 named what an unavailable *dependency* means. This names what a **failure** means, and
 * the two are different questions: a dependency being down is a state, and a failure is an event
 * whose blast radius somebody has to know before they can decide whether to page anyone.
 *
 * Every mechanism below already works. The per-`(event, consumer)` delivery record already means
 * one failing consumer cannot block another; leases already mean a dead worker's jobs come back;
 * the dead-letter queue already keeps a malformed event from being retried forever. What has never
 * been written down is **the blast radius of each class**, which is the thing an operator needs at
 * the moment they are deciding whether the outage is spreading.
 *
 * ## Why `blastRadius` is a sentence rather than a severity
 *
 * A severity number invites comparison — "this is a 3 and that is a 4" — and the comparison is
 * meaningless across classes: a provider outage that refuses one command and a worker crash that
 * pauses every projection are not on one scale. What an operator needs is what *else* is affected,
 * and that is a sentence.
 */

/** The classes of failure this system distinguishes. */
export type FailureClass =
  /** A provider (transcription, PII, model, webhook) refuses or times out. */
  | 'provider_unavailable'
  /** A worker process dies mid-job. */
  | 'worker_crash'
  /** An event whose payload a consumer cannot interpret. */
  | 'malformed_event'
  /** One consumer throws on an event other consumers handle fine. */
  | 'consumer_failure'
  /** An agent run that produces nothing usable. */
  | 'proposal_failure'
  /** Some of an approved plan's steps are refused. */
  | 'partial_plan_failure'
  /** The database is unreachable or refuses a write. */
  | 'store_unavailable';

export const FAILURE_CLASSES: readonly FailureClass[] = [
  'provider_unavailable',
  'worker_crash',
  'malformed_event',
  'consumer_failure',
  'proposal_failure',
  'partial_plan_failure',
  'store_unavailable',
];

export interface Containment {
  /** What stops working. Specific, because "some things may fail" helps nobody at 3am. */
  readonly blastRadius: string;
  /** What keeps working, which is the half an operator cannot see from a dashboard of errors. */
  readonly unaffected: string;
  /** How it comes back: on its own, on a retry, or only when a person does something. */
  readonly recovery: 'automatic' | 'retried' | 'needs_a_person';
  /** Whether a person has to be told now. */
  readonly pages: boolean;
}

export const CONTAINMENT: Readonly<Record<FailureClass, Containment>> = {
  provider_unavailable: {
    blastRadius:
      'The one path that needs that provider refuses, fail-closed. Voice capture refuses if transcription is down; an agent run reports provider_unavailable and proposes nothing.',
    unaffected:
      'Everything that does not call it. Text accounts, corroboration, discovery, resolution reporting and every governed command continue.',
    recovery: 'retried',
    // A provider outage refuses correctly and loses nothing. It becomes a person's problem when
    // it persists, which the dependency state reports — not on the first failure.
    pages: false,
  },
  worker_crash: {
    blastRadius:
      'Projections and consumers stop advancing while no worker holds a lease. Nothing is lost: leased jobs return to the queue when the lease expires.',
    unaffected:
      'Every synchronous path. Commands still run, state still changes, the outbox still records — because a command commits its own state and its events together and does not wait for a consumer.',
    recovery: 'automatic',
    pages: true,
  },
  malformed_event: {
    blastRadius:
      'One event, for one consumer. It retries its budget and then dead-letters, carrying its whole failure history.',
    unaffected:
      'Every other event, and every other consumer of the same event — delivery state is per (event, consumer), so one interpretation failing does not withhold the event from anybody else.',
    recovery: 'needs_a_person',
    pages: false,
  },
  consumer_failure: {
    blastRadius: 'That consumer falls behind. Its projection is stale until it drains.',
    unaffected:
      'Every other consumer, and every read that re-checks the row rather than trusting the projection — which since Phase 71 is discovery, search and every relevance read.',
    recovery: 'retried',
    pages: false,
  },
  proposal_failure: {
    blastRadius: 'One agent run. It records `refused` or `escalated` and creates no proposal.',
    unaffected:
      'Governed state, entirely and by construction — an agent has no write verb, so a failed run cannot leave a partial effect behind.',
    recovery: 'automatic',
    pages: false,
  },
  partial_plan_failure: {
    blastRadius:
      'The steps that were refused did not happen. The plan records `partial` and each step carries its own reason.',
    unaffected:
      'The steps that succeeded, which stand. This is a normal outcome rather than an error: authorization is evaluated per step at execution time, so a plan whose later steps a reviewer may not perform is *supposed* to stop there.',
    recovery: 'needs_a_person',
    pages: false,
  },
  store_unavailable: {
    blastRadius:
      'Everything. Commands refuse, consumers cannot claim work, reads fail. This is the one class with no containment, because there is nothing behind it to contain it with.',
    unaffected: 'Nothing inside the process. The refusals are correct and no state is half-written.',
    recovery: 'needs_a_person',
    pages: true,
  },
};

/** The classes that wake somebody. Derived, so the two lists cannot disagree. */
export const PAGING_CLASSES: readonly FailureClass[] = FAILURE_CLASSES.filter(
  (failure) => CONTAINMENT[failure].pages,
);

/**
 * What an operator should be told about one failure, in words.
 *
 * Both halves, always. A failure report that lists only what broke reads as a total outage to
 * somebody scanning it under pressure, and the most common operational mistake is escalating a
 * contained failure as though it were spreading.
 */
export const describeContainment = (failure: FailureClass): string => {
  const containment = CONTAINMENT[failure];
  return `${containment.blastRadius} Still working: ${containment.unaffected} Recovery: ${containment.recovery}.`;
};

/**
 * The absences, as code.
 *
 * `containmentChangesARefusal` — false. Like Phase 67's degraded reading, this is a lens over what
 * already happened. If a refusal consulted it, a bug here would become an outage, and the whole
 * value of a description is that it cannot be wrong in a way that matters.
 *
 * `oneFailureStopsEverything` — false for every class but `store_unavailable`, and that one says so
 * in its own `blastRadius` rather than being quietly excluded. An exception stated is a rule; an
 * exception omitted is a surprise.
 */
export const containmentChangesARefusal = (): false => false;
export const oneFailureStopsEverything = (failure: FailureClass): boolean =>
  failure === 'store_unavailable';
