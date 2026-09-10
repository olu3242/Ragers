import { err, ok } from '../runtime/result.ts';
import { notFoundError, preconditionError, validationError } from '../runtime/errors.ts';
import { publishExperience, removeExperience, restoreExperience } from '../domain/experience.ts';
import {
  isModerationActionKind,
  REPORT_REASONS,
  REVIEW_NOTE_MAX_LENGTH,
  type ModerationActionKind,
  type ReportReason,
} from '../domain/types.ts';
import { moderateReply } from '../domain/reply-moderation.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import { eq, isTargetType } from '../ports/store.ts';
import type { QueueItem, Report, TargetType } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { experienceResource, loadExperience, replyResource, writeAudit } from './support.ts';

/**
 * P9 Trust & Safety Engine.
 *
 * The defining property is that screening **fails closed**: if it cannot run,
 * the experience stays in `pending_moderation` and is never published. A
 * reporter learns nothing about internal handling (PRD §6.3).
 */

/**
 * Enqueue for review, idempotently.
 *
 * Exported so escalation (Phase 34) routes through the one queue rather than growing a
 * second one. Two queues would mean two definitions of "claimed", and an operator
 * working one while items pile up in the other.
 */
/**
 * The natural key of a queue item: one review per target.
 *
 * Deterministic on purpose, and for the same reason corroborations are. The read
 * below cannot arbitrate a race — six workers sweeping at once all saw no row and all
 * inserted, and the database's `unique (target_type, target_id)` rejected five of
 * them with an error they had not earned. A generated id gives concurrent callers
 * nothing to collide on; this one makes them collide on the primary key, where
 * `compareAndSet` can name a single winner.
 */
export const queueItemKey = (targetType: TargetType, targetId: string): string =>
  `mq:${targetType}:${targetId}`;

export const enqueueForReview = async (
  deps: EngineDeps,
  targetType: TargetType,
  targetId: string,
  priority: number,
): Promise<string> => {
  const existing = await deps.store.queueItems.queryOne([
    eq<QueueItem>('targetType', targetType),
    eq<QueueItem>('targetId', targetId),
  ]);
  if (existing) return existing.id; // already queued, by this key or an older one
  const item: QueueItem = {
    id: queueItemKey(targetType, targetId),
    targetType,
    targetId,
    priority,
    state: 'queued',
    createdAt: deps.clock.now(),
  };
  // The store decides the race, not the read above. A loser is not an error: the
  // item it wanted exists, which is exactly what it asked for.
  const won = await deps.store.queueItems.compareAndSet(item, 'absent');
  if (won) return item.id;
  const winner = await deps.store.queueItems.queryOne([
    eq<QueueItem>('targetType', targetType),
    eq<QueueItem>('targetId', targetId),
  ]);
  return winner?.id ?? item.id;
};

/** Local alias, so the existing call sites in this file read unchanged. */
const enqueue = enqueueForReview;

/**
 * Pre-publish screening. A naming/shaming signal routes to human review rather
 * than auto-removal — the community principle is enforced by a person.
 */
export const createScreeningConsumer = (deps: EngineDeps): Consumer => ({
  name: 'moderation.screen',
  events: ['ExperienceValidated', 'ExperienceMediaReady'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    const experience = await deps.store.experiences.get(experienceId);
    if (!experience) return ok(undefined);
    // Idempotent: only content actually awaiting moderation is screened.
    if (experience.status !== 'pending_moderation') return ok(undefined);

    const detection = await deps.providers.pii.detectInText(experience.bodyText);
    if (!detection.ok) {
      // Fail closed. The experience stays unpublished.
      deps.metrics.increment('moderation.screen_failed', { reason: detection.error.code });
      return err(detection.error);
    }

    // A known organization's name is not a person's name.
    //
    // The detector's person-name heuristic reads any pair of capitalised words as
    // a possible person, so "Northwind Air" trips it. Left alone, that routes
    // every experience that names a company to human review — which at any real
    // volume means the reports most worth reading are the ones that sit in a
    // queue. Spans matching a known entity or alias are therefore not treated as
    // person names. Nothing else is relaxed: phone numbers, and capitalised pairs
    // that are not known entities, still route to review.
    const entityNames = new Set<string>();
    for (const entity of await deps.store.entities.all()) entityNames.add(entity.name.toLowerCase());
    for (const alias of await deps.store.entityAliases.all()) entityNames.add(alias.alias.toLowerCase());

    const signals = detection.value
      .filter((finding) => finding.piiClass === 'person_name' || finding.piiClass === 'phone')
      .filter(
        (finding) =>
          finding.piiClass !== 'person_name' ||
          !entityNames.has(experience.bodyText.slice(finding.start, finding.end).toLowerCase()),
      )
      .map((finding) => finding.piiClass);

    await deps.store.screenings.put({
      id: deps.ids.next('scr'),
      targetType: 'experience',
      targetId: experienceId,
      outcome: signals.length > 0 ? 'needs_review' : 'clear',
      signals,
      createdAt: deps.clock.now(),
    });

    if (signals.length > 0) {
      await enqueue(deps, 'experience', experienceId, 10);
      deps.metrics.increment('moderation.routed_to_review');
      await deps.outbox.append(
        [
          {
            aggregateType: 'experience',
            aggregateId: experienceId,
            eventName: 'ContentScreened',
            payload: { experienceId, outcome: 'needs_review' },
          },
        ],
        event.correlationId,
      );
      return ok(undefined);
    }

    const published = publishExperience(experience, deps.clock.now());
    if (!published.ok) return err(published.error);
    await deps.store.experiences.put(published.value.experience);
    await deps.outbox.append(
      [
        {
          aggregateType: 'experience',
          aggregateId: experienceId,
          eventName: 'ContentScreened',
          payload: { experienceId, outcome: 'clear' },
        },
        ...published.value.events,
      ],
      event.correlationId,
    );
    deps.metrics.increment('moderation.screened_clear');
    return ok(undefined);
  },
});

export const registerSafetyEngine = (deps: EngineDeps): void => {
  const fileReport: CommandHandler<
    { targetType: TargetType; targetId: string; reasonCode: ReportReason },
    { reportId: string; acknowledged: true }
  > = {
    name: 'safety.fileReport',
    action: 'report.file',
    resolveResource: async (input) => {
      // An unchecked target type fell through to the reply branch, so a report naming
      // something that is neither reached the row — and `reports.target_type` is an
      // enum, so the insert failed and a bad request read as an internal defect.
      if (!isTargetType(input.targetType)) {
        return err(validationError('invalid_target_type', 'a report is about an experience or a reply'));
      }
      // Resolved, not assumed: a report against a reply id that does not exist used to
      // be written and queued, and a queue item whose target cannot be loaded is one no
      // moderator can ever clear.
      return input.targetType === 'experience'
        ? experienceResource(deps.store, input.targetId)
        : replyResource(deps.store, input.targetId);
    },
    handle: async (input, ctx) => {
      if (!isTargetType(input.targetType)) {
        return err(validationError('invalid_target_type', 'a report is about an experience or a reply'));
      }
      if (!REPORT_REASONS.includes(input.reasonCode)) {
        return err(preconditionError('invalid_reason', 'that is not a valid report reason'));
      }
      const report: Report = {
        id: deps.ids.next('rep'),
        targetType: input.targetType,
        targetId: input.targetId,
        reporterActorId: ctx.actor.actorId,
        reasonCode: input.reasonCode,
        status: 'open',
        createdAt: ctx.clock.now(),
      };
      await deps.store.reports.put(report);
      await enqueue(deps, input.targetType, input.targetId, input.reasonCode === 'naming_shaming' ? 20 : 5);

      return ok({
        // The reporter is acknowledged and told nothing about internal handling.
        value: { reportId: report.id, acknowledged: true },
        events: [
          {
            aggregateType: input.targetType,
            aggregateId: input.targetId,
            eventName: 'ReportFiled',
            payload: { reportId: report.id, reasonCode: input.reasonCode },
          },
        ],
      });
    },
  };

  const claim: CommandHandler<{ queueItemId: string }, { claimed: true }> = {
    name: 'safety.claimQueueItem',
    action: 'moderation.claim',
    resolveResource: async () => ok({ type: 'queue_item' }),
    handle: async (input, ctx) => {
      const item = await deps.store.queueItems.get(input.queueItemId);
      if (!item) return err(notFoundError('queue_item_not_found', 'no such queue item'));
      if (item.state === 'claimed' && item.claimedBy !== ctx.actor.actorId) {
        return err(preconditionError('already_claimed', 'another moderator is handling this'));
      }
      await deps.store.queueItems.put({
        ...item,
        state: 'claimed',
        claimedBy: ctx.actor.actorId,
        claimedAt: ctx.clock.now(),
      });
      return ok({ value: { claimed: true }, events: [] });
    },
  };

  /**
   * The reply branch of `safety.applyModerationAction` — Phase 63.
   *
   * Everything the experience branch does, in the reply's own vocabulary: the action
   * moves the reply through its own transition table, the queue item is cleared, every
   * open report on it is resolved, and the audit trail records who did what and why.
   * Nothing here reads or writes the parent experience.
   */
  const applyToReply = async (
    deps2: EngineDeps,
    input: { targetType: TargetType; targetId: string; action: ModerationActionKind; reason?: unknown },
    ctx: Parameters<CommandHandler<unknown, unknown>['handle']>[1],
    reason: string,
  ) => {
    const reply = await deps2.store.replies.get(input.targetId);
    if (!reply) return err(notFoundError('reply_not_found', 'no such reply'));

    const moderated = moderateReply(reply, input.action);
    if (!moderated.ok) return moderated;
    if (moderated.value.moved) await deps2.store.replies.put(moderated.value.reply);

    await deps2.store.moderationActions.put({
      id: deps2.ids.next('mod'),
      targetType: 'reply',
      targetId: reply.id,
      moderatorId: ctx.actor.actorId,
      action: input.action,
      reason,
      correlationId: ctx.correlationId,
      createdAt: ctx.clock.now(),
    });

    const item = await deps2.store.queueItems.queryOne([
      eq<QueueItem>('targetType', 'reply'),
      eq<QueueItem>('targetId', reply.id),
    ]);
    if (item) await deps2.store.queueItems.put({ ...item, state: 'actioned' });

    const events = [];
    for (const report of await deps2.store.reports.query([
      eq<Report>('targetType', 'reply'),
      eq<Report>('targetId', reply.id),
      eq<Report>('status', 'open'),
    ])) {
      await deps2.store.reports.put({ ...report, status: 'reviewed' });
      events.push({
        aggregateType: 'reply',
        aggregateId: reply.id,
        eventName: 'ReportResolved',
        payload: {
          reportId: report.id,
          reporterActorId: report.reporterActorId,
          targetType: 'reply',
          targetId: reply.id,
          // The experience the reply belongs to, so a consumer keyed on it still works.
          // Read from the reply rather than passed in, because nothing above resolved it.
          experienceId: reply.experienceId,
          outcome: input.action,
        },
      });
    }

    await writeAudit(deps2, ctx, {
      action: 'moderation.action',
      resourceType: 'reply',
      resourceId: reply.id,
      before: { status: reply.status },
      after: { status: moderated.value.reply.status },
    });

    return ok({ value: { applied: input.action }, events });
  };

  const applyAction: CommandHandler<
    { targetType: TargetType; targetId: string; action: ModerationActionKind; reason: string },
    { applied: ModerationActionKind }
  > = {
    name: 'safety.applyModerationAction',
    action: 'moderation.action',
    resolveResource: async (input) => {
      if (!isTargetType(input.targetType)) {
        return err(validationError('invalid_target_type', 'a moderation action targets an experience or a reply'));
      }
      return input.targetType === 'experience'
        ? experienceResource(deps.store, input.targetId)
        : replyResource(deps.store, input.targetId);
    },
    handle: async (input, ctx) => {
      // Checked before anything is written. An action outside the enum used to take
      // neither the remove nor the restore branch and then carry on: it recorded a
      // moderation action naming an action that does not exist, marked the queue item
      // actioned, closed every open report on the target and emitted `ReportResolved`
      // with a nonsense outcome — all while leaving the content exactly as it was.
      // A moderator reading the queue would see the item handled.
      if (!isTargetType(input.targetType)) {
        return err(validationError('invalid_target_type', 'a moderation action targets an experience or a reply'));
      }
      if (!isModerationActionKind(input.action)) {
        return err(validationError('invalid_moderation_action', 'an action warns, removes, restores, or does nothing'));
      }
      const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
      if (reason.length === 0) {
        // The reason is written into the audit trail and into the report outcome. An
        // action with no stated reason is unreviewable by the next moderator.
        return err(validationError('reason_required', 'say why the action was taken'));
      }
      if (reason.length > REVIEW_NOTE_MAX_LENGTH) {
        return err(validationError('reason_too_long', `a reason is at most ${REVIEW_NOTE_MAX_LENGTH} characters`));
      }

      // A reply is moderated as a reply — Phase 63. Until now this fell through to
      // `loadExperience`, so a reported reply could be queued and never actioned, and
      // the queue item was unclearable. Handled first and returned, because a reply and
      // an experience share nothing below this point.
      if (input.targetType === 'reply') {
        return await applyToReply(deps, input, ctx, reason);
      }

      const loaded = await loadExperience(deps.store, input.targetId);
      if (!loaded.ok) return loaded;

      const events = [];
      if (input.action === 'remove') {
        const removed = removeExperience(loaded.value, reason, ctx.clock.now());
        if (!removed.ok) return removed;
        await deps.store.experiences.put(removed.value.experience);
        events.push(...removed.value.events);
      } else if (input.action === 'restore') {
        const restored = restoreExperience(loaded.value, ctx.clock.now());
        if (!restored.ok) return restored;
        await deps.store.experiences.put(restored.value.experience);
        events.push(...restored.value.events);
      }

      await deps.store.moderationActions.put({
        id: deps.ids.next('mod'),
        targetType: input.targetType,
        targetId: input.targetId,
        moderatorId: ctx.actor.actorId,
        action: input.action,
        reason,
        correlationId: ctx.correlationId,
        createdAt: ctx.clock.now(),
      });

      const item = await deps.store.queueItems.queryOne([
        eq<QueueItem>('targetType', input.targetType),
        eq<QueueItem>('targetId', input.targetId),
      ]);
      if (item) await deps.store.queueItems.put({ ...item, state: 'actioned' });

      for (const report of await deps.store.reports.query([
        eq<Report>('targetType', input.targetType),
        eq<Report>('targetId', input.targetId),
        eq<Report>('status', 'open'),
      ])) {
        await deps.store.reports.put({ ...report, status: 'reviewed' });
        /**
         * Emitted per report, and the reason it exists is a dead subscription found during
         * convergence: `trust.recompute` has always listened for `ReportResolved`, and nothing
         * emitted it. Trust follows durable facts, and a report being reviewed is one — so a
         * reporter whose report was resolved by *no action* or a warning never had their
         * contribution history recomputed. Removal happened to work only because
         * `ContentRemoved` is emitted on that branch and the consumer also listens for it.
         *
         * Carries the reporter, which is what the consumer reads, and the outcome — never the
         * report's own text.
         */
        events.push({
          aggregateType: 'experience',
          aggregateId: input.targetId,
          eventName: 'ReportResolved',
          payload: {
            reportId: report.id,
            reporterActorId: report.reporterActorId,
            targetType: input.targetType,
            targetId: input.targetId,
            experienceId: input.targetType === 'experience' ? input.targetId : '',
            outcome: input.action,
          },
        });
      }

      await writeAudit(deps, ctx, {
        action: `moderation.${input.action}`,
        resourceType: input.targetType,
        resourceId: input.targetId,
        before: { status: loaded.value.status },
        after: { action: input.action },
      });

      return ok({ value: { applied: input.action }, events });
    },
  };

  deps.bus.register(fileReport);
  deps.bus.register(claim);
  deps.bus.register(applyAction);
};
