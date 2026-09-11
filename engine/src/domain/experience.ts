import {
  BODY_MAX_LENGTH,
  BODY_MIN_LENGTH,
  CATEGORIES,
  isCreationMode,
  isExperienceKind,
  isVisibility,
  VISIBILITY_STRENGTH,
  type CreationMode,
  type ExperienceKind,
  type ExperienceStatus,
  type Visibility,
} from './types.ts';
import { err, ok, type Result } from '../runtime/result.ts';
import { preconditionError, validationError, type EngineError } from '../runtime/errors.ts';
import type { NewDomainEvent } from '../runtime/outbox.ts';

/**
 * The canonical aggregate. One Experience is a Rage or a Rave, created in text
 * or voice mode. There is no separate "voice post" — creation mode is a field.
 */
export interface Experience {
  readonly id: string;
  readonly actorId: string;
  readonly kind: ExperienceKind;
  readonly creationMode: CreationMode;
  readonly category: string;
  readonly bodyText: string;
  readonly status: ExperienceStatus;
  readonly visibility: Visibility;
  readonly aliasId?: string;
  readonly mediaAssetId?: string;
  readonly correlationId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly publishedAt?: number;
  readonly deletedAt?: number;
  readonly version: number;

  // ── Experience Signal Engine structure ──────────────────────────────────
  /**
   * Structure, written only from a *confirmed* normalization or a migration.
   * Never from extraction — an unconfirmed suggestion is not a fact, and these
   * columns are what matching and clustering read.
   */
  readonly title?: string;
  readonly entityId?: string;
  readonly categoryId?: string;
  readonly issueTypeId?: string;
  readonly locationId?: string;
  /** When the experience happened, as distinct from when it was posted. */
  readonly occurredAt?: number;
  /**
   * The outcome axis, entirely separate from `status`. `status` is publication
   * state and is load-bearing for fail-closed media protection and moderation;
   * collapsing the two would let an experience read as resolved while its media
   * was still unprotected.
   */
  readonly resolutionStatus?: string;
  readonly resolutionStatusAt?: number;
  readonly clusterId?: string;
}

/** The lifecycle transition table. Anything absent here is illegal. */
const TRANSITIONS: Readonly<Record<ExperienceStatus, readonly ExperienceStatus[]>> = {
  draft: ['validating', 'deleted'],
  validating: ['pending_media', 'pending_moderation', 'draft', 'deleted'],
  pending_media: ['pending_moderation', 'draft', 'deleted'],
  pending_moderation: ['published', 'removed', 'deleted'],
  published: ['under_review', 'hidden', 'removed', 'deleted'],
  under_review: ['published', 'removed', 'deleted'],
  hidden: ['published', 'removed', 'deleted'],
  removed: ['published', 'deleted'],
  deleted: [],
};

export const canTransition = (from: ExperienceStatus, to: ExperienceStatus): boolean =>
  (TRANSITIONS[from] ?? []).includes(to);

export const isTerminalStatus = (status: ExperienceStatus): boolean => status === 'deleted';

/** Statuses in which the experience is reachable by the public. */
export const isPubliclyVisible = (status: ExperienceStatus): boolean => status === 'published';

export interface CreateExperienceInput {
  readonly actorId: string;
  readonly kind: unknown;
  readonly creationMode: unknown;
  readonly category: unknown;
  readonly bodyText?: unknown;
  readonly visibility: unknown;
  readonly aliasId?: string;
}

export interface AggregateChange {
  readonly experience: Experience;
  readonly events: readonly NewDomainEvent[];
}

const event = (experience: Experience, eventName: string, payload: Record<string, unknown> = {}): NewDomainEvent => ({
  aggregateType: 'experience',
  aggregateId: experience.id,
  eventName,
  payload: { experienceId: experience.id, ...payload },
});

/**
 * Validate and draft a new Experience. Validation is server-side and total:
 * nothing from the client is trusted, including the kind and the category.
 */
export const createExperience = (
  input: CreateExperienceInput,
  meta: { id: string; correlationId: string; now: number },
): Result<AggregateChange, EngineError> => {
  if (!isExperienceKind(input.kind)) {
    return err(validationError('invalid_kind', 'kind must be rage or rave', { kind: input.kind }));
  }
  if (!isCreationMode(input.creationMode)) {
    return err(validationError('invalid_creation_mode', 'creationMode must be text or voice'));
  }
  if (!isVisibility(input.visibility)) {
    return err(validationError('invalid_visibility', 'visibility must be public, alias or anonymous'));
  }
  if (typeof input.category !== 'string' || !CATEGORIES.includes(input.category)) {
    return err(validationError('invalid_category', 'category is not a known category'));
  }
  if (input.visibility === 'alias' && !input.aliasId) {
    return err(validationError('alias_required', 'alias visibility requires an alias'));
  }
  if (input.visibility !== 'alias' && input.aliasId) {
    return err(validationError('alias_not_permitted', 'an alias may only be attached to alias visibility'));
  }

  const bodyRaw = typeof input.bodyText === 'string' ? input.bodyText.trim() : '';
  if (bodyRaw.length > BODY_MAX_LENGTH) {
    return err(
      validationError('body_too_long', `body must be at most ${BODY_MAX_LENGTH} characters`, {
        length: bodyRaw.length,
      }),
    );
  }
  // Text mode is text-bearing by definition; voice mode may carry no body at all.
  if (input.creationMode === 'text' && bodyRaw.length < BODY_MIN_LENGTH) {
    return err(validationError('body_required', 'a text experience requires a body'));
  }

  const experience: Experience = {
    id: meta.id,
    actorId: input.actorId,
    kind: input.kind,
    creationMode: input.creationMode,
    category: input.category,
    bodyText: bodyRaw,
    status: 'draft',
    visibility: input.visibility,
    ...(input.aliasId === undefined ? {} : { aliasId: input.aliasId }),
    correlationId: meta.correlationId,
    createdAt: meta.now,
    updatedAt: meta.now,
    version: 1,
  };

  return ok({
    experience,
    events: [
      event(experience, 'ExperienceDrafted', {
        kind: experience.kind,
        creationMode: experience.creationMode,
        visibility: experience.visibility,
      }),
    ],
  });
};

const advance = (
  experience: Experience,
  to: ExperienceStatus,
  now: number,
  extra: Partial<Experience> = {},
): Result<Experience, EngineError> => {
  if (!canTransition(experience.status, to)) {
    return err(
      preconditionError('illegal_transition', `cannot move from ${experience.status} to ${to}`, {
        from: experience.status,
        to,
      }),
    );
  }
  return ok({ ...experience, ...extra, status: to, updatedAt: now, version: experience.version + 1 });
};

/**
 * Begin validation. Voice-mode experiences route through `pending_media` so
 * they cannot reach moderation — let alone publication — before their audio
 * has been validated and protected.
 */
export const beginValidation = (experience: Experience, now: number): Result<AggregateChange, EngineError> => {
  const validating = advance(experience, 'validating', now);
  if (!validating.ok) return validating;

  const next = experience.creationMode === 'voice' ? 'pending_media' : 'pending_moderation';
  const moved = advance(validating.value, next, now);
  if (!moved.ok) return moved;

  return ok({
    experience: moved.value,
    events: [
      event(moved.value, 'ExperienceValidated', { creationMode: moved.value.creationMode, next }),
    ],
  });
};

/** Media has been attached, validated and protected — proceed to moderation. */
export const mediaReady = (
  experience: Experience,
  mediaAssetId: string,
  now: number,
): Result<AggregateChange, EngineError> => {
  if (experience.creationMode !== 'voice') {
    return err(preconditionError('not_voice_mode', 'only a voice experience has media to ready'));
  }
  const moved = advance(experience, 'pending_moderation', now, { mediaAssetId });
  if (!moved.ok) return moved;
  return ok({
    experience: moved.value,
    events: [event(moved.value, 'ExperienceMediaReady', { mediaAssetId })],
  });
};

/** Media protection failed — return to draft so the author can re-record. */
export const mediaFailed = (
  experience: Experience,
  reason: string,
  now: number,
): Result<AggregateChange, EngineError> => {
  const moved = advance(experience, 'draft', now);
  if (!moved.ok) return moved;
  return ok({
    experience: moved.value,
    events: [event(moved.value, 'ExperienceMediaFailed', { reason })],
  });
};

/**
 * Publish. Idempotent by design: publishing an already-published experience is
 * a successful no-op that emits no second event.
 */
export const publishExperience = (experience: Experience, now: number): Result<AggregateChange, EngineError> => {
  if (experience.status === 'published') {
    return ok({ experience, events: [] });
  }
  const moved = advance(experience, 'published', now, { publishedAt: now });
  if (!moved.ok) return moved;
  return ok({
    experience: moved.value,
    events: [
      event(moved.value, 'ExperiencePublished', {
        kind: moved.value.kind,
        creationMode: moved.value.creationMode,
        visibility: moved.value.visibility,
        category: moved.value.category,
      }),
    ],
  });
};

export const updateBody = (
  experience: Experience,
  bodyText: string,
  now: number,
): Result<AggregateChange, EngineError> => {
  const trimmed = bodyText.trim();
  if (trimmed.length > BODY_MAX_LENGTH) {
    return err(validationError('body_too_long', `body must be at most ${BODY_MAX_LENGTH} characters`));
  }
  if (experience.creationMode === 'text' && trimmed.length < BODY_MIN_LENGTH) {
    return err(validationError('body_required', 'a text experience requires a body'));
  }
  if (experience.status === 'deleted' || experience.status === 'removed') {
    return err(preconditionError('not_editable', `a ${experience.status} experience cannot be edited`));
  }
  const next: Experience = {
    ...experience,
    bodyText: trimmed,
    updatedAt: now,
    version: experience.version + 1,
  };
  return ok({ experience: next, events: [event(next, 'ExperienceEdited', {})] });
};

/**
 * Change visibility. Tightening (public → alias → anonymous) is allowed;
 * loosening is refused, because retroactively de-anonymising content the author
 * posted anonymously is a privacy violation, not a preference change.
 */
export const changeVisibility = (
  experience: Experience,
  to: Visibility,
  aliasId: string | undefined,
  now: number,
): Result<AggregateChange, EngineError> => {
  // Before the strength comparison, not after: a value outside the enum has no
  // strength at all, so `undefined < 0` is false and the tighten-only rule below
  // waves it through — writing an unknown visibility onto the row and leaving the
  // next change comparing against nothing. A privacy invariant with a hole in it
  // for one unrecognised string is not an invariant.
  if (!isVisibility(to)) {
    return err(validationError('invalid_visibility', 'visibility must be public, alias or anonymous'));
  }
  if (to === experience.visibility) return ok({ experience, events: [] });
  if (VISIBILITY_STRENGTH[to] < VISIBILITY_STRENGTH[experience.visibility]) {
    return err(
      preconditionError('visibility_cannot_loosen', 'visibility may be tightened but never loosened', {
        from: experience.visibility,
        to,
      }),
    );
  }
  if (to === 'alias' && !aliasId) {
    return err(validationError('alias_required', 'alias visibility requires an alias'));
  }
  const next: Experience = {
    ...experience,
    visibility: to,
    ...(to === 'alias' && aliasId !== undefined ? { aliasId } : {}),
    updatedAt: now,
    version: experience.version + 1,
  };
  return ok({
    experience: next,
    events: [event(next, 'ExperienceVisibilityChanged', { from: experience.visibility, to })],
  });
};

export const hideExperience = (
  experience: Experience,
  now: number,
): Result<AggregateChange, EngineError> => {
  const moved = advance(experience, 'hidden', now);
  if (!moved.ok) return moved;
  return ok({ experience: moved.value, events: [event(moved.value, 'ExperienceHidden', {})] });
};

export const removeExperience = (
  experience: Experience,
  reason: string,
  now: number,
): Result<AggregateChange, EngineError> => {
  const moved = advance(experience, 'removed', now);
  if (!moved.ok) return moved;
  return ok({ experience: moved.value, events: [event(moved.value, 'ContentRemoved', { reason })] });
};

export const restoreExperience = (
  experience: Experience,
  now: number,
): Result<AggregateChange, EngineError> => {
  const moved = advance(experience, 'published', now);
  if (!moved.ok) return moved;
  return ok({ experience: moved.value, events: [event(moved.value, 'ContentRestored', {})] });
};

export const beginReview = (experience: Experience, now: number): Result<AggregateChange, EngineError> => {
  if (experience.status === 'under_review') return ok({ experience, events: [] });
  const moved = advance(experience, 'under_review', now);
  if (!moved.ok) return moved;
  return ok({ experience: moved.value, events: [event(moved.value, 'ExperienceUnderReview', {})] });
};

/** Author deletion. Idempotent, and the trigger for deletion propagation (P17). */
export const deleteExperience = (
  experience: Experience,
  now: number,
): Result<AggregateChange, EngineError> => {
  if (experience.status === 'deleted') return ok({ experience, events: [] });
  const moved = advance(experience, 'deleted', now, { deletedAt: now });
  if (!moved.ok) return moved;
  return ok({
    experience: moved.value,
    events: [event(moved.value, 'ExperienceDeleted', { creationMode: moved.value.creationMode })],
  });
};
