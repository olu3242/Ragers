import { engineError, type EngineError } from './errors.ts';
import {
  decideQuota,
  QUOTA_LIMITS,
  quotaClassOf,
  quotaWindowKey,
  throttleMessage,
  type QuotaWindow,
} from '../domain/quota.ts';
import { isServiceActor, type ActorContext } from './authz.ts';
import type { Clock } from './clock.ts';
import type { QuotaGuard } from './bus.ts';
import type { Table } from '../ports/store.ts';

/**
 * The quota guard — Phase 61.
 *
 * Reads the window, decides, writes the next one. The decision is
 * `src/domain/quota.ts`'s; this is the part that touches a store.
 *
 * **`compareAndSet` on the count, not `put`.** Two requests arriving together must not
 * both read `count: 9` and both write `count: 10`, which is how a limit of ten lets
 * eleven through — and under a real burst, considerably more than eleven. The loser of
 * the race retries against the row it lost to. The same lesson the corroboration
 * check, the review queue and the agent runner each taught in turn.
 *
 * **Contention is refused; store failure is allowed.** These are different things and
 * the first version of this conflated them, with a bad result: after three lost races
 * it waved the request through, so a simultaneous burst of thirty-two against a limit
 * of twenty admitted all thirty-two. Every one of them read the same empty row before
 * any write landed, exhausted its attempts, and took the permissive branch. A throttle
 * that fails open under a burst fails in exactly the case it exists for, and raising
 * the attempt count does not fix it — N racers need O(N) attempts, which in Postgres is
 * N round trips.
 *
 * Two intermediate designs failed here and both failures are worth recording, because
 * each looked reasonable:
 *
 * *Allow after a few lost races.* A burst of thirty-two against a limit of twenty
 * admitted all thirty-two — every racer read the same empty row, lost its five attempts,
 * and took the permissive branch. Worse than the overshoot: those requests were never
 * counted, so the trick repeats indefinitely and the limit means nothing.
 *
 * *Refuse after a few lost races, unless the window is nearly empty.* Same result, for a
 * subtler reason. With every racer starting together the count cannot climb past the
 * attempt count before they all give up, so "nearly empty" is always true and everybody
 * is allowed through uncounted again.
 *
 * The fix is to let the loop actually fill the window: `limit + 8` attempts rather than a
 * small constant. Then a burst of any size drives the count to the limit, and every
 * racer beyond it meets the ordinary in-loop refusal — exactly at the limit, with no
 * overshoot and nothing uncounted. Normal traffic wins on its first attempt and pays
 * nothing for this; only a genuine burst from one account does the extra round trips,
 * which is the right party to charge.
 *
 * What is always allowed through is a throttle store that *throws* — an unavailable
 * counter must not lock everybody out, because a quota is a convenience and
 * authorization is what actually protects the system.
 */

/**
 * Attempts beyond the limit itself, so a burst can drive the window to full rather than
 * exhausting first. Small: it only has to cover the racers that arrive after the window
 * is already full.
 */
export const CONTENTION_HEADROOM = 8;

export interface QuotaGuardDeps {
  readonly windows: Table<QuotaWindow>;
  readonly clock: Clock;
  /** How many times to retry a lost race before allowing the request through. */
  readonly maxAttempts?: number;
}

export const createQuotaGuard = (deps: QuotaGuardDeps): QuotaGuard => ({
  charge: async (command: string, actor: ActorContext): Promise<EngineError | undefined> => {
    const quotaClass = quotaClassOf(command);
    // Not counted: reporting harm, operator actions, and leaving. See
    // `UNTHROTTLED_COMMANDS` for why each one.
    if (quotaClass === undefined) return undefined;
    // The engine acting on its own behalf is not a caller. A consumer dispatching a
    // command is work the system chose to do, so throttling it would drop internal work
    // rather than slow anybody down — and there is no account to count against: the
    // service identity has no `actors` row, so writing a window for it is refused by the
    // foreign key. That refusal is how this exclusion came to be missing rather than
    // present: the charge threw, the bus allowed the request through as an unavailable
    // quota, and the only visible trace was a database error log.
    if (isServiceActor(actor)) return undefined;
    // A guest has no identity to count against. Guests reach only `identity.register`
    // and `identity.authenticate`, which the API layer must throttle by address — a
    // per-actor window cannot express "this caller", only "this account".
    if (!actor.authenticated) return undefined;

    // Proportional to the limit, so the loop can fill the window under a burst instead
    // of giving up while the count is still low.
    const attempts = Math.max(1, deps.maxAttempts ?? QUOTA_LIMITS[quotaClass].limit + CONTENTION_HEADROOM);
    const id = quotaWindowKey(actor.actorId, quotaClass);

    /** The refusal, built from a decision so the retry-after is the store's, not invented. */
    const refuse = (retryAfterMs: number, limit: number, windowMs: number): EngineError =>
      engineError('rate_limited', 'rate_limited', throttleMessage(retryAfterMs), {
        // Named fields a 429 can turn into a Retry-After header. No reason, no
        // suspicion, no score: a quota says when to come back and nothing else.
        retryAfterMs,
        limit,
        windowMs,
        quotaClass,
      });

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const existing = await deps.windows.get(id);
      const decision = decideQuota(quotaClass, existing, actor.actorId, deps.clock.now());

      if (!decision.allowed) {
        return refuse(decision.retryAfterMs, decision.limit, decision.windowMs);
      }

      const won =
        existing === undefined
          ? await deps.windows.compareAndSet(decision.window, 'absent')
          : await deps.windows.compareAndSet(decision.window, [
              // Won only if nobody else moved the count meanwhile. Keyed on the count
              // *and* the window start, so a rollover racing an increment cannot let
              // one of them silently win with stale arithmetic.
              { field: 'count', op: 'eq', value: existing.count },
              { field: 'windowStartedAt', op: 'eq', value: existing.windowStartedAt },
            ]);
      if (won) return undefined;
    }

    // Exhausted every attempt without either claiming a slot or seeing the window fill.
    // With `limit + headroom` attempts this needs more simultaneous racers than the limit
    // to reach, and by then the in-loop check has refused them — so getting here means
    // something unusual. Refused rather than waved through, because an uncounted request
    // is a hole in the limit rather than a favour to a caller.
    const settled = decideQuota(quotaClass, await deps.windows.get(id), actor.actorId, deps.clock.now());
    const policy = QUOTA_LIMITS[quotaClass];
    return settled.allowed
      ? refuse(policy.windowMs, policy.limit, policy.windowMs)
      : refuse(settled.retryAfterMs, settled.limit, settled.windowMs);
  },
});
