import { err, ok } from '../runtime/result.ts';
import { preconditionError, validationError } from '../runtime/errors.ts';
import { BODY_MAX_LENGTH, isCreationMode, isVisibility, type CreationMode, type Visibility } from '../domain/types.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import { MAX_REPLY_DEPTH, type Reply } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { experienceResource, loadExperience, loadReply, replyResource } from './support.ts';

export interface CreateReplyCommand {
  readonly experienceId: string;
  readonly parentReplyId?: string;
  readonly creationMode: CreationMode;
  readonly bodyText?: string;
  readonly visibility: Visibility;
  readonly aliasId?: string;
}

/**
 * P7 Conversation Engine. Replies are the same shape as an experience and reuse
 * the same media and moderation pipelines — a voice reply is not a special case.
 */
export const registerConversationEngine = (deps: EngineDeps): void => {
  const create: CommandHandler<CreateReplyCommand, { replyId: string; depth: number; status: Reply['status'] }> = {
    name: 'conversation.createReply',
    action: 'reply.create',
    resolveResource: async (input) => experienceResource(deps.store, input.experienceId),
    handle: async (input, ctx) => {
      const parent = await loadExperience(deps.store, input.experienceId);
      if (!parent.ok) return parent;
      // Replying to content that is not published is refused — including
      // content removed by moderation.
      if (parent.value.status !== 'published') {
        return err(
          preconditionError('parent_not_published', `cannot reply to a ${parent.value.status} experience`),
        );
      }

      let depth = 0;
      if (input.parentReplyId) {
        const parentReply = await loadReply(deps.store, input.parentReplyId);
        if (!parentReply.ok) return parentReply;
        if (parentReply.value.status !== 'published') {
          return err(preconditionError('parent_reply_not_published', 'cannot reply to that reply'));
        }
        depth = parentReply.value.depth + 1;
        if (depth > MAX_REPLY_DEPTH) {
          return err(
            preconditionError('reply_depth_exceeded', `replies may not nest deeper than ${MAX_REPLY_DEPTH}`, {
              depth,
            }),
          );
        }
      }

      if (!isCreationMode(input.creationMode)) {
        return err(validationError('invalid_creation_mode', 'creationMode must be text or voice'));
      }
      if (!isVisibility(input.visibility)) {
        return err(validationError('invalid_visibility', 'visibility must be public, alias or anonymous'));
      }

      const bodyText = typeof input.bodyText === 'string' ? input.bodyText.trim() : '';
      if (bodyText.length > BODY_MAX_LENGTH) {
        return err(validationError('body_too_long', `body must be at most ${BODY_MAX_LENGTH} characters`));
      }
      if (input.creationMode === 'text' && bodyText.length === 0) {
        return err(validationError('body_required', 'a text reply requires a body'));
      }

      if (input.visibility === 'alias') {
        const alias = input.aliasId ? await deps.store.aliases.get(input.aliasId) : undefined;
        if (!alias || alias.actorId !== ctx.actor.actorId || !alias.isActive) {
          return err(preconditionError('alias_unavailable', 'that alias is not available to you'));
        }
      }

      const reply: Reply = {
        id: deps.ids.next('rep'),
        experienceId: input.experienceId,
        ...(input.parentReplyId === undefined ? {} : { parentReplyId: input.parentReplyId }),
        actorId: ctx.actor.actorId,
        creationMode: input.creationMode,
        bodyText,
        visibility: input.visibility,
        ...(input.aliasId === undefined ? {} : { aliasId: input.aliasId }),
        // A voice reply waits for its media, exactly like an experience does.
        status: input.creationMode === 'voice' ? 'pending_media' : 'published',
        depth,
        createdAt: ctx.clock.now(),
      };
      await deps.store.replies.put(reply);

      return ok({
        value: { replyId: reply.id, depth, status: reply.status },
        events:
          reply.status === 'published'
            ? [
                {
                  aggregateType: 'experience',
                  aggregateId: input.experienceId,
                  eventName: 'ReplyPublished',
                  payload: {
                    experienceId: input.experienceId,
                    replyId: reply.id,
                    replierActorId: ctx.actor.actorId,
                  },
                },
              ]
            : [
                {
                  aggregateType: 'experience',
                  aggregateId: input.experienceId,
                  eventName: 'ReplyAwaitingMedia',
                  payload: { experienceId: input.experienceId, replyId: reply.id },
                },
              ],
      });
    },
  };

  const remove: CommandHandler<{ replyId: string }, { deleted: true }> = {
    name: 'conversation.deleteReply',
    action: 'reply.delete',
    resolveResource: async (input) => replyResource(deps.store, input.replyId),
    handle: async (input, ctx) => {
      const loaded = await loadReply(deps.store, input.replyId);
      if (!loaded.ok) return loaded;
      if (loaded.value.status === 'deleted') return ok({ value: { deleted: true }, events: [] });

      await deps.store.replies.put({ ...loaded.value, status: 'deleted' });
      return ok({
        value: { deleted: true },
        events: [
          {
            aggregateType: 'experience',
            aggregateId: loaded.value.experienceId,
            eventName: 'ReplyDeleted',
            payload: { experienceId: loaded.value.experienceId, replyId: loaded.value.id },
          },
        ],
      });
    },
  };

  deps.bus.register(create);
  deps.bus.register(remove);
};

/**
 * Removing a parent experience cascades to its replies, so a thread never
 * outlives the content it belongs to.
 */
export const createReplyCascadeConsumer = (deps: EngineDeps): Consumer => ({
  name: 'conversation.cascade',
  events: ['ContentRemoved', 'ExperienceDeleted'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    const terminal = event.eventName === 'ExperienceDeleted' ? 'deleted' : 'removed';
    for (const reply of await deps.store.replies.find((row) => row.experienceId === experienceId)) {
      if (reply.status === 'deleted') continue;
      await deps.store.replies.put({ ...reply, status: terminal });
    }
    return ok(undefined);
  },
});
