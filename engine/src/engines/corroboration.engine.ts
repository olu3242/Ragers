import { err, ok } from '../runtime/result.ts';
import { conflictError, notFoundError, preconditionError } from '../runtime/errors.ts';
import {
  createCorroboration,
  createShare,
  retractCorroboration,
  type CorroborationType,
  type MatchRelationship,
} from '../domain/corroboration.ts';
import { eq } from '../ports/store.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { CorroborationRow } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { experienceResource, loadExperience, recomputeCounters } from './support.ts';

/**
 * Corroboration Engine — "this happened to me too".
 *
 * A corroboration is a claim, not a repost and not a reaction. The engine's job
 * is to keep that meaning intact: one claim per person per experience, the right
 * kind for the experience, and counts that recompute rather than increment so a
 * retry or a retraction converges.
 */
/**
 * The natural key of a claim. Deterministic on purpose: it is what makes "one
 * corroboration per person per experience" an invariant the store enforces
 * rather than a check the application hopes to win.
 */
export const corroborationKey = (experienceId: string, corroboratorId: string): string =>
  `${experienceId}:${corroboratorId}`;

export interface CorroborateInput {
  readonly experienceId: string;
  readonly type: CorroborationType;
  readonly relationship?: MatchRelationship;
  readonly narrative?: string;
  readonly occurredAt?: number;
  readonly locationId?: string;
  readonly mediaAssetId?: string;
  readonly visibility?: 'public' | 'alias' | 'anonymous';
  readonly aliasId?: string;
}

export interface CorroborateResult {
  readonly corroborationId: string;
  readonly type: CorroborationType;
  readonly relationship: MatchRelationship;
  /** Corroborations on this experience after the claim, recomputed from rows. */
  readonly corroborationCount: number;
}

export const registerCorroborationEngine = (deps: EngineDeps): void => {
  const corroborate: CommandHandler<CorroborateInput, CorroborateResult> = {
    name: 'corroboration.create',
    action: 'corroboration.create',
    resolveResource: async (input) => experienceResource(deps.store, input.experienceId),
    handle: async (input, ctx) => {
      const loaded = await loadExperience(deps.store, input.experienceId);
      if (!loaded.ok) return loaded;
      const experience = loaded.value;

      if (experience.status !== 'published') {
        return err(
          preconditionError('experience_not_published', `cannot corroborate a ${experience.status} experience`),
        );
      }

      // One claim per person per experience, keyed on that natural pair rather
      // than on a fresh id per attempt: eight simultaneous taps must collide on
      // one row, and a generated id gives them nothing to collide on.
      const corroborationId = corroborationKey(input.experienceId, ctx.actor.actorId);
      const existing = await deps.store.corroborations.get(corroborationId);
      if (existing && existing.status === 'active') {
        return err(
          conflictError('already_corroborated', 'you have already said this happened to you', {
            corroborationId: existing.id,
          }),
        );
      }
      if (existing && existing.status === 'removed') {
        return err(
          preconditionError('corroboration_removed', 'this claim was removed and cannot be reinstated'),
        );
      }

      if (input.visibility === 'alias') {
        const alias = input.aliasId ? await deps.store.aliases.get(input.aliasId) : undefined;
        if (!alias || alias.actorId !== ctx.actor.actorId || !alias.isActive) {
          return err(preconditionError('alias_unavailable', 'that alias is not available to you'));
        }
      }

      const created = createCorroboration(
        {
          ...input,
          corroboratorId: ctx.actor.actorId,
          experienceKind: experience.kind,
          experienceAuthorId: experience.actorId,
        },
        {
          id: corroborationId,
          correlationId: ctx.correlationId,
          now: ctx.clock.now(),
        },
      );
      if (!created.ok) return created;

      // The store decides the race, not the read above: `absent` for a first
      // claim, `retracted` for someone changing their mind back. A caller that
      // loses is told so, instead of being handed a success it never had.
      const won = existing
        ? await deps.store.corroborations.compareAndSet(created.value, [
            eq<CorroborationRow>('status', 'retracted'),
          ])
        : await deps.store.corroborations.compareAndSet(created.value, 'absent');
      if (!won) {
        return err(
          conflictError('already_corroborated', 'you have already said this happened to you', {
            corroborationId,
          }),
        );
      }

      const corroborationCount = await deps.store.corroborations.countWhere([
        eq<CorroborationRow>('experienceId', input.experienceId),
        eq<CorroborationRow>('status', 'active'),
      ]);

      return ok({
        value: {
          corroborationId: created.value.id,
          type: created.value.type,
          relationship: created.value.relationship,
          corroborationCount,
        },
        events: [
          {
            aggregateType: 'experience',
            aggregateId: input.experienceId,
            eventName: created.value.type === 're_rage' ? 'ExperienceReRaged' : 'ExperienceReRaved',
            payload: {
              experienceId: input.experienceId,
              corroborationId: created.value.id,
              corroboratorActorId: ctx.actor.actorId,
              type: created.value.type,
              relationship: created.value.relationship,
              hasNarrative: created.value.narrative !== undefined,
              hasVoice: created.value.mediaAssetId !== undefined,
            },
          },
        ],
      });
    },
  };

  const retract: CommandHandler<{ corroborationId: string }, { retracted: true; corroborationCount: number }> = {
    name: 'corroboration.retract',
    action: 'corroboration.retract',
    resolveResource: async (input) => {
      const row = await deps.store.corroborations.get(input.corroborationId);
      if (!row) return err(notFoundError('corroboration_not_found', 'no such corroboration'));
      return ok({ type: 'corroboration', id: row.id, ownerActorId: row.corroboratorId });
    },
    handle: async (input, ctx) => {
      const row = await deps.store.corroborations.get(input.corroborationId);
      if (!row) return err(notFoundError('corroboration_not_found', 'no such corroboration'));

      const retracted = retractCorroboration(row, ctx.clock.now());
      if (!retracted.ok) return retracted;
      await deps.store.corroborations.put(retracted.value);

      const corroborationCount = await deps.store.corroborations.countWhere([
        eq<CorroborationRow>('experienceId', row.experienceId),
        eq<CorroborationRow>('status', 'active'),
      ]);

      return ok({
        value: { retracted: true, corroborationCount },
        events: [
          {
            aggregateType: 'experience',
            aggregateId: row.experienceId,
            eventName: 'CorroborationRetracted',
            payload: { experienceId: row.experienceId, corroborationId: row.id },
          },
        ],
      });
    },
  };

  /**
   * Share. Deliberately its own command, its own table and its own event, with
   * no path to a corroboration counter — "shared 12,481 times" must never be
   * mistaken for "12,481 people experienced this".
   */
  const share: CommandHandler<{ experienceId: string; destination?: string }, { shareId: string; shareCount: number }> = {
    name: 'share.create',
    action: 'share.create',
    resolveResource: async (input) => experienceResource(deps.store, input.experienceId),
    handle: async (input, ctx) => {
      const loaded = await loadExperience(deps.store, input.experienceId);
      if (!loaded.ok) return loaded;
      if (loaded.value.status !== 'published') {
        return err(preconditionError('experience_not_published', 'only published experiences can be shared'));
      }

      const created = createShare(
        {
          experienceId: input.experienceId,
          ...(ctx.actor.authenticated ? { actorId: ctx.actor.actorId } : {}),
          ...(input.destination === undefined ? {} : { destination: input.destination }),
        },
        { id: deps.ids.next('shr'), now: ctx.clock.now() },
      );
      if (!created.ok) return created;
      await deps.store.shares.put(created.value);

      const shareCount = await deps.store.shares.countWhere([eq('experienceId', input.experienceId)]);

      return ok({
        value: { shareId: created.value.id, shareCount },
        events: [
          {
            aggregateType: 'experience',
            aggregateId: input.experienceId,
            eventName: 'ExperienceShared',
            payload: { experienceId: input.experienceId, destination: created.value.destination ?? 'unspecified' },
          },
        ],
      });
    },
  };

  deps.bus.register(corroborate);
  deps.bus.register(retract);
  deps.bus.register(share);
};

/**
 * Counters, recomputed from rows on every relevant event.
 *
 * It shares one recompute with the reaction engine's consumer rather than
 * writing its own view of the row: both land in `experience_counters`, and two
 * consumers each writing the whole row would zero the other's fields.
 */
export const createCorroborationCounterConsumer = (deps: EngineDeps): Consumer => ({
  name: 'corroboration.counters',
  events: ['ExperienceReRaged', 'ExperienceReRaved', 'CorroborationRetracted', 'ExperienceShared'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    if (!experienceId) return ok(undefined);
    await recomputeCounters(deps, experienceId);
    deps.metrics.increment('corroboration.counters_recomputed');
    return ok(undefined);
  },
});

/** Corroborations on an experience, as a public projection. */
export const corroborationsFor = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<readonly CorroborationRow[]> =>
  deps.store.corroborations.query(
    [eq<CorroborationRow>('experienceId', experienceId), eq<CorroborationRow>('status', 'active')],
    { orderBy: { field: 'createdAt', direction: 'desc' } },
  );
