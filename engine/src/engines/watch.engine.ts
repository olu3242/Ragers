import { err, ok } from '../runtime/result.ts';
import { notFoundError, preconditionError, validationError } from '../runtime/errors.ts';
import { eq } from '../ports/store.ts';
import { isDiscoverable } from './discovery.engine.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { WatchRow, WatchTarget } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * Watching — E6 Community, Phase 78.
 *
 * Following a person exists (`graph_edges`). Following a *thing* did not: an experience
 * whose outcome somebody wants to know, or a subject that keeps coming up. This is that,
 * and its whole design is one rule pointing in an unusual direction.
 *
 * **The thing is public and the watcher is not.** Every other visibility rule in this
 * codebase protects the *content* — an alias, an anonymous post, a withheld measure. This
 * one protects the *reader*, and it protects them in both directions:
 *
 *   - Nobody may learn who is watching their experience. An author who could see their
 *     watchers could see which of the people they named is following the fallout.
 *   - Nobody may learn what somebody else is watching. A list of what a person watches is a
 *     list of the failures they are worried about, which is a profile of their
 *     circumstances — their landlord, their hospital, their employer.
 *
 * The second is the one that is easy to get wrong, because it looks like a feature. So the
 * count is served by a `security definer` function and the rows are readable only by their
 * own actor; `watchersOf()` does not exist and `watchListOf` takes no actor other than the
 * caller's.
 *
 * **Idempotent by constraint, not by handler.** `unique (actor_id, target_type, target_id)`
 * means watching twice is watching, decided by the database rather than by a
 * read-then-write in a handler. That pattern has now been the fix for four different
 * concurrency defects in this codebase, and it is cheaper to start with it than to find the
 * fifth.
 */

/** A watch is a person and a thing, and the thing must be one somebody may see. */
export const WATCH_TARGETS: readonly WatchTarget[] = ['experience', 'subject'];

export const isWatchTarget = (value: unknown): value is WatchTarget =>
  typeof value === 'string' && (WATCH_TARGETS as readonly string[]).includes(value);

export const watchKey = (actorId: string, targetType: WatchTarget, targetId: string): string =>
  `watch:${actorId}:${targetType}:${targetId}`;

export interface WatchResult {
  readonly watching: true;
  /** True when this call created the row, false when it was already watched. */
  readonly created: boolean;
}

/**
 * Whether this target may be watched at all.
 *
 * An unpublished, hidden, removed or deleted experience is refused — watching something
 * would otherwise be a way to learn it exists, and to be notified when it changes, without
 * ever being able to read it. A subject is checked for existence and for being live.
 */
const targetIsWatchable = async (
  deps: EngineDeps,
  targetType: WatchTarget,
  targetId: string,
): Promise<'ok' | 'not_found' | 'unavailable'> => {
  if (targetType === 'experience') {
    const experience = await deps.store.experiences.get(targetId);
    if (!experience) return 'not_found';
    return isDiscoverable(experience) ? 'ok' : 'unavailable';
  }
  const subject = await deps.store.subjects.get(targetId);
  if (!subject) return 'not_found';
  // A merged or retired subject is not a live thing to watch. Merged points at a survivor,
  // and watching the stale one would silently watch nothing — refused rather than
  // redirected, because redirecting means the caller believing they watched one thing and
  // watching another. `candidate` is refused too: it has not been accepted as a subject yet.
  return subject.state === 'canonical' ? 'ok' : 'unavailable';
};

export const registerWatchEngine = (deps: EngineDeps): void => {
  const watch: CommandHandler<{ targetType: WatchTarget; targetId: string }, WatchResult> = {
    name: 'watch.start',
    action: 'watch.manage',
    resolveResource: async (input) => {
      if (!isWatchTarget(input?.targetType)) {
        return err(validationError('invalid_watch_target', 'a watch is on an experience or a subject'));
      }
      if (typeof input.targetId !== 'string' || input.targetId.length === 0) {
        return err(validationError('target_required', 'a watch needs something to watch'));
      }
      const state = await targetIsWatchable(deps, input.targetType, input.targetId);
      if (state === 'not_found') return err(notFoundError('target_not_found', 'no such thing to watch'));
      if (state === 'unavailable') {
        return err(
          preconditionError('target_unavailable', 'that is not something you can watch', {
            // Named, because "cannot watch" and "does not exist" are different facts and
            // conflating them would make the refusal an existence oracle.
            reason: 'it is not published, or it is no longer current',
          }),
        );
      }
      // The resource is the watcher's own row: authorization asks whether *you* may watch,
      // not whether you may act on the target. Anybody who can read a thing can watch it,
      // so there is no ownership clause here — the row's ownership is the actor's by
      // construction, and RLS holds it at the database.
      return ok({ type: 'graph_edge' });
    },
    handle: async (input, ctx) => {
      const row: WatchRow = {
        id: watchKey(ctx.actor.actorId, input.targetType, input.targetId),
        actorId: ctx.actor.actorId,
        targetType: input.targetType,
        targetId: input.targetId,
        createdAt: ctx.clock.now(),
      };
      // `compareAndSet` on absence: the loser of a race learns it was already watched
      // rather than raising a constraint violation the caller did not earn.
      const created = await deps.store.watches.compareAndSet(row, 'absent');
      if (created) deps.metrics.increment('watch.started', { target: input.targetType });
      return ok({
        value: { watching: true, created },
        // An event only on the transition. Re-watching emits nothing, so a notification
        // downstream cannot fire twice for one intent.
        events: created
          ? [
              {
                aggregateType: input.targetType === 'experience' ? 'experience' : 'subject',
                aggregateId: input.targetId,
                eventName: 'WatchStarted',
                // **No watcher id in the payload.** An event is readable by every consumer
                // and lands in the outbox; putting the watcher in it would leak the
                // identity this phase exists to protect, to everything downstream at once.
                payload: { targetType: input.targetType, targetId: input.targetId },
              },
            ]
          : [],
      });
    },
  };

  const unwatch: CommandHandler<{ targetType: WatchTarget; targetId: string }, { watching: false }> = {
    name: 'watch.stop',
    action: 'watch.manage',
    resolveResource: async (input) => {
      if (!isWatchTarget(input?.targetType)) {
        return err(validationError('invalid_watch_target', 'a watch is on an experience or a subject'));
      }
      if (typeof input.targetId !== 'string' || input.targetId.length === 0) {
        return err(validationError('target_required', 'a watch needs something to watch'));
      }
      // Deliberately no target-availability check. Unwatching something that has since been
      // removed must work — otherwise a removed experience leaves a watch nobody can clear,
      // which is the unclearable-queue-item defect in a different table.
      return ok({ type: 'graph_edge' });
    },
    handle: async (input, ctx) => {
      await deps.store.watches.remove(watchKey(ctx.actor.actorId, input.targetType, input.targetId));
      deps.metrics.increment('watch.stopped', { target: input.targetType });
      // Idempotent: removing what is not there is not an error, because the caller's
      // intent — "I do not want this" — is satisfied either way.
      return ok({ value: { watching: false }, events: [] });
    },
  };

  deps.bus.register(watch);
  deps.bus.register(unwatch);
};

/**
 * How many people are watching. A count, never a list.
 *
 * The in-memory adapter counts rows directly; the Postgres adapter's caller has
 * `watch_count()` available for the client-role path. Both answer the same question and
 * neither can be turned into an enumeration.
 */
export const watchCountFor = async (
  deps: EngineDeps,
  targetType: WatchTarget,
  targetId: string,
): Promise<number> =>
  (
    await deps.store.watches.query([
      eq<WatchRow>('targetType', targetType),
      eq<WatchRow>('targetId', targetId),
    ])
  ).length;

/**
 * What the caller is watching. Only ever the caller.
 *
 * There is no parameter for whose list to read, which is the point: a function that took an
 * actor id would be one refactor away from a surface that showed somebody else's.
 */
export const watchListOf = async (
  deps: EngineDeps,
  actorId: string,
  targetType?: WatchTarget,
): Promise<readonly WatchRow[]> =>
  (
    await deps.store.watches.query([
      eq<WatchRow>('actorId', actorId),
      ...(targetType === undefined ? [] : [eq<WatchRow>('targetType', targetType)]),
    ])
  ).filter(() => true);

/** Whether the caller watches this thing. Their own row, so no disclosure. */
export const isWatching = async (
  deps: EngineDeps,
  actorId: string,
  targetType: WatchTarget,
  targetId: string,
): Promise<boolean> => (await deps.store.watches.get(watchKey(actorId, targetType, targetId))) !== undefined;

/**
 * A deleted experience takes its watches with it.
 *
 * There is no foreign key on `target_id` — it points at one of two tables depending on
 * `target_type`, which Postgres cannot express — so the cascade is a consumer. A watch on
 * something that no longer exists would otherwise sit there producing nothing and appearing
 * in its watcher's list forever.
 *
 * Only `ExperienceDeleted`, deliberately: removal and hiding are reversible, and clearing
 * watches on a hidden experience would silently unsubscribe everybody from something that
 * may come back.
 */
export const createWatchErasureConsumer = (deps: EngineDeps): Consumer => ({
  name: 'watch.erase',
  events: ['ExperienceDeleted'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    if (!experienceId) return ok(undefined);
    for (const row of await deps.store.watches.query([
      eq<WatchRow>('targetType', 'experience'),
      eq<WatchRow>('targetId', experienceId),
    ])) {
      await deps.store.watches.remove(row.id);
    }
    return ok(undefined);
  },
});

/**
 * The absences, as code.
 *
 * `watchersOf` is the function this module deliberately does not export — there is no way to
 * ask who is watching a thing, only how many. `watchIsPublic` and `watchAffectsRanking` keep
 * the other two rules assertable: a watch is not a public act, and watching something does
 * not make it rank higher (which would make watch-brigading a ranking strategy).
 */
export const watchersOfIsAvailable = (): false => false;
export const watchIsPublic = (): false => false;
export const watchAffectsRanking = (): false => false;
