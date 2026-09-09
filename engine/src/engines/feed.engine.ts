import { ok } from '../runtime/result.ts';
import { toPublicExperience } from '../domain/projection.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { FeedEntry } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { excerptOf } from './support.ts';

/**
 * P5 Feed Engine.
 *
 * The projection is written from the public projection helper, so the feed row
 * carries an identity *label* and never an actor reference — the row type has
 * nowhere to put one.
 */
export const createFeedProjectionConsumer = (deps: EngineDeps): Consumer => ({
  name: 'feed.project',
  events: ['ExperiencePublished', 'ContentRestored'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    const experience = await deps.store.experiences.get(experienceId);
    if (!experience || experience.status !== 'published') return ok(undefined);

    const actor = await deps.store.actors.get(experience.actorId);
    const alias = experience.aliasId ? await deps.store.aliases.get(experience.aliasId) : undefined;
    const asset = experience.mediaAssetId ? await deps.store.mediaAssets.get(experience.mediaAssetId) : undefined;

    const projection = toPublicExperience(experience, {
      ...(actor?.displayName === undefined ? {} : { displayName: actor.displayName }),
      ...(alias === undefined ? {} : { alias }),
      ...(asset?.durationMs === undefined ? {} : { durationMs: asset.durationMs }),
    });

    const entry: FeedEntry = {
      // Keyed by experience id, so re-delivery overwrites rather than duplicates.
      id: experienceId,
      experienceId,
      kind: projection.kind,
      creationMode: projection.creationMode,
      category: projection.category,
      excerpt: excerptOf(projection.bodyText),
      identityLabel: projection.identity.label,
      identityKind: projection.identity.kind,
      hasVoice: projection.hasVoice,
      ...(projection.durationMs === undefined ? {} : { durationMs: projection.durationMs }),
      publishedAt: projection.publishedAt,
      rankScore: 0,
      suppressed: false,
    };
    await deps.store.feedEntries.put(entry);
    deps.metrics.increment('feed.projected', { kind: entry.kind, mode: entry.creationMode });
    return ok(undefined);
  },
});

/** Removal, hiding and review all take content off the feed. */
export const createFeedSuppressionConsumer = (deps: EngineDeps): Consumer => ({
  name: 'feed.suppress',
  events: ['ContentRemoved', 'ExperienceHidden', 'ExperienceUnderReview'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    const entry = await deps.store.feedEntries.get(experienceId);
    if (!entry) return ok(undefined);
    await deps.store.feedEntries.put({ ...entry, suppressed: true });
    return ok(undefined);
  },
});

/** Deletion purges the row outright rather than suppressing it. */
export const createFeedPurgeConsumer = (deps: EngineDeps): Consumer => ({
  name: 'feed.purge',
  events: ['ExperienceDeleted'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    await deps.store.feedEntries.remove(experienceId);
    return ok(undefined);
  },
});
