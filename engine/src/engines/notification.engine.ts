import { err, ok } from '../runtime/result.ts';
import { notFoundError } from '../runtime/errors.ts';
import { resolveIdentity } from '../domain/projection.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { Notification, NotificationKind, TargetType } from '../ports/store.ts';
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

const fanOut = async (deps: EngineDeps, spec: FanOutSpec): Promise<void> => {
  // Nobody is notified about their own action.
  if (spec.recipientActorId === spec.originActorId) {
    deps.metrics.increment('notification.suppressed', { reason: 'self' });
    return;
  }

  const id = `${spec.recipientActorId}:${spec.dedupeKey}`;
  const existing = await deps.store.notifications.get(id);
  if (existing) return; // idempotent by construction

  let suppressionReason: string | undefined;
  if (await isBlockedBetween(deps, spec.recipientActorId, spec.originActorId)) {
    suppressionReason = 'blocked';
  } else if (await isMutedBy(deps, spec.recipientActorId, spec.originActorId)) {
    suppressionReason = 'muted';
  } else {
    const preference = await deps.store.notificationPreferences.findOne(
      (row) => row.actorId === spec.recipientActorId && row.kind === spec.kind,
    );
    if (preference && !preference.enabled) suppressionReason = 'preference';
  }

  const notification: Notification = {
    id,
    recipientActorId: spec.recipientActorId,
    kind: spec.kind,
    subjectRef: spec.subjectRef,
    subjectId: spec.subjectId,
    actorLabel: spec.actorLabel,
    dedupeKey: spec.dedupeKey,
    state: suppressionReason ? 'suppressed' : 'delivered',
    ...(suppressionReason === undefined ? {} : { suppressionReason }),
    createdAt: deps.clock.now(),
  };
  await deps.store.notifications.put(notification);
  deps.metrics.increment(suppressionReason ? 'notification.suppressed' : 'notification.delivered', {
    kind: spec.kind,
    ...(suppressionReason === undefined ? {} : { reason: suppressionReason }),
  });
};

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
  [...(await deps.store.notifications.find((row) => row.recipientActorId === actorId && row.state !== 'suppressed'))]
    .sort((a, b) => b.createdAt - a.createdAt);

export const unreadCountFor = async (deps: EngineDeps, actorId: string): Promise<number> =>
  deps.store.notifications.count((row) => row.recipientActorId === actorId && row.state === 'delivered');
