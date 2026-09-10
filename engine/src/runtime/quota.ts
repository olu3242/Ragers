import { engineError, type EngineError } from './errors.ts';
import {
  decideQuota,
  QUOTA_LIMITS,
  quotaClassOf,
  quotaWindowKey,
  throttleMessage,
  type QuotaWindow,
} from '../domain/quota.ts';
import type { ActorContext } from './authz.ts';
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
 * So a caller that cannot claim a slot is refused. A real person does not issue eight
 * simultaneous requests; something that does is what a quota is for, and telling it to
 * come back is the correct answer. What is *allowed* through is a throttle store that
 * throws — an unavailable counter must not lock everybody out, because a quota is a
 * convenience and authorization is what actually protects the system.
 */
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
    // A guest has no identity to count against. Guests reach only `identity.register`
    // and `identity.authenticate`, which the API layer must throttle by address — a
    // per-actor window cannot express "this caller", only "this account".
    if (!actor.authenticated) return undefined;

    const attempts = Math.max(1, deps.maxAttempts ?? 5);
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

    // Every attempt lost the race. Refused rather than waved through: this caller never
    // claimed a slot, and something issuing five simultaneous requests is the shape a
    // quota exists to answer. The retry-after comes from the window as it now stands.
    const settled = decideQuota(quotaClass, await deps.windows.get(id), actor.actorId, deps.clock.now());
    const policy = QUOTA_LIMITS[quotaClass];
    return settled.allowed
      ? refuse(policy.windowMs, policy.limit, policy.windowMs)
      : refuse(settled.retryAfterMs, settled.limit, settled.windowMs);
  },
});
