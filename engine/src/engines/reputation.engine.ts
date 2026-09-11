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


/**
 * Contribution view — E11, person side.
 *
 * Three separately-named indicators and no composite. There is deliberately no
 * single number: a score next to somebody's name turns every contribution into a
 * referendum on the contributor, and falls hardest on new accounts and on people
 * posting anonymously — which is to say on exactly the people the product exists to
 * make safe.
 *
 * What is *not* here, by construction:
 *
 *   * nothing from `internalSignals` or `trust_assessments` — those are moderator
 *     surfaces, and exposing a risk feature would let a viewer infer a suspicion
 *     nobody has acted on;
 *   * no popularity: shares, reactions and view counts are absent, because
 *     reputation is not popularity;
 *   * no figure at all below the sample floor, stated as "not enough yet" rather
 *     than as a precise-looking number from two data points.
 */
export const MINIMUM_CONTRIBUTION_SAMPLE = 3;

export interface ContributionView {
  readonly experiencesPublished: number;
  /** Experiences of theirs that other people said happened to them too. */
  readonly corroboratedExperiences: number;
  /** Claims this person made on other people's experiences that are still active. */
  readonly corroborationsGiven: number;
  /** Pieces of evidence they attached that a reviewer found consistent. */
  readonly consistentEvidence: number;
  /** Share of Fair Rager? votes in their favour, withheld below the floor. */
  readonly approvalRate?: number;
  readonly totalFairVotes: number;
  readonly insufficientSample: boolean;
  readonly caption: string;
}

export const contributionViewOf = async (
  deps: EngineDeps,
  actorId: string,
): Promise<ContributionView> => {
  const row = await deps.store.reputation.get(actorId);
  const experiences = await deps.store.experiences.query([
    eq<Experience>('actorId', actorId),
    eq<Experience>('status', 'published'),
  ]);

  let corroborated = 0;
  for (const experience of experiences) {
    const count = await deps.store.corroborations.countWhere([
      eq('experienceId', experience.id),
      eq('status', 'active'),
    ]);
    if (count > 0) corroborated += 1;
  }

  const standing = await deps.store.corroborations.countWhere([
    eq('corroboratorId', actorId),
    eq('status', 'active'),
  ]);

  const evidence = await deps.store.evidence.query([eq('submittedBy', actorId)]);
  let consistent = 0;
  for (const item of evidence) {
    const assessments = await deps.store.evidenceAssessments.query([eq('evidenceId', item.id)]);
    if (assessments.some((assessment) => assessment.outcome === 'consistent')) consistent += 1;
  }

  const totalFairVotes = (row?.fairYesReceived ?? 0) + (row?.fairNoReceived ?? 0);
  const insufficient = experiences.length < MINIMUM_CONTRIBUTION_SAMPLE;

  return {
    experiencesPublished: experiences.length,
    corroboratedExperiences: corroborated,
    corroborationsGiven: standing,
    consistentEvidence: consistent,
    // Withheld rather than shown small: an approval rate from one vote is noise
    // wearing the clothes of a measurement.
    ...(insufficient || totalFairVotes < MINIMUM_CONTRIBUTION_SAMPLE
      ? {}
      : { approvalRate: row?.approvalRate ?? 0 }),
    totalFairVotes,
    insufficientSample: insufficient,
    caption: insufficient
      ? 'Too little activity to describe a pattern yet.'
      : 'Counts of what this person contributed and what others confirmed. Not a score, and not popularity.',
  };
};
