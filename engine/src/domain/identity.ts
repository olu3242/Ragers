import { err, ok, type Result } from '../runtime/result.ts';
import { preconditionError, validationError, type EngineError } from '../runtime/errors.ts';
import type { Role } from '../runtime/authz.ts';
import { isVisibility, type Visibility } from './types.ts';

export type ActorStatus = 'pending' | 'active' | 'suspended' | 'closed';

export interface Actor {
  readonly id: string;
  readonly email: string;
  readonly authProvider: string;
  readonly displayName: string;
  readonly defaultVisibility: Visibility;
  readonly role: Role;
  readonly status: ActorStatus;
  readonly createdAt: number;
  readonly lastActiveAt: number;
}

const ACTOR_TRANSITIONS: Readonly<Record<ActorStatus, readonly ActorStatus[]>> = {
  pending: ['active', 'closed'],
  active: ['suspended', 'closed'],
  suspended: ['active', 'closed'],
  closed: [],
};

export const canTransitionActor = (from: ActorStatus, to: ActorStatus): boolean =>
  (ACTOR_TRANSITIONS[from] ?? []).includes(to);

export const ALIAS_MIN_LENGTH = 3;
export const ALIAS_MAX_LENGTH = 24;
const ALIAS_PATTERN = /^[a-z0-9_]+$/;
export const DISPLAY_NAME_MAX_LENGTH = 40;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RegisterActorInput {
  readonly email: unknown;
  readonly displayName: unknown;
  readonly authProvider?: string;
  readonly defaultVisibility?: unknown;
}

export const registerActor = (
  input: RegisterActorInput,
  meta: { id: string; now: number },
): Result<Actor, EngineError> => {
  if (typeof input.email !== 'string' || !EMAIL_PATTERN.test(input.email.trim())) {
    return err(validationError('invalid_email', 'a valid email address is required'));
  }
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (displayName.length === 0) {
    return err(validationError('display_name_required', 'a display name is required'));
  }
  if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    return err(
      validationError('display_name_too_long', `display name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`),
    );
  }
  const defaultVisibility = input.defaultVisibility ?? 'public';
  if (!isVisibility(defaultVisibility)) {
    return err(validationError('invalid_visibility', 'defaultVisibility must be public, alias or anonymous'));
  }

  return ok({
    id: meta.id,
    email: input.email.trim().toLowerCase(),
    authProvider: input.authProvider ?? 'password',
    displayName,
    defaultVisibility,
    role: 'member',
    status: 'active',
    createdAt: meta.now,
    lastActiveAt: meta.now,
  });
};

/**
 * An alias is a separate entity from the actor so one actor can hold several,
 * each with its own history, without those histories being publicly linkable
 * to each other or to the underlying account.
 */
export interface Alias {
  readonly id: string;
  readonly actorId: string;
  readonly aliasName: string;
  readonly isActive: boolean;
  readonly createdAt: number;
}

export const createAlias = (
  input: { actorId: string; aliasName: unknown },
  existingActiveNames: readonly string[],
  meta: { id: string; now: number },
): Result<Alias, EngineError> => {
  const raw = typeof input.aliasName === 'string' ? input.aliasName.trim().toLowerCase() : '';
  if (raw.length < ALIAS_MIN_LENGTH) {
    return err(validationError('alias_too_short', `alias must be at least ${ALIAS_MIN_LENGTH} characters`));
  }
  if (raw.length > ALIAS_MAX_LENGTH) {
    return err(validationError('alias_too_long', `alias must be at most ${ALIAS_MAX_LENGTH} characters`));
  }
  if (!ALIAS_PATTERN.test(raw)) {
    return err(
      validationError('alias_invalid_characters', 'alias may contain only lowercase letters, digits and underscores'),
    );
  }
  if (existingActiveNames.map((name) => name.toLowerCase()).includes(raw)) {
    return err(preconditionError('alias_taken', 'that alias is already in use'));
  }
  return ok({ id: meta.id, actorId: input.actorId, aliasName: raw, isActive: true, createdAt: meta.now });
};

export const retireAlias = (alias: Alias): Result<Alias, EngineError> => {
  if (!alias.isActive) return ok(alias);
  return ok({ ...alias, isActive: false });
};

export interface Session {
  readonly id: string;
  readonly actorId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revokedAt?: number;
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export const issueSession = (
  actor: Actor,
  meta: { id: string; now: number; ttlMs?: number },
): Result<Session, EngineError> => {
  if (actor.status !== 'active') {
    return err(preconditionError('actor_not_active', `an actor with status ${actor.status} cannot sign in`));
  }
  return ok({
    id: meta.id,
    actorId: actor.id,
    issuedAt: meta.now,
    expiresAt: meta.now + (meta.ttlMs ?? SESSION_TTL_MS),
  });
};

export const revokeSession = (session: Session, now: number): Session =>
  session.revokedAt === undefined ? { ...session, revokedAt: now } : session;

export const isSessionValid = (session: Session, now: number): boolean =>
  session.revokedAt === undefined && session.expiresAt > now;
