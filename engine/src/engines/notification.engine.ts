import { err, ok } from '../runtime/result.ts';
import { notFoundError, validationError } from '../runtime/errors.ts';
import { resolveIdentity } from '../domain/projection.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import { eq, isNotificationKind } from '../ports/store.ts';
import type { Notification, NotificationKind, NotificationPreference, TargetType } from '../ports/store.ts';
import { decideNotification, dedupeKeyFor } from '../domain/notification-pipeline.ts';
import { isDiscoverable } from './discovery.engine.ts';
import type { WatchRow } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { isBlockedBetween, isMutedBy } from './graph.engine.ts';

/**
 * P14 Notification Engine.
 *
 * Fan-out is idempotent via `dedupeKey`, so at-least-once delivery cannot
 * produce duplicates. Anonymity and blocks are respected at fan-out time, not
 * at render time — a suppressed notification is never created as deliverable.
 */
interface FanOutSpec {
  readonly recipientActorId: string;
  readonly kind: NotificationKind;
  readonly subjectRef: TargetType;
  readonly subjectId: string;
  readonly actorLabel: string;
  readonly dedupeKey: string;
  readonly originActorId: string;
}

/**
 * Fan-out, as the five named stages — Phase 79.
 *
 * This used to be one function body doing five things, and the missing one was
 * **authorization**: whether the recipient may read the thing they are being told about.
 * It was never needed, because every recipient was the *author* of the experience and an
 * author can always read their own. Phase 78 ends that — a watcher is not the author — so
 * the stage exists now and `decideNotification` owns the order.
 *
 * The decision is pure and lives in `src/domain/notification-pipeline.ts`; this function
 * gathers the facts and applies the outcome. That split is what makes each stage separately
 * testable rather than reachable only by constructing the world that leads to it.
 */
const fanOut = async (deps: EngineDeps, spec: FanOutSpec): Promise<void> => {
  const id = `${spec.recipientActorId}:${spec.dedupeKey}`;

  // Gathered rather than decided here. The reads are ordered cheapest-first, and the ones
  // the decision may not need are still performed — a conditional read would make the
  // decision depend on evaluation order, which is exactly what pulling it out avoided.
  const preference = await deps.store.notificationPreferences.queryOne([
    eq<NotificationPreference>('actorId', spec.recipientActorId),
    eq<NotificationPreference>('kind', spec.kind),
  ]);
  const subject =
    spec.subjectRef === 'experience' ? await deps.store.experiences.get(spec.subjectId) : undefined;

  const decision = decideNotification({
    recipientActorId: spec.recipientActorId,
    originActorId: spec.originActorId,
    blocked: await isBlockedBetween(deps, spec.recipientActorId, spec.originActorId),
    muted: await isMutedBy(deps, spec.recipientActorId, spec.originActorId),
    preferenceEnabled: preference === undefined || preference.enabled,
    // A reply subject is authorized by its parent experience, which the caller has already
    // resolved — so `subjectExists` is true for a reply and the readability question is the
    // experience's. Stated rather than silently defaulted, because a `false` here would
    // suppress every reply notification.
    subjectExists: spec.subjectRef !== 'experience' || subject !== undefined,
    subjectReadable:
      spec.subjectRef !== 'experience' ||
      // The author may always read their own, whatever its status — that is how they learn a
      // moderation outcome. Anybody else needs it to be discoverable.
      subject?.actorId === spec.recipientActorId ||
      isDiscoverable(subject),
    alreadyNotified: (await deps.store.notifications.get(id)) !== undefined,
  });

  if (!decision.deliver) {
    // Dedupe is not a suppression: the notification already exists, and writing a
    // `suppressed` row over a `delivered` one would erase the delivery.
    if (decision.stage === 'dedupe') return;

    deps.metrics.increment('notification.suppressed', {
      kind: spec.kind,
      stage: decision.stage,
      reason: decision.reason,
    });
    await deps.store.notifications.put({
      id,
      recipientActorId: spec.recipientActorId,
      kind: spec.kind,
      subjectRef: spec.subjectRef,
      subjectId: spec.subjectId,
      actorLabel: spec.actorLabel,
      dedupeKey: spec.dedupeKey,
      state: 'suppressed',
      // The *stage* travels with the reason, because "you turned this off" and "you may not
      // see this" need different answers from a surface and the reason alone cannot say which.
      suppressionReason: `${decision.stage}:${decision.reason}`,
      createdAt: deps.clock.now(),
    });
    return;
  }

  await deps.store.notifications.put({
    id,
    recipientActorId: spec.recipientActorId,
    kind: spec.kind,
    subjectRef: spec.subjectRef,
    subjectId: spec.subjectId,
    actorLabel: spec.actorLabel,
    dedupeKey: spec.dedupeKey,
    state: 'delivered',
    createdAt: deps.clock.now(),
  });
  deps.metrics.increment('notification.delivered', { kind: spec.kind });
};

/**
 * Phase 78/79 — the people watching a thing are told when something happens to it.
 *
 * The first notification whose recipient is not the author, which is what made the
 * authorization stage necessary. Two things it deliberately does not do:
 *
 * **It does not tell the author that watchers exist.** The fan-out reads the watch rows and
 * notifies each watcher; nothing is written towards the author, and the notification the
 * watcher receives names no other watcher.
 *
 * **It carries no excerpt.** The payload is a reference, so a notification about something
 * since removed cannot leak its content even if authorization were wrong. That is the
 * difference between a bug here being a wrong notification and being a disclosure.
 */
export const createWatchNotificationConsumer = (deps: EngineDeps): Consumer => ({
  name: 'notify.watchers',
  // **Outcome events only.** Not reactions and not replies: somebody watching an experience
  // wants to know how it *ends*, and notifying them of every tap would make watching unusable
  // and turn the feature into an engagement loop by the back door.
  //
  // `ResolutionReported` is included and `ResolutionStatusChanged` alone is not enough, which
  // the certification lap found: a status change requires the aggregate to move, and one person
  // reporting an outcome often does not move it. But *somebody it happened to saying whether it
  // was fixed* is precisely what a watcher asked to know, so the report is the event and the
  // status change is the coarser one that sometimes follows.
  events: [
    'ResolutionReported',
    'ResolutionStatusChanged',
    'DisputeOpened',
    'DisputeReviewed',
    'ContentRemoved',
  ],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    if (!experienceId) return ok(undefined);

    const watchers = await deps.store.watches.query([
      eq<WatchRow>('targetType', 'experience'),
      eq<WatchRow>('targetId', experienceId),
    ]);

    for (const watcher of watchers) {
      await fanOut(deps, {
        recipientActorId: watcher.actorId,
        kind: 'watched_update',
        subjectRef: 'experience',
        subjectId: experienceId,
        // No sender to name: this is the system reporting a change of state, not a person
        // acting towards the watcher.
        actorLabel: 'Ragers',
        // Content-derived, and discriminated by the event *and the outcome it reports* — so
        // "partially resolved" and a later "resolved" are two notifications, while two people
        // reporting the same outcome is one. That is the granularity a watcher wants: they
        // asked how it ends, not how many people said so.
        dedupeKey: dedupeKeyFor({
          kind: 'watched_update',
          subjectId: experienceId,
          originActorId: 'system',
          discriminator: [event.eventName, String(event.payload['status'] ?? '')]
            .filter((part) => part.length > 0)
            .join(':'),
        }),
        originActorId: 'system',
      });
    }
    return ok(undefined);
  },
});

/**
 * The label respects the *originating* experience's visibility, so a reaction
 * from an anonymous actor never names them.
 */
const labelFor = async (deps: EngineDeps, originActorId: string): Promise<string> => {
  const actor = await deps.store.actors.get(originActorId);
  return resolveIdentity('public', actor?.displayName, undefined).label;
};

export const createNotificationFanOutConsumer = (deps: EngineDeps): Consumer => ({
  name: 'notify.fanout',
  events: ['ReactionAdded', 'FairVoteCast', 'FairVoteChanged', 'ReplyPublished', 'ContentRemoved'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    const experience = await deps.store.experiences.get(experienceId);
    if (!experience) return ok(undefined);

    if (event.eventName === 'ContentRemoved') {
      await fanOut(deps, {
        recipientActorId: experience.actorId,
        kind: 'moderation_outcome',
        subjectRef: 'experience',
        subjectId: experienceId,
        actorLabel: 'Ragers',
        dedupeKey: `moderation:${experienceId}`,
        // A moderation outcome is from the system, so it always reaches the author.
        originActorId: 'system',
      });
      return ok(undefined);
    }

    const originActorId = String(
      event.payload['reactorActorId'] ?? event.payload['voterActorId'] ?? event.payload['replierActorId'] ?? '',
    );
    if (!originActorId) return ok(undefined);

    const kind: NotificationKind =
      event.eventName === 'ReplyPublished'
        ? 'reply_received'
        : event.eventName === 'ReactionAdded'
          ? 'reaction_received'
          : 'fair_vote_received';

    const discriminator =
      event.eventName === 'ReactionAdded'
        ? String(event.payload['reactionType'] ?? '')
        : event.eventName === 'ReplyPublished'
          ? String(event.payload['replyId'] ?? '')
          : 'fair_vote';

    await fanOut(deps, {
      recipientActorId: experience.actorId,
      kind,
      subjectRef: 'experience',
      subjectId: experienceId,
      actorLabel: await labelFor(deps, originActorId),
      dedupeKey: `${kind}:${experienceId}:${originActorId}:${discriminator}`,
      originActorId,
    });
    return ok(undefined);
  },
});

export const registerNotificationEngine = (deps: EngineDeps): void => {
  const markRead: CommandHandler<{ notificationId: string }, { read: true }> = {
    name: 'notification.markRead',
    action: 'notification.read',
    resolveResource: async (input) => {
      const notification = await deps.store.notifications.get(input.notificationId);
      if (!notification) return err(notFoundError('notification_not_found', 'no such notification'));
      return ok({ type: 'notification', id: notification.id, ownerActorId: notification.recipientActorId });
    },
    handle: async (input, ctx) => {
      const notification = await deps.store.notifications.get(input.notificationId);
      if (!notification) return err(notFoundError('notification_not_found', 'no such notification'));
      if (notification.state === 'read') return ok({ value: { read: true }, events: [] });
      await deps.store.notifications.put({ ...notification, state: 'read', readAt: ctx.clock.now() });
      return ok({ value: { read: true }, events: [] });
    },
  };

  const setPreference: CommandHandler<
    { kind: NotificationKind; enabled: boolean },
    { kind: NotificationKind; enabled: boolean }
  > = {
    name: 'notification.setPreference',
    action: 'notification.set_preference',
    resolveResource: async (_input, ctx) => ok({ type: 'notification', ownerActorId: ctx.actor.actorId }),
    handle: async (input, ctx) => {
      // The row's id is `actorId:kind`, so an unchecked kind is an unbounded number
      // of rows one caller can write — none of which suppresses anything, because no
      // notification is ever of that kind.
      if (!isNotificationKind(input.kind)) {
        return err(validationError('unknown_notification_kind', 'that is not a notification you can turn off'));
      }
      if (typeof input.enabled !== 'boolean') {
        return err(validationError('enabled_must_be_boolean', 'a preference is on or off'));
      }
      await deps.store.notificationPreferences.put({
        id: `${ctx.actor.actorId}:${input.kind}`,
        actorId: ctx.actor.actorId,
        kind: input.kind,
        enabled: input.enabled,
      });
      return ok({ value: { kind: input.kind, enabled: input.enabled }, events: [] });
    },
  };

  deps.bus.register(markRead);
  deps.bus.register(setPreference);
};

/** A recipient reads only their own notifications, and never the suppressed ones. */
export const notificationsFor = async (
  deps: EngineDeps,
  actorId: string,
): Promise<readonly Notification[]> =>
  [...(await deps.store.notifications.query([eq('recipientActorId', actorId), { field: 'state', op: 'ne', value: 'suppressed' }]))]
    .sort((a, b) => b.createdAt - a.createdAt);

export const unreadCountFor = async (deps: EngineDeps, actorId: string): Promise<number> =>
  deps.store.notifications.countWhere([eq('recipientActorId', actorId), eq('state', 'delivered')]);
