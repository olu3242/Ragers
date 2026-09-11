import { err, ok } from '../runtime/result.ts';
import { notFoundError, preconditionError } from '../runtime/errors.ts';
import {
  beginValidation,
  createExperience,
  updateBody,
  type Experience,
} from '../domain/experience.ts';
import type { CreationMode, ExperienceKind, Visibility } from '../domain/types.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { EngineDeps } from './deps.ts';
import { experienceResource, loadExperience } from './support.ts';

export interface CreateExperienceCommand {
  readonly kind: ExperienceKind;
  readonly creationMode: CreationMode;
  readonly category: string;
  readonly bodyText?: string;
  readonly visibility: Visibility;
  readonly aliasId?: string;
}

export interface CreateExperienceResult {
  readonly experienceId: string;
  readonly status: Experience['status'];
  /** True when the caller must now upload audio before anything else happens. */
  readonly awaitingMedia: boolean;
}

/**
 * P1 Experience Engine. Creation drafts the aggregate and immediately validates
 * it, so a caller never has to remember a second step: text lands in
 * `pending_moderation`, voice lands in `pending_media`.
 */
export const registerExperienceEngine = (deps: EngineDeps): void => {
  const create: CommandHandler<CreateExperienceCommand, CreateExperienceResult> = {
    name: 'experience.create',
    action: 'experience.create',
    resolveResource: async (_input, ctx) => ok({ type: 'experience', ownerActorId: ctx.actor.actorId }),
    handle: async (input, ctx) => {
      // An alias must belong to the author, and must be active.
      if (input.visibility === 'alias') {
        const alias = input.aliasId ? await deps.store.aliases.get(input.aliasId) : undefined;
        if (!alias || alias.actorId !== ctx.actor.actorId || !alias.isActive) {
          return err(preconditionError('alias_unavailable', 'that alias is not available to you'));
        }
      }

      const drafted = createExperience(
        { ...input, actorId: ctx.actor.actorId },
        { id: deps.ids.next('exp'), correlationId: ctx.correlationId, now: ctx.clock.now() },
      );
      if (!drafted.ok) return drafted;

      const validated = beginValidation(drafted.value.experience, ctx.clock.now());
      if (!validated.ok) return validated;

      await deps.store.experiences.put(validated.value.experience);

      return ok({
        value: {
          experienceId: validated.value.experience.id,
          status: validated.value.experience.status,
          awaitingMedia: validated.value.experience.status === 'pending_media',
        },
        events: [...drafted.value.events, ...validated.value.events],
      });
    },
  };

  const edit: CommandHandler<{ experienceId: string; bodyText: string }, { version: number }> = {
    name: 'experience.updateBody',
    action: 'experience.update',
    resolveResource: async (input) => experienceResource(deps.store, input.experienceId),
    handle: async (input, ctx) => {
      const loaded = await loadExperience(deps.store, input.experienceId);
      if (!loaded.ok) return loaded;
      const experience = loaded.value;

      // Published content is editable only inside the edit window.
      if (experience.status === 'published' && experience.publishedAt !== undefined) {
        const elapsed = ctx.clock.now() - experience.publishedAt;
        if (elapsed > deps.config.editWindowMs) {
          return err(
            preconditionError('edit_window_closed', 'the edit window for this experience has closed', { elapsed }),
          );
        }
      }

      const edited = updateBody(experience, input.bodyText, ctx.clock.now());
      if (!edited.ok) return edited;
      await deps.store.experiences.put(edited.value.experience);
      return ok({ value: { version: edited.value.experience.version }, events: edited.value.events });
    },
  };

  deps.bus.register(create);
  deps.bus.register(edit);
};

export const getExperienceOrFail = async (deps: EngineDeps, experienceId: string) => {
  const experience = await deps.store.experiences.get(experienceId);
  if (!experience) return err(notFoundError('experience_not_found', 'no such experience'));
  return ok(experience);
};
