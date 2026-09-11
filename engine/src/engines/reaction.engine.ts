import { err, ok } from '../runtime/result.ts';
import { preconditionError, validationError } from '../runtime/errors.ts';
import {
  isReactionType,
  REJECTED_REACTION_TYPES,
  RETIRED_REACTION_TYPES,
  type ReactionType,
} from '../domain/types.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import { eq } from '../ports/store.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { EngineDeps } from './deps.ts';
import { experienceResource, recomputeCounters } from './support.ts';

/**
 * P6 Reaction Engine — Ragers-native mechanics only.
 *
 * `same`, `fair_point`, `disagree`, plus the `Fair Rager?` fairness vote. These
 * are *responses* to a claim; the claim itself ("this happened to me too") is a
 * corroboration and lives in the Corroboration Engine. A generic Like / Upvote /
 * Repost is rejected by name, so the engagement model cannot drift into a
 * conventional social feed.
 */
export const registerReactionEngine = (deps: EngineDeps): void => {
  const toggle: CommandHandler<
    { experienceId: string; reactionType: ReactionType },
    { active: boolean; reactionType: ReactionType }
  > = {
    name: 'reaction.toggle',
    action: 'reaction.toggle',
    resolveResource: async (input) => experienceResource(deps.store, input.experienceId),
    handle: async (input, ctx) => {
      if (REJECTED_REACTION_TYPES.includes(String(input.reactionType))) {
        return err(
          validationError('reaction_mechanic_not_supported', 'Ragers does not use that engagement mechanic', {
            reactionType: input.reactionType,
          }),
        );
      }
      if (RETIRED_REACTION_TYPES.includes(String(input.reactionType))) {
        return err(
          validationError('reaction_retired', 'Been There is now Re-Rage — corroborate the experience instead', {
            reactionType: input.reactionType,
            use: 'corroboration.create',
          }),
        );
      }
      if (!isReactionType(input.reactionType)) {
        return err(validationError('invalid_reaction_type', 'that is not a Ragers reaction'));
      }

      // The natural key makes the toggle idempotent under concurrency.
      const id = `${input.experienceId}:${ctx.actor.actorId}:${input.reactionType}`;
      const existing = await deps.store.reactions.get(id);

      if (existing) {
        await deps.store.reactions.remove(id);
        return ok({
          value: { active: false, reactionType: input.reactionType },
          events: [
            {
              aggregateType: 'experience',
              aggregateId: input.experienceId,
              eventName: 'ReactionRemoved',
              payload: { experienceId: input.experienceId, reactionType: input.reactionType },
            },
          ],
        });
      }

      await deps.store.reactions.put({
        id,
        experienceId: input.experienceId,
        actorId: ctx.actor.actorId,
        reactionType: input.reactionType,
        createdAt: ctx.clock.now(),
      });
      return ok({
        value: { active: true, reactionType: input.reactionType },
        events: [
          {
            aggregateType: 'experience',
            aggregateId: input.experienceId,
            eventName: 'ReactionAdded',
            payload: {
              experienceId: input.experienceId,
              reactionType: input.reactionType,
              reactorActorId: ctx.actor.actorId,
            },
          },
        ],
      });
    },
  };

  const castVote: CommandHandler<{ experienceId: string; isFair: boolean }, { recast: boolean }> = {
    name: 'reaction.castFairVote',
    action: 'fair_vote.cast',
    resolveResource: async (input) => experienceResource(deps.store, input.experienceId),
    handle: async (input, ctx) => {
      if (typeof input.isFair !== 'boolean') {
        return err(validationError('invalid_vote', 'isFair must be true or false'));
      }
      // One vote per actor per experience: a recast updates, never duplicates.
      const id = `${input.experienceId}:${ctx.actor.actorId}`;
      const existing = await deps.store.fairVotes.get(id);

      if (existing && existing.isFair === input.isFair) {
        return ok({ value: { recast: false }, events: [] }); // idempotent no-op
      }

      await deps.store.fairVotes.put({
        id,
        experienceId: input.experienceId,
        actorId: ctx.actor.actorId,
        isFair: input.isFair,
        createdAt: existing?.createdAt ?? ctx.clock.now(),
        updatedAt: ctx.clock.now(),
      });

      return ok({
        value: { recast: existing !== undefined },
        events: [
          {
            aggregateType: 'experience',
            aggregateId: input.experienceId,
            eventName: existing ? 'FairVoteChanged' : 'FairVoteCast',
            payload: {
              experienceId: input.experienceId,
              isFair: input.isFair,
              voterActorId: ctx.actor.actorId,
            },
          },
        ],
      });
    },
  };

  deps.bus.register(toggle);
  deps.bus.register(castVote);
};

/**
 * Counters are recomputed from the rows rather than incremented, so they
 * converge regardless of delivery order or duplication.
 */
export const createCounterProjectionConsumer = (deps: EngineDeps): Consumer => ({
  name: 'counters.recompute',
  events: [
    'ReactionAdded',
    'ReactionRemoved',
    'FairVoteCast',
    'FairVoteChanged',
    'ReplyPublished',
    'ReplyDeleted',
  ],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    if (!experienceId) return ok(undefined);
    await recomputeCounters(deps, experienceId);
    return ok(undefined);
  },
});

export interface FairnessSummary {
  readonly fairYes: number;
  readonly fairNo: number;
  readonly totalVotes: number;
  /** Percentage of "fair" votes, or undefined when nobody has voted. */
  readonly fairPercent?: number;
}

export const summariseFairness = (fairYes: number, fairNo: number): FairnessSummary => {
  const totalVotes = fairYes + fairNo;
  if (totalVotes === 0) return { fairYes, fairNo, totalVotes };
  return { fairYes, fairNo, totalVotes, fairPercent: Math.round((fairYes / totalVotes) * 100) };
};
