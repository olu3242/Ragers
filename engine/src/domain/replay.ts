/**
 * Replay semantics — Phase 96.
 *
 * At-least-once delivery means every consumer will see some events twice. The runtime already
 * handles that correctly: leases stop two workers running one job, idempotency keys stop a command
 * taking effect twice, counters are recomputed from rows rather than incremented, and the
 * confidence series is keyed by boundary so a re-derivation collides. What has never been written
 * down is the **rule those mechanisms all serve**:
 *
 * > **`replay != re-decide`.** Re-delivering an event may recompute a projection. It must never
 * > re-make a human decision or re-apply an effect.
 *
 * The distinction matters because the two look identical from inside a consumer. A handler that
 * recomputes a feed entry and a handler that dispatches a command are both "handling an event"; the
 * first is safe to run a thousand times and the second is not. Nothing in the type system separates
 * them, so this module separates them by name and a test holds each consumer to its class.
 */

/**
 * What re-delivering an event to a handler may do.
 *
 * Ordered from safest to most dangerous, and the ordering is the argument: a handler should be
 * written in the lowest class that does the job, and moving up a class is a decision somebody should
 * have to defend.
 */
export type ReplayClass =
  /**
   * Recomputes from rows. Running it again produces the same result because it reads the whole set
   * rather than applying a delta. The feed and search projections, every counter, the signal
   * snapshot. Safe by construction rather than by care.
   */
  | 'recompute'
  /**
   * Writes a row keyed so that the same input collides. The confidence series (keyed by boundary),
   * the agent run ledger (keyed by agent/subject/type), a delivery record. Safe because the second
   * write is refused, not because the handler checks.
   */
  | 'idempotent_write'
  /**
   * Dispatches a command. Safe **only** because the idempotency key is derived from the event
   * rather than generated, so the bus recognises the replay. This is the class where a careless
   * `ids.next()` in a key turns an at-least-once pipeline into duplicated effects.
   */
  | 'derived_dispatch'
  /**
   * Would re-make a decision a person made, or re-apply an effect. **No handler may be in this
   * class.** It exists so the rule has a name to refuse, and so a test can assert the class is
   * empty rather than asserting a vague absence.
   */
  | 'forbidden_redecide';

export const REPLAY_CLASSES: readonly ReplayClass[] = [
  'recompute',
  'idempotent_write',
  'derived_dispatch',
  'forbidden_redecide',
];

export interface ReplayRule {
  readonly summary: string;
  /** What makes it safe. Never "the handler is careful" — that is not a mechanism. */
  readonly mechanism: string;
  readonly safeToReplay: boolean;
}

export const REPLAY_RULES: Readonly<Record<ReplayClass, ReplayRule>> = {
  recompute: {
    summary: 'Reads the whole set and writes the result.',
    mechanism:
      'No delta is applied, so the output is a function of the current rows. A second delivery computes the same answer from the same rows.',
    safeToReplay: true,
  },
  idempotent_write: {
    summary: 'Writes a row whose key is derived from the event.',
    mechanism:
      'compareAndSet on absence, or a unique constraint. The second write is refused by the store rather than skipped by the handler, so a handler that forgot to check is still safe.',
    safeToReplay: true,
  },
  derived_dispatch: {
    summary: 'Dispatches a command as a consequence of the event.',
    mechanism:
      'The idempotency key is derived from the event and the consumer, never generated. The bus recognises the replay and returns the original result rather than acting again.',
    safeToReplay: true,
  },
  forbidden_redecide: {
    summary: 'Would re-make a human decision or re-apply an effect.',
    mechanism:
      'There is none. A decision is a fact about what a person chose at a moment, and no mechanism can make choosing it twice correct.',
    safeToReplay: false,
  },
};

/**
 * What a replay must never do, as named properties a test can check.
 *
 * Each of these is a specific thing that would be *invisible* in a green test suite: the system
 * would work, and would quietly do a thing twice under load or after a restart.
 */
export const REPLAY_INVARIANTS: readonly string[] = [
  'a re-delivered event does not dispatch a command twice',
  'a re-delivered event does not move a proposal that a person already decided',
  'a re-delivered event does not execute an action plan twice',
  'a re-delivered event does not increment a counter',
  'a re-delivered event does not add a second row to an append-only series',
  'a reclaimed lease does not run a consumer that already completed',
];

/**
 * Whether a class may appear in the consumer registry.
 *
 * `forbidden_redecide` may not, and the reason it is a value at all is that an absence with no name
 * cannot be asserted. A test that checked "no consumer re-decides" would have to define re-deciding
 * inline, and the definition would drift from this one.
 */
export const mayBeRegistered = (replayClass: ReplayClass): boolean =>
  REPLAY_RULES[replayClass].safeToReplay;

/**
 * The absences, as code.
 *
 * `replayReDecides` — false, and it is the whole phase.
 *
 * `idempotencyKeyIsGenerated` — false. A generated key is the single most effective way to break
 * every guarantee above, because it makes each replay look like a new intent to the bus. Every
 * dispatch from a consumer derives its key from the event.
 */
export const replayReDecides = (): false => false;
export const idempotencyKeyIsGenerated = (): false => false;
