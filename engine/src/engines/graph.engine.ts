import { err, ok } from '../runtime/result.ts';
import { preconditionError, validationError } from '../runtime/errors.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { GraphEdge, GraphTargetRef } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * P13 Social Graph Engine.
 *
 * A block is a safety primitive, not a preference: it removes follows in both
 * directions and is enforced on every read path and in notification fan-out.
 */
const edgeId = (kind: string, actorId: string, targetRef: string, targetId: string): string =>
  `${kind}:${actorId}:${targetRef}:${targetId}`;

const toggleEdge = (
  deps: EngineDeps,
  kind: 'follow' | 'block' | 'mute',
  action: 'graph.follow' | 'graph.block' | 'graph.mute',
): CommandHandler<{ targetRef: GraphTargetRef; targetId: string; on?: boolean }, { active: boolean }> => ({
  name: `graph.${kind}`,
  action,
  resolveResource: async () => ok({ type: 'graph_edge' }),
  handle: async (input, ctx) => {
    if (input.targetRef !== 'actor' && input.targetRef !== 'alias') {
      return err(validationError('invalid_target_ref', 'targetRef must be actor or alias'));
    }
    if (input.targetId === ctx.actor.actorId) {
      return err(preconditionError('no_self_edge', `you cannot ${kind} yourself`));
    }

    const id = edgeId(kind, ctx.actor.actorId, input.targetRef, input.targetId);
    const existing = await deps.store.graphEdges.get(id);
    const shouldBeOn = input.on ?? existing === undefined;

    if (!shouldBeOn) {
      if (existing) await deps.store.graphEdges.remove(id);
      return ok({
        value: { active: false },
        events: [
          {
            aggregateType: 'actor',
            aggregateId: ctx.actor.actorId,
            eventName: kind === 'block' ? 'ActorUnblocked' : 'ActorUnfollowed',
            payload: { actorId: ctx.actor.actorId, targetId: input.targetId, kind },
          },
        ],
      });
    }

    if (existing) return ok({ value: { active: true }, events: [] }); // idempotent

    const edge: GraphEdge = {
      id,
      kind,
      actorId: ctx.actor.actorId,
      targetRef: input.targetRef,
      targetId: input.targetId,
      createdAt: ctx.clock.now(),
    };
    await deps.store.graphEdges.put(edge);

    return ok({
      value: { active: true },
      events: [
        {
          aggregateType: 'actor',
          aggregateId: ctx.actor.actorId,
          eventName: kind === 'block' ? 'ActorBlocked' : kind === 'follow' ? 'ActorFollowed' : 'ActorMuted',
          payload: { actorId: ctx.actor.actorId, targetId: input.targetId, targetRef: input.targetRef, kind },
        },
      ],
    });
  },
});

export const registerGraphEngine = (deps: EngineDeps): void => {
  deps.bus.register(toggleEdge(deps, 'follow', 'graph.follow'));
  deps.bus.register(toggleEdge(deps, 'block', 'graph.block'));
  deps.bus.register(toggleEdge(deps, 'mute', 'graph.mute'));
};

/**
 * Applying a block removes mutual follows and cancels pending notifications
 * across the boundary. Idempotent, and retried until every surface agrees.
 */
export const createBlockApplicationConsumer = (deps: EngineDeps): Consumer => ({
  name: 'graph.apply_block',
  events: ['ActorBlocked'],
  handle: async (event) => {
    const actorId = String(event.payload['actorId'] ?? '');
    const targetId = String(event.payload['targetId'] ?? '');
    if (!actorId || !targetId) return ok(undefined);

    // A block supersedes a follow in either direction.
    for (const id of [
      edgeId('follow', actorId, 'actor', targetId),
      edgeId('follow', targetId, 'actor', actorId),
    ]) {
      if (await deps.store.graphEdges.get(id)) await deps.store.graphEdges.remove(id);
    }

    // Pending notifications across the boundary are suppressed, not delivered.
    for (const notification of await deps.store.notifications.find(
      (row) => row.state === 'pending' && (row.recipientActorId === actorId || row.recipientActorId === targetId),
    )) {
      await deps.store.notifications.put({
        ...notification,
        state: 'suppressed',
        suppressionReason: 'blocked',
      });
    }
    deps.metrics.increment('graph.block_applied');
    return ok(undefined);
  },
});

/** True when either actor has blocked the other. Consulted on every read path. */
export const isBlockedBetween = async (
  deps: EngineDeps,
  a: string,
  b: string,
): Promise<boolean> => {
  if (a === b) return false;
  const forward = await deps.store.graphEdges.get(edgeId('block', a, 'actor', b));
  const backward = await deps.store.graphEdges.get(edgeId('block', b, 'actor', a));
  return forward !== undefined || backward !== undefined;
};

export const isMutedBy = async (deps: EngineDeps, actorId: string, targetId: string): Promise<boolean> =>
  (await deps.store.graphEdges.get(edgeId('mute', actorId, 'actor', targetId))) !== undefined;

export const followeesOf = async (deps: EngineDeps, actorId: string): Promise<readonly string[]> =>
  (await deps.store.graphEdges.find((row) => row.kind === 'follow' && row.actorId === actorId)).map(
    (row) => row.targetId,
  );
