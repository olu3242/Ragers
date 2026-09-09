import { err, ok } from '../runtime/result.ts';
import { conflictError, notFoundError } from '../runtime/errors.ts';
import {
  createRelation,
  distinctAsserters,
  relationKey,
  retractRelation,
  trustWeightOfRelations,
  type RelationAssertion,
} from '../domain/relation.ts';
import { eq } from '../ports/store.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { RelationRow } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { experienceResource } from './support.ts';

/**
 * Relate Engine — E6.
 *
 * An actor asserting that two experiences are the same or related occurrence.
 * Reviewed against what already existed before adding it: the `same` reaction has
 * no second experience in its row and so cannot express a link, and corroboration
 * is a claim about the actor's *own* experience, which Relate is not. Neither
 * satisfies the contract, so this is the smallest missing delta.
 *
 * The constraint that keeps it honest: **relating carries no trust weight.** It
 * feeds discovery and clustering and nothing else, so an actor who relates a
 * hundred pairs has purchased no credibility. `trustWeightOfRelations` states that
 * as executable code, and a test holds it.
 */
export interface AssertRelationInput {
  readonly fromExperienceId: string;
  readonly toExperienceId: string;
  readonly assertion?: RelationAssertion;
  readonly note?: string;
}

export interface AssertRelationResult {
  readonly relationId: string;
  readonly assertion: RelationAssertion;
  /** Distinct people asserting this pair. A discovery signal, never a claim count. */
  readonly assertedByCount: number;
  /** Always zero, returned so a caller cannot mistake this for corroboration. */
  readonly trustWeight: 0;
}

export const registerRelationEngine = (deps: EngineDeps): void => {
  const assert: CommandHandler<AssertRelationInput, AssertRelationResult> = {
    name: 'relation.assert',
    action: 'relation.assert',
    // Authorized against the first experience; the second is checked in the
    // handler, since a resource ref names one thing.
    resolveResource: async (input) => experienceResource(deps.store, input.fromExperienceId),
    handle: async (input, ctx) => {
      const from = await deps.store.experiences.get(input.fromExperienceId);
      const to = await deps.store.experiences.get(input.toExperienceId);
      if (!from || !to) return err(notFoundError('experience_not_found', 'no such experience'));

      const relationId = relationKey(input.fromExperienceId, input.toExperienceId, ctx.actor.actorId);
      const existing = await deps.store.relations.get(relationId);
      if (existing && existing.status === 'active') {
        return err(
          conflictError('already_related', 'you have already related these two', { relationId: existing.id }),
        );
      }

      const created = createRelation(
        {
          fromExperienceId: input.fromExperienceId,
          toExperienceId: input.toExperienceId,
          assertedBy: ctx.actor.actorId,
          ...(input.assertion === undefined ? {} : { assertion: input.assertion }),
          ...(input.note === undefined ? {} : { note: input.note }),
          bothPublished: from.status === 'published' && to.status === 'published',
        },
        { id: relationId, correlationId: ctx.correlationId, now: ctx.clock.now() },
      );
      if (!created.ok) return created;

      // Keyed on the canonical pair plus the actor, so a race converges to one row
      // and re-asserting after a retraction reuses it.
      const won = existing
        ? await deps.store.relations.compareAndSet(created.value, [eq<RelationRow>('status', 'retracted')])
        : await deps.store.relations.compareAndSet(created.value, 'absent');
      if (!won) {
        return err(conflictError('already_related', 'you have already related these two', { relationId }));
      }

      const active = await deps.store.relations.query([
        eq<RelationRow>('fromExperienceId', created.value.fromExperienceId),
        eq<RelationRow>('toExperienceId', created.value.toExperienceId),
        eq<RelationRow>('status', 'active'),
      ]);

      return ok({
        value: {
          relationId,
          assertion: created.value.assertion,
          assertedByCount: distinctAsserters(active),
          trustWeight: trustWeightOfRelations(active),
        },
        events: [
          {
            aggregateType: 'experience',
            aggregateId: created.value.fromExperienceId,
            eventName: 'ExperienceRelated',
            payload: {
              relationId,
              fromExperienceId: created.value.fromExperienceId,
              toExperienceId: created.value.toExperienceId,
              assertion: created.value.assertion,
            },
          },
        ],
      });
    },
  };

  const retract: CommandHandler<{ relationId: string }, { retracted: true; assertedByCount: number }> = {
    name: 'relation.retract',
    action: 'relation.retract',
    resolveResource: async (input) => {
      const row = await deps.store.relations.get(input.relationId);
      if (!row) return err(notFoundError('relation_not_found', 'no such relation'));
      return ok({ type: 'relation', id: row.id, ownerActorId: row.assertedBy });
    },
    handle: async (input, ctx) => {
      const row = await deps.store.relations.get(input.relationId);
      if (!row) return err(notFoundError('relation_not_found', 'no such relation'));

      const retracted = retractRelation(row, ctx.actor.actorId, ctx.clock.now());
      if (!retracted.ok) return retracted;
      await deps.store.relations.put(retracted.value);

      const active = await deps.store.relations.query([
        eq<RelationRow>('fromExperienceId', row.fromExperienceId),
        eq<RelationRow>('toExperienceId', row.toExperienceId),
        eq<RelationRow>('status', 'active'),
      ]);

      return ok({
        value: { retracted: true as const, assertedByCount: distinctAsserters(active) },
        events: [
          {
            aggregateType: 'experience',
            aggregateId: row.fromExperienceId,
            eventName: 'ExperienceUnrelated',
            payload: {
              relationId: row.id,
              fromExperienceId: row.fromExperienceId,
              toExperienceId: row.toExperienceId,
            },
          },
        ],
      });
    },
  };

  deps.bus.register(assert);
  deps.bus.register(retract);
};

/**
 * Experiences people have related to this one.
 *
 * Reported with how many distinct people asserted each link and nothing else — no
 * score, and never folded into a corroboration or experiencer count.
 */
export interface RelatedExperience {
  readonly experienceId: string;
  readonly assertion: RelationAssertion;
  readonly assertedByCount: number;
}

export const relatedTo = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<readonly RelatedExperience[]> => {
  const outgoing = await deps.store.relations.query([
    eq<RelationRow>('fromExperienceId', experienceId),
    eq<RelationRow>('status', 'active'),
  ]);
  const incoming = await deps.store.relations.query([
    eq<RelationRow>('toExperienceId', experienceId),
    eq<RelationRow>('status', 'active'),
  ]);

  const byOther = new Map<string, RelationRow[]>();
  for (const row of [...outgoing, ...incoming]) {
    const other = row.fromExperienceId === experienceId ? row.toExperienceId : row.fromExperienceId;
    byOther.set(other, [...(byOther.get(other) ?? []), row]);
  }

  return [...byOther.entries()]
    .map(([other, rows]) => ({
      experienceId: other,
      // The strongest assertion anyone made about the pair.
      assertion:
        rows.find((row) => row.assertion === 'same_occurrence')?.assertion ??
        rows.find((row) => row.assertion === 'same_pattern')?.assertion ??
        'related_context',
      assertedByCount: distinctAsserters(rows),
    }))
    .sort((left, right) => right.assertedByCount - left.assertedByCount);
};
