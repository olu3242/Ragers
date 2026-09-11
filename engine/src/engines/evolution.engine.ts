import { eq } from '../ports/store.ts';
import {
  approvalSeries,
  cumulativeSeries,
  type ReputationEvolution,
} from '../domain/evolution.ts';
import type { Experience } from '../domain/experience.ts';
import type { EngineDeps } from './deps.ts';

/**
 * Reputation Evolution — E11. Phase 56.
 *
 * Derived on read from timestamped rows, like every other series in this band. The
 * boundaries are period ends; each point counts the whole set as of that boundary
 * rather than folding forward, so this is replayable and a duplicated delivery cannot
 * inflate it.
 *
 * Every read below is over the same rows Phase 15's `contributionViewOf` uses, so a
 * profile and its trend cannot disagree about what the person did.
 */
export const DEFAULT_EVOLUTION_PERIOD_MS = 30 * 86_400_000;
export const DEFAULT_EVOLUTION_PERIODS = 6;

export const reputationEvolutionFor = async (
  deps: EngineDeps,
  actorId: string,
  options: { readonly periodMs?: number; readonly periods?: number } = {},
): Promise<ReputationEvolution | undefined> => {
  const actor = await deps.store.actors.get(actorId);
  if (!actor) return undefined;

  const periodMs = Math.max(86_400_000, options.periodMs ?? DEFAULT_EVOLUTION_PERIOD_MS);
  const periods = Math.max(2, Math.min(options.periods ?? DEFAULT_EVOLUTION_PERIODS, 24));
  const now = deps.clock.now();
  const boundaries = Array.from({ length: periods }, (_, index) => now - (periods - 1 - index) * periodMs);

  const own = await deps.store.experiences.query([
    eq<Experience>('actorId', actorId),
    eq<Experience>('status', 'published'),
  ]);
  const publishedAt = own.map((experience) => experience.publishedAt ?? experience.createdAt);

  // When each of their experiences *first* drew a corroboration. The moment somebody
  // else said it happened to them too is the fact worth dating; later ones are the
  // same experience being corroborated again, not another of theirs being confirmed.
  const corroboratedAt: number[] = [];
  for (const experience of own) {
    const claims = await deps.store.corroborations.query(
      [eq('experienceId', experience.id), eq('status', 'active')],
      { orderBy: { field: 'createdAt', direction: 'asc' } },
    );
    const firstClaim = claims[0];
    if (firstClaim) corroboratedAt.push(firstClaim.createdAt);
  }

  const givenAt = (
    await deps.store.corroborations.query([eq('corroboratorId', actorId), eq('status', 'active')])
  ).map((claim) => claim.createdAt);

  // Evidence of theirs a reviewer found consistent — dated by the *assessment*, since
  // that is when the fact came into being, not by when they uploaded it.
  const consistentAt: number[] = [];
  for (const item of await deps.store.evidence.query([eq('submittedBy', actorId)])) {
    for (const assessment of await deps.store.evidenceAssessments.query([eq('evidenceId', item.id)])) {
      if (assessment.outcome === 'consistent') consistentAt.push(assessment.createdAt);
    }
  }

  // Fair Rager? votes cast on their experiences. Other people's judgements, so this
  // is the one component with a floor.
  const votes: { at: number; inFavour: boolean }[] = [];
  for (const experience of own) {
    for (const vote of await deps.store.fairVotes.query([eq('experienceId', experience.id)])) {
      votes.push({ at: vote.createdAt, inFavour: vote.isFair });
    }
  }

  return {
    actorId,
    counts: [
      cumulativeSeries('experiences_published', publishedAt, boundaries),
      cumulativeSeries('corroborated_experiences', corroboratedAt, boundaries),
      cumulativeSeries('corroborations_given', givenAt, boundaries),
      cumulativeSeries('consistent_evidence', consistentAt, boundaries),
    ],
    approval: approvalSeries(votes, boundaries),
  };
};
