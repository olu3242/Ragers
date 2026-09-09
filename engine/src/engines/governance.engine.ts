import { err, ok } from '../runtime/result.ts';
import { notFoundError, preconditionError } from '../runtime/errors.ts';
import { hasAtLeast, type Role } from '../runtime/authz.ts';
import { eq } from '../ports/store.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { AuditEvent, DeadLetterRecordView } from './governance.types.ts';
import type { EngineDeps } from './deps.ts';
import { writeAudit } from './support.ts';

/**
 * P18 Governance & Admin Engine.
 *
 * Every privileged action writes an immutable audit record. Dead-letter replay
 * is idempotent, and a failed replay re-lands with appended history rather than
 * being lost.
 */
export const registerGovernanceEngine = (deps: EngineDeps): void => {
  const grantRole: CommandHandler<{ actorId: string; role: Role }, { actorId: string; role: Role }> = {
    name: 'governance.grantRole',
    action: 'role.grant',
    resolveResource: async () => ok({ type: 'role_assignment' }),
    handle: async (input, ctx) => {
      if (!['member', 'moderator', 'admin'].includes(input.role)) {
        return err(preconditionError('invalid_role', 'role must be member, moderator or admin'));
      }
      const actor = await deps.store.actors.get(input.actorId);
      if (!actor) return err(notFoundError('actor_not_found', 'no such actor'));

      await deps.store.actors.put({ ...actor, role: input.role });
      await deps.store.roleAssignments.put({
        id: deps.ids.next('role'),
        actorId: input.actorId,
        role: input.role,
        grantedBy: ctx.actor.actorId,
        grantedAt: ctx.clock.now(),
      });
      await writeAudit(deps, ctx, {
        action: 'role.grant',
        resourceType: 'actor',
        resourceId: input.actorId,
        before: { role: actor.role },
        after: { role: input.role },
      });

      return ok({
        value: { actorId: input.actorId, role: input.role },
        events: [
          {
            aggregateType: 'actor',
            aggregateId: input.actorId,
            eventName: 'RoleGranted',
            payload: { actorId: input.actorId, role: input.role },
          },
        ],
      });
    },
  };

  const replay: CommandHandler<{ deadLetterId: string }, { replayed: true; replayCount: number }> = {
    name: 'governance.replayDeadLetter',
    action: 'dead_letter.replay',
    resolveResource: async () => ok({ type: 'dead_letter' }),
    handle: async (input, ctx) => {
      const record = await deps.deadLetters.get(input.deadLetterId);
      if (!record) return err(notFoundError('dead_letter_not_found', 'no such dead-letter record'));

      // Replay re-emits the original event. Consumers are idempotent, so a
      // repeated replay is safe.
      await deps.outbox.append(
        [
          {
            aggregateType: record.aggregateType,
            aggregateId: record.aggregateId,
            eventName: record.eventName,
            payload: record.payload,
          },
        ],
        record.correlationId,
      );
      await deps.deadLetters.markReplayed(input.deadLetterId);
      const updated = await deps.deadLetters.get(input.deadLetterId);

      await writeAudit(deps, ctx, {
        action: 'dead_letter.replay',
        resourceType: 'dead_letter',
        resourceId: input.deadLetterId,
        after: { eventName: record.eventName, replayCount: updated?.replayCount ?? 1 },
      });

      return ok({
        value: { replayed: true, replayCount: updated?.replayCount ?? 1 },
        events: [],
      });
    },
  };

  deps.bus.register(grantRole);
  deps.bus.register(replay);
};

const requireStaff = (role: Role, required: Role): boolean => hasAtLeast(role, required);

/** Audit reads are admin-only, and the trail has no mutation path at all. */
export const readAuditTrail = async (
  deps: EngineDeps,
  actor: { role: Role },
  filter: { resourceId?: string } = {},
): Promise<readonly AuditEvent[]> => {
  if (!requireStaff(actor.role, 'admin')) return [];
  const rows = await deps.store.auditEvents.query(
    filter.resourceId === undefined ? [] : [eq<AuditEvent>('resourceId', filter.resourceId)],
    { orderBy: { field: 'createdAt', direction: 'asc' } },
  );
  return rows;
};

export const readDeadLetters = async (
  deps: EngineDeps,
  actor: { role: Role },
): Promise<readonly DeadLetterRecordView[]> => {
  if (!requireStaff(actor.role, 'admin')) return [];
  return (await deps.deadLetters.list()).map((row) => ({
    id: row.id,
    source: row.source,
    eventName: row.eventName,
    attempts: row.failureHistory.length,
    replayCount: row.replayCount,
    createdAt: row.createdAt,
  }));
};

export interface QueueMetrics {
  readonly queued: number;
  readonly claimed: number;
  readonly actioned: number;
  readonly oldestQueuedAgeMs: number;
}

export const readQueueMetrics = async (deps: EngineDeps, actor: { role: Role }): Promise<QueueMetrics> => {
  if (!requireStaff(actor.role, 'moderator')) {
    return { queued: 0, claimed: 0, actioned: 0, oldestQueuedAgeMs: 0 };
  }
  const items = await deps.store.queueItems.all();
  const queued = items.filter((row) => row.state === 'queued');
  const oldest = queued.reduce((min, row) => Math.min(min, row.createdAt), Number.POSITIVE_INFINITY);
  return {
    queued: queued.length,
    claimed: items.filter((row) => row.state === 'claimed').length,
    actioned: items.filter((row) => row.state === 'actioned').length,
    oldestQueuedAgeMs: Number.isFinite(oldest) ? deps.clock.now() - oldest : 0,
  };
};
