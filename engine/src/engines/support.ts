import { err, ok, type Result } from '../runtime/result.ts';
import { notFoundError, type EngineError } from '../runtime/errors.ts';
import type { ResourceRef } from '../runtime/authz.ts';
import type { Experience } from '../domain/experience.ts';
import type { EngineStore, Reply, TargetType } from '../ports/store.ts';
import type { CommandContext } from '../runtime/bus.ts';
import type { EngineDeps } from './deps.ts';

/** Resolve an experience into a ResourceRef so the bus can authorize ownership and status. */
export const experienceResource = async (
  store: EngineStore,
  experienceId: string,
): Promise<Result<ResourceRef, EngineError>> => {
  const experience = await store.experiences.get(experienceId);
  if (!experience) return err(notFoundError('experience_not_found', 'no such experience', { experienceId }));
  return ok({
    type: 'experience',
    id: experience.id,
    ownerActorId: experience.actorId,
    status: experience.status,
    visibility: experience.visibility,
  });
};

export const replyResource = async (
  store: EngineStore,
  replyId: string,
): Promise<Result<ResourceRef, EngineError>> => {
  const reply = await store.replies.get(replyId);
  if (!reply) return err(notFoundError('reply_not_found', 'no such reply', { replyId }));
  return ok({ type: 'reply', id: reply.id, ownerActorId: reply.actorId, status: reply.status });
};

export const loadExperience = async (
  store: EngineStore,
  experienceId: string,
): Promise<Result<Experience, EngineError>> => {
  const experience = await store.experiences.get(experienceId);
  if (!experience) return err(notFoundError('experience_not_found', 'no such experience', { experienceId }));
  return ok(experience);
};

export const loadReply = async (store: EngineStore, replyId: string): Promise<Result<Reply, EngineError>> => {
  const reply = await store.replies.get(replyId);
  if (!reply) return err(notFoundError('reply_not_found', 'no such reply', { replyId }));
  return ok(reply);
};

/** Write an immutable audit record. Every privileged or destructive action does this. */
export const writeAudit = async (
  deps: EngineDeps,
  ctx: CommandContext,
  entry: {
    action: string;
    resourceType: string;
    resourceId: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  },
): Promise<void> => {
  await deps.store.auditEvents.put({
    id: deps.ids.next('audit'),
    actorId: ctx.actor.actorId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    ...(entry.before === undefined ? {} : { before: entry.before }),
    ...(entry.after === undefined ? {} : { after: entry.after }),
    correlationId: ctx.correlationId,
    createdAt: deps.clock.now(),
  });
};

/** Ensure a counters row exists for an experience. */
export const ensureCounters = async (deps: EngineDeps, experienceId: string) => {
  const existing = await deps.store.counters.get(experienceId);
  if (existing) return existing;
  const created = {
    id: experienceId,
    experienceId,
    beenThere: 0,
    same: 0,
    fairPoint: 0,
    disagree: 0,
    fairYes: 0,
    fairNo: 0,
    replyCount: 0,
  };
  await deps.store.counters.put(created);
  return created;
};

export const targetOf = (eventName: string): TargetType => (eventName.startsWith('Reply') ? 'reply' : 'experience');

/** Excerpt used by the feed projection. Never the full body, never raw media. */
export const excerptOf = (bodyText: string, limit = 160): string =>
  bodyText.length <= limit ? bodyText : `${bodyText.slice(0, limit - 1)}…`;
