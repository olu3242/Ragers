import { err, ok } from '../runtime/result.ts';
import { notFoundError, preconditionError } from '../runtime/errors.ts';
import { publishExperience, removeExperience, restoreExperience } from '../domain/experience.ts';
import { REPORT_REASONS, type ModerationActionKind, type ReportReason } from '../domain/types.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import { eq } from '../ports/store.ts';
import type { QueueItem, Report, TargetType } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { experienceResource, loadExperience, writeAudit } from './support.ts';

/**
 * P9 Trust & Safety Engine.
 *
 * The defining property is that screening **fails closed**: if it cannot run,
 * the experience stays in `pending_moderation` and is never published. A
 * reporter learns nothing about internal handling (PRD §6.3).
 */

const enqueue = async (
  deps: EngineDeps,
  targetType: TargetType,
  targetId: string,
  priority: number,
): Promise<void> => {
  const existing = await deps.store.queueItems.queryOne([
    eq<QueueItem>('targetType', targetType),
    eq<QueueItem>('targetId', targetId),
  ]);
  if (existing) return; // idempotent
  const item: QueueItem = {
    id: deps.ids.next('mq'),
    targetType,
    targetId,
    priority,
    state: 'queued',
    createdAt: deps.clock.now(),
  };
  await deps.store.queueItems.put(item);
};

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
    resolveResource: async (input) =>
      input.targetType === 'experience'
        ? experienceResource(deps.store, input.targetId)
        : ok({ type: 'reply', id: input.targetId }),
    handle: async (input, ctx) => {
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

  const applyAction: CommandHandler<
    { targetType: TargetType; targetId: string; action: ModerationActionKind; reason: string },
    { applied: ModerationActionKind }
  > = {
    name: 'safety.applyModerationAction',
    action: 'moderation.action',
    resolveResource: async (input) =>
      input.targetType === 'experience'
        ? experienceResource(deps.store, input.targetId)
        : ok({ type: 'reply', id: input.targetId }),
    handle: async (input, ctx) => {
      const loaded = await loadExperience(deps.store, input.targetId);
      if (!loaded.ok) return loaded;

      const events = [];
      if (input.action === 'remove') {
        const removed = removeExperience(loaded.value, input.reason, ctx.clock.now());
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
        reason: input.reason,
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
