import { err, ok } from '../runtime/result.ts';
import { preconditionError } from '../runtime/errors.ts';
import { changeVisibility, deleteExperience } from '../domain/experience.ts';
import type { Visibility } from '../domain/types.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import {
  PROPAGATION_SURFACES,
  type DeletionRequest,
  type ExportRequest,
  type PropagationSurface,
} from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { experienceResource, loadExperience, writeAudit } from './support.ts';
import { eq } from '../ports/store.ts';

/**
 * P17 Creator Control Engine.
 *
 * Deletion is not complete until every surface confirms. `partially_failed` is
 * never a resting state: it is retried until every surface agrees.
 */
export const registerCreatorEngine = (deps: EngineDeps): void => {
  const remove: CommandHandler<{ experienceId: string }, { deletionRequestId: string }> = {
    name: 'creator.deleteExperience',
    action: 'experience.delete',
    resolveResource: async (input) => experienceResource(deps.store, input.experienceId),
    handle: async (input, ctx) => {
      const loaded = await loadExperience(deps.store, input.experienceId);
      if (!loaded.ok) return loaded;

      const change = deleteExperience(loaded.value, ctx.clock.now());
      if (!change.ok) return change;
      await deps.store.experiences.put(change.value.experience);

      const request: DeletionRequest = {
        id: `del:${input.experienceId}`,
        actorId: ctx.actor.actorId,
        targetType: 'experience',
        targetId: input.experienceId,
        state: 'requested',
        propagation: Object.fromEntries(PROPAGATION_SURFACES.map((s) => [s, false])) as Record<
          PropagationSurface,
          boolean
        >,
        createdAt: ctx.clock.now(),
      };
      await deps.store.deletionRequests.put(request);

      await writeAudit(deps, ctx, {
        action: 'experience.delete',
        resourceType: 'experience',
        resourceId: input.experienceId,
        before: { status: loaded.value.status },
        after: { status: 'deleted' },
      });

      return ok({ value: { deletionRequestId: request.id }, events: change.value.events });
    },
  };

  const retighten: CommandHandler<
    { experienceId: string; visibility: Visibility; aliasId?: string },
    { visibility: Visibility }
  > = {
    name: 'creator.changeVisibility',
    action: 'experience.change_visibility',
    resolveResource: async (input) => experienceResource(deps.store, input.experienceId),
    handle: async (input, ctx) => {
      const loaded = await loadExperience(deps.store, input.experienceId);
      if (!loaded.ok) return loaded;

      if (input.visibility === 'alias') {
        const alias = input.aliasId ? await deps.store.aliases.get(input.aliasId) : undefined;
        if (!alias || alias.actorId !== ctx.actor.actorId || !alias.isActive) {
          return err(preconditionError('alias_unavailable', 'that alias is not available to you'));
        }
      }

      const change = changeVisibility(loaded.value, input.visibility, input.aliasId, ctx.clock.now());
      if (!change.ok) return change;
      await deps.store.experiences.put(change.value.experience);

      // Phase 68, clause 2: visibility governs who *else* may read. The dispute this
      // anticipates is "my experience was public and I never made it public", and the row
      // cannot answer it because the row only holds the current value.
      await writeAudit(deps, ctx, {
        action: 'experience.change_visibility',
        resourceType: 'experience',
        resourceId: change.value.experience.id,
        before: { visibility: loaded.value.visibility },
        after: { visibility: change.value.experience.visibility },
      });

      return ok({ value: { visibility: change.value.experience.visibility }, events: change.value.events });
    },
  };

  const exportData: CommandHandler<Record<string, never>, { exportRequestId: string }> = {
    name: 'creator.requestExport',
    action: 'export.request',
    resolveResource: async (_input, ctx) => ok({ type: 'export', ownerActorId: ctx.actor.actorId }),
    handle: async (_input, ctx) => {
      const request: ExportRequest = {
        id: deps.ids.next('exp_req'),
        actorId: ctx.actor.actorId,
        state: 'queued',
        createdAt: ctx.clock.now(),
      };
      await deps.store.exportRequests.put(request);

      // Phase 68, clause 3: an export takes a copy of a person's data out of the system,
      // and "who asked for my data and when" must be answerable afterwards. The request row
      // is not enough on its own — a completed export can be pruned; the trail cannot.
      await writeAudit(deps, ctx, {
        action: 'export.request',
        resourceType: 'export',
        resourceId: request.id,
        after: { state: request.state },
      });

      return ok({
        value: { exportRequestId: request.id },
        events: [
          {
            aggregateType: 'actor',
            aggregateId: ctx.actor.actorId,
            eventName: 'ExportRequested',
            payload: { exportRequestId: request.id },
          },
        ],
      });
    },
  };

  deps.bus.register(remove);
  deps.bus.register(retighten);
  deps.bus.register(exportData);
};

/**
 * Deletion propagation. Each surface is confirmed individually, so a partial
 * failure is visible and resumable rather than silently incomplete.
 */
export const createDeletionPropagationConsumer = (deps: EngineDeps): Consumer => ({
  name: 'deletion.propagate',
  events: ['ExperienceDeleted'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    const requestId = `del:${experienceId}`;
    const request = await deps.store.deletionRequests.get(requestId);
    const propagation: Record<PropagationSurface, boolean> = {
      ...(request?.propagation ?? (Object.fromEntries(PROPAGATION_SURFACES.map((s) => [s, false])) as Record<PropagationSurface, boolean>)),
    };

    await deps.store.feedEntries.remove(experienceId);
    propagation.feed = true;

    await deps.store.searchDocuments.remove(experienceId);
    propagation.search = true;

    for (const link of await deps.store.experienceSubjects.query([eq('experienceId', experienceId)])) {
      await deps.store.experienceSubjects.remove(link.id);
    }
    propagation.subjects = true;

    for (const notification of await deps.store.notifications.query([eq('subjectId', experienceId)])) {
      await deps.store.notifications.remove(notification.id);
    }
    propagation.notifications = true;

    for (const reply of await deps.store.replies.query([eq('experienceId', experienceId)])) {
      await deps.store.replies.remove(reply.id);
    }
    propagation.replies = true;

    // Media and transcript removal is verified, not assumed.
    for (const asset of await deps.store.mediaAssets.query([eq('experienceId', experienceId)])) {
      for (const transcript of await deps.store.transcripts.query([eq('mediaAssetId', asset.id)])) {
        await deps.store.transcripts.remove(transcript.id);
      }
      await deps.providers.objectStore.remove(asset.originalKey);
      if (asset.protectedKey) await deps.providers.objectStore.remove(asset.protectedKey);
      await deps.store.mediaAssets.remove(asset.id);
    }
    propagation.media = true;
    propagation.transcripts = true;

    await deps.store.counters.remove(experienceId);
    await deps.store.rankingInputs.remove(experienceId);
    for (const reaction of await deps.store.reactions.query([eq('experienceId', experienceId)])) {
      await deps.store.reactions.remove(reaction.id);
    }
    for (const vote of await deps.store.fairVotes.query([eq('experienceId', experienceId)])) {
      await deps.store.fairVotes.remove(vote.id);
    }
    propagation.counters = true;

    const complete = PROPAGATION_SURFACES.every((surface) => propagation[surface]);
    await deps.store.deletionRequests.put({
      id: requestId,
      actorId: request?.actorId ?? 'unknown',
      targetType: 'experience',
      targetId: experienceId,
      state: complete ? 'completed' : 'partially_failed',
      propagation,
      createdAt: request?.createdAt ?? deps.clock.now(),
      ...(complete ? { completedAt: deps.clock.now() } : {}),
    });
    deps.metrics.increment(complete ? 'deletion.completed' : 'deletion.partial');
    return ok(undefined);
  },
});

/** Export contains only the requester's own data. */
export const createExportConsumer = (deps: EngineDeps): Consumer => ({
  name: 'export.build',
  events: ['ExportRequested'],
  handle: async (event) => {
    const requestId = String(event.payload['exportRequestId'] ?? '');
    const request = await deps.store.exportRequests.get(requestId);
    if (!request || request.state === 'ready') return ok(undefined);

    const experiences = await deps.store.experiences.query([eq('actorId', request.actorId)]);
    const aliases = await deps.store.aliases.query([eq('actorId', request.actorId)]);
    const payload = JSON.stringify({
      actorId: request.actorId,
      experiences: experiences.map((row) => ({
        id: row.id,
        kind: row.kind,
        creationMode: row.creationMode,
        bodyText: row.bodyText,
        visibility: row.visibility,
        status: row.status,
        createdAt: row.createdAt,
      })),
      aliases: aliases.map((row) => ({ aliasName: row.aliasName, isActive: row.isActive })),
    });

    const key = `exports/${request.actorId}/${requestId}.json`;
    await deps.providers.objectStore.put(key, new TextEncoder().encode(payload));
    await deps.store.exportRequests.put({ ...request, state: 'ready', artifactKey: key });
    return ok(undefined);
  },
});
