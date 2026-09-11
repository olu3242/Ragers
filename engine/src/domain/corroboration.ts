import { err, ok, type Result } from '../runtime/result.ts';
import { preconditionError, validationError, type EngineError } from '../runtime/errors.ts';
import type { ExperienceKind, Visibility } from './types.ts';

/**
 * Corroboration — the Experience Signal Engine's central mechanic.
 *
 * A corroboration is a *claim*: "this happened to me too". It is not a repost
 * and not a reaction. One user may corroborate one underlying experience once,
 * which is what makes a corroboration count meaningful: 1,842 corroborations
 * means 1,842 people saying it happened to them.
 */
export type CorroborationType = 're_rage' | 're_rave';
export const CORROBORATION_TYPES: readonly CorroborationType[] = ['re_rage', 're_rave'];

export type MatchRelationship =
  | 'same_experience'
  | 'similar_experience'
  | 'related_experience'
  | 'no_match';

export const MATCH_RELATIONSHIPS: readonly MatchRelationship[] = [
  'same_experience',
  'similar_experience',
  'related_experience',
  'no_match',
];

export type CorroborationStatus = 'active' | 'retracted' | 'removed';

export const NARRATIVE_MAX_LENGTH = 1_000;

export interface Corroboration {
  readonly id: string;
  readonly experienceId: string;
  readonly corroboratorId: string;
  readonly type: CorroborationType;
  readonly relationship: MatchRelationship;
  /** Optional context. Corroborating must stay a one-tap action. */
  readonly narrative?: string;
  readonly occurredAt?: number;
  readonly locationId?: string;
  readonly mediaAssetId?: string;
  readonly visibility: Visibility;
  readonly aliasId?: string;
  readonly status: CorroborationStatus;
  /**
   * Explicitly `| undefined`, not merely optional: re-claiming after a
   * retraction has to *clear* this column, so the field must be writable as
   * absent rather than simply omitted from the patch.
   */
  readonly retractedAt?: number | undefined;
  readonly correlationId: string;
  readonly createdAt: number;
}

/** The corroboration type a given experience kind accepts, and only that one. */
export const corroborationTypeFor = (kind: ExperienceKind): CorroborationType =>
  kind === 'rage' ? 're_rage' : 're_rave';

export const acceptsCorroboration = (kind: ExperienceKind, type: CorroborationType): boolean =>
  corroborationTypeFor(kind) === type;

export interface CreateCorroborationInput {
  readonly experienceId: string;
  readonly corroboratorId: string;
  readonly experienceKind: ExperienceKind;
  readonly experienceAuthorId: string;
  readonly type: unknown;
  readonly relationship?: unknown;
  readonly narrative?: unknown;
  readonly occurredAt?: unknown;
  readonly locationId?: string;
  readonly mediaAssetId?: string;
  readonly visibility?: unknown;
  readonly aliasId?: string;
}

const isCorroborationType = (value: unknown): value is CorroborationType =>
  typeof value === 'string' && (CORROBORATION_TYPES as readonly string[]).includes(value);

const isRelationship = (value: unknown): value is MatchRelationship =>
  typeof value === 'string' && (MATCH_RELATIONSHIPS as readonly string[]).includes(value);

export const createCorroboration = (
  input: CreateCorroborationInput,
  meta: { id: string; correlationId: string; now: number },
): Result<Corroboration, EngineError> => {
  if (!isCorroborationType(input.type)) {
    return err(validationError('invalid_corroboration_type', 'type must be re_rage or re_rave'));
  }

  // A rage accepts only a re_rage and a rave only a re_rave. Confusing the two
  // would let a positive experience be corroborated as a negative one.
  if (!acceptsCorroboration(input.experienceKind, input.type)) {
    return err(
      preconditionError(
        'corroboration_kind_mismatch',
        `a ${input.experienceKind} accepts only a ${corroborationTypeFor(input.experienceKind)}`,
        { experienceKind: input.experienceKind, type: input.type },
      ),
    );
  }

  // The author already made this claim by posting it.
  if (input.corroboratorId === input.experienceAuthorId) {
    return err(
      preconditionError('no_self_corroboration', 'you cannot corroborate your own experience'),
    );
  }

  const relationship = input.relationship ?? 'same_experience';
  if (!isRelationship(relationship) || relationship === 'no_match') {
    return err(validationError('invalid_relationship', 'relationship must be same, similar or related'));
  }

  const narrative = typeof input.narrative === 'string' ? input.narrative.trim() : '';
  if (narrative.length > NARRATIVE_MAX_LENGTH) {
    return err(
      validationError('narrative_too_long', `context must be at most ${NARRATIVE_MAX_LENGTH} characters`),
    );
  }

  if (input.occurredAt !== undefined && typeof input.occurredAt !== 'number') {
    return err(validationError('invalid_occurred_at', 'occurredAt must be a timestamp'));
  }
  // An experience cannot have happened in the future.
  if (typeof input.occurredAt === 'number' && input.occurredAt > meta.now) {
    return err(validationError('occurred_in_future', 'occurredAt cannot be in the future'));
  }

  const visibility = (input.visibility ?? 'public') as Visibility;
  if (visibility !== 'public' && visibility !== 'alias' && visibility !== 'anonymous') {
    return err(validationError('invalid_visibility', 'visibility must be public, alias or anonymous'));
  }
  if (visibility === 'alias' && !input.aliasId) {
    return err(validationError('alias_required', 'alias visibility requires an alias'));
  }
  if (visibility !== 'alias' && input.aliasId) {
    return err(validationError('alias_not_permitted', 'an alias may only be attached to alias visibility'));
  }

  return ok({
    id: meta.id,
    experienceId: input.experienceId,
    corroboratorId: input.corroboratorId,
    type: input.type,
    relationship,
    ...(narrative.length === 0 ? {} : { narrative }),
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    ...(input.locationId === undefined ? {} : { locationId: input.locationId }),
    ...(input.mediaAssetId === undefined ? {} : { mediaAssetId: input.mediaAssetId }),
    visibility,
    ...(input.aliasId === undefined ? {} : { aliasId: input.aliasId }),
    status: 'active',
    // Written, not omitted: a re-claim after a retraction must clear it.
    retractedAt: undefined,
    correlationId: meta.correlationId,
    createdAt: meta.now,
  });
};

/**
 * Retraction. Withdrawing a claim is not the same as deleting a post: the row
 * stays so aggregates recompute correctly and the history remains auditable.
 */
export const retractCorroboration = (
  corroboration: Corroboration,
  now: number,
): Result<Corroboration, EngineError> => {
  if (corroboration.status === 'retracted') return ok(corroboration);
  if (corroboration.status === 'removed') {
    return err(preconditionError('already_removed', 'a removed corroboration cannot be retracted'));
  }
  return ok({ ...corroboration, status: 'retracted', retractedAt: now });
};

/**
 * A share is amplification, never a claim. It has its own type so no code path
 * can accidentally treat one as the other.
 */
export interface ExperienceShare {
  readonly id: string;
  readonly experienceId: string;
  readonly actorId?: string;
  readonly destination?: string;
  readonly createdAt: number;
}

export const SHARE_DESTINATIONS: readonly string[] = [
  'copy_link',
  'share_card',
  'external',
  'message',
];

export const createShare = (
  input: { experienceId: string; actorId?: string; destination?: unknown },
  meta: { id: string; now: number },
): Result<ExperienceShare, EngineError> => {
  const destination = input.destination;
  if (destination !== undefined && (typeof destination !== 'string' || !SHARE_DESTINATIONS.includes(destination))) {
    return err(validationError('invalid_share_destination', 'that share destination is not supported'));
  }
  return ok({
    id: meta.id,
    experienceId: input.experienceId,
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    ...(destination === undefined ? {} : { destination }),
    createdAt: meta.now,
  });
};
