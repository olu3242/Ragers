import { ok } from '../runtime/result.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import { eq } from '../ports/store.ts';
import type { Experience } from '../domain/experience.ts';
import type { ActorReputation, Standing } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * P15 Reputation & Context Engine.
 *
 * Everything is derived from durable facts, so drift is always repairable by
 * replay. Internal signals are moderator-only; the public shape carries the
 * approval rate and counts and nothing else.
 */
export const standingFor = (
  experiencesPublished: number,
  approvalRate: number,
  removalsReceived: number,
): Standing => {
  if (removalsReceived >= 3) return 'limited';
  if (experiencesPublished >= 20 && approvalRate >= 0.8) return 'trusted';
  if (experiencesPublished >= 3) return 'established';
  return 'new';
};

export const recomputeReputation = async (deps: EngineDeps, actorId: string): Promise<ActorReputation> => {
  const experiences = await deps.store.experiences.query([eq('actorId', actorId)]);
  const published = experiences.filter((row) => row.status === 'published');
  const removals = experiences.filter((row) => row.status === 'removed').length;

  let fairYes = 0;
  let fairNo = 0;
  for (const experience of experiences) {
    const votes = await deps.store.fairVotes.query([eq('experienceId', experience.id)]);
    fairYes += votes.filter((row) => row.isFair).length;
    fairNo += votes.filter((row) => !row.isFair).length;
  }

  const totalVotes = fairYes + fairNo;
  const approvalRate = totalVotes === 0 ? 0 : Number((fairYes / totalVotes).toFixed(4));

  const reputation: ActorReputation = {
    id: actorId,
    actorId,
    experiencesPublished: published.length,
    fairYesReceived: fairYes,
    fairNoReceived: fairNo,
    approvalRate,
    removalsReceived: removals,
    standing: standingFor(published.length, approvalRate, removals),
    internalSignals: {
      // Internal-only context. Never present in a public projection.
      totalDrafts: experiences.length - published.length,
      voteVolume: totalVotes,
    },
    updatedAt: deps.clock.now(),
  };
  await deps.store.reputation.put(reputation);
  return reputation;
};

export const createReputationConsumer = (deps: EngineDeps): Consumer => ({
  name: 'reputation.recompute',
  events: ['ExperiencePublished', 'FairVoteCast', 'FairVoteChanged', 'ContentRemoved', 'ContentRestored'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    const experience = await deps.store.experiences.get(experienceId);
    if (!experience) return ok(undefined);
    await recomputeReputation(deps, experience.actorId);
    return ok(undefined);
  },
});

export interface PublicReputation {
  readonly experiencesPublished: number;
  readonly approvalRate: number;
  readonly totalFairVotes: number;
}

/** The public shape. Standing and internal signals are deliberately absent. */
export const publicReputationOf = async (
  deps: EngineDeps,
  actorId: string,
): Promise<PublicReputation> => {
  const row = await deps.store.reputation.get(actorId);
  if (!row) return { experiencesPublished: 0, approvalRate: 0, totalFairVotes: 0 };
  return {
    experiencesPublished: row.experiencesPublished,
    approvalRate: row.approvalRate,
    totalFairVotes: row.fairYesReceived + row.fairNoReceived,
  };
};

/**
 * Alias reputation is keyed by alias and reports only that alias's activity, so
 * it cannot be used to link an alias back to the account behind it.
 */
export interface AliasReputation {
  readonly aliasName: string;
  readonly experiencesPublished: number;
  readonly approvalRate: number;
}

export const aliasReputationOf = async (
  deps: EngineDeps,
  aliasId: string,
): Promise<AliasReputation | undefined> => {
  const alias = await deps.store.aliases.get(aliasId);
  if (!alias) return undefined;

  const experiences = await deps.store.experiences.query([
    eq<Experience>('aliasId', aliasId),
    eq<Experience>('status', 'published'),
  ]);
  let fairYes = 0;
  let total = 0;
  for (const experience of experiences) {
    const votes = await deps.store.fairVotes.query([eq('experienceId', experience.id)]);
    fairYes += votes.filter((row) => row.isFair).length;
    total += votes.length;
  }
  return {
    aliasName: alias.aliasName,
    experiencesPublished: experiences.length,
    approvalRate: total === 0 ? 0 : Number((fairYes / total).toFixed(4)),
  };
};
