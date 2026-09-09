import { err, ok } from '../runtime/result.ts';
import { conflictError, notFoundError, preconditionError, unauthorizedError } from '../runtime/errors.ts';
import {
  createAlias,
  issueSession,
  registerActor,
  retireAlias,
  revokeSession,
  type Actor,
  type Session,
} from '../domain/identity.ts';
import { isVisibility, type Visibility } from '../domain/types.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { EngineDeps } from './deps.ts';
import { writeAudit } from './support.ts';

export interface RegisterInput {
  readonly email: string;
  readonly displayName: string;
  readonly defaultVisibility?: Visibility;
}

export interface AuthResult {
  readonly actorId: string;
  readonly sessionId: string;
  readonly displayName: string;
  readonly role: Actor['role'];
  readonly expiresAt: number;
}

/**
 * P3 Identity & Access. Registration always yields a `member`; privilege is
 * granted explicitly through the governance engine, never here.
 */
export const registerIdentityEngine = (deps: EngineDeps): void => {
  const register: CommandHandler<RegisterInput, AuthResult> = {
    name: 'identity.register',
    action: 'actor.register',
    resolveResource: async () => ok({ type: 'actor' }),
    handle: async (input, ctx) => {
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      const existing = await deps.store.actors.findOne((row) => row.email === email);
      if (existing) {
        // Registration does not disclose whether an account already exists.
        return err(conflictError('registration_unavailable', 'that account cannot be registered'));
      }

      const actorResult = registerActor(input, { id: deps.ids.next('actor'), now: ctx.clock.now() });
      if (!actorResult.ok) return actorResult;
      const actor = actorResult.value;

      const sessionResult = issueSession(actor, { id: deps.ids.next('sess'), now: ctx.clock.now() });
      if (!sessionResult.ok) return sessionResult;

      await deps.store.actors.put(actor);
      await deps.store.sessions.put(sessionResult.value);

      return ok({
        value: {
          actorId: actor.id,
          sessionId: sessionResult.value.id,
          displayName: actor.displayName,
          role: actor.role,
          expiresAt: sessionResult.value.expiresAt,
        },
        events: [
          {
            aggregateType: 'actor',
            aggregateId: actor.id,
            eventName: 'ActorRegistered',
            payload: { actorId: actor.id },
          },
          {
            aggregateType: 'actor',
            aggregateId: actor.id,
            eventName: 'SessionIssued',
            payload: { actorId: actor.id, sessionId: sessionResult.value.id },
          },
        ],
      });
    },
  };

  const authenticate: CommandHandler<{ email: string }, AuthResult> = {
    name: 'identity.authenticate',
    action: 'actor.authenticate',
    resolveResource: async () => ok({ type: 'actor' }),
    handle: async (input, ctx) => {
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      const actor = await deps.store.actors.findOne((row) => row.email === email);
      // A failed sign-in never reveals whether the account exists.
      if (!actor) return err(unauthorizedError('authentication_failed', 'those credentials are not valid'));

      const sessionResult = issueSession(actor, { id: deps.ids.next('sess'), now: ctx.clock.now() });
      if (!sessionResult.ok) {
        return err(unauthorizedError('authentication_failed', 'those credentials are not valid'));
      }

      await deps.store.sessions.put(sessionResult.value);
      await deps.store.actors.put({ ...actor, lastActiveAt: ctx.clock.now() });

      return ok({
        value: {
          actorId: actor.id,
          sessionId: sessionResult.value.id,
          displayName: actor.displayName,
          role: actor.role,
          expiresAt: sessionResult.value.expiresAt,
        },
        events: [
          {
            aggregateType: 'actor',
            aggregateId: actor.id,
            eventName: 'SessionIssued',
            payload: { actorId: actor.id, sessionId: sessionResult.value.id },
          },
        ],
      });
    },
  };

  const revoke: CommandHandler<{ sessionId: string }, { revoked: true }> = {
    name: 'identity.revokeSession',
    action: 'session.revoke',
    resolveResource: async (input) => {
      const session = await deps.store.sessions.get(input.sessionId);
      if (!session) return err(notFoundError('session_not_found', 'no such session'));
      return ok({ type: 'session', id: session.id, ownerActorId: session.actorId });
    },
    handle: async (input, ctx) => {
      const session = await deps.store.sessions.get(input.sessionId);
      if (!session) return err(notFoundError('session_not_found', 'no such session'));
      await deps.store.sessions.put(revokeSession(session, ctx.clock.now()));
      return ok({
        value: { revoked: true },
        events: [
          {
            aggregateType: 'actor',
            aggregateId: session.actorId,
            eventName: 'SessionRevoked',
            payload: { sessionId: session.id },
          },
        ],
      });
    },
  };

  const addAlias: CommandHandler<{ aliasName: string }, { aliasId: string; aliasName: string }> = {
    name: 'identity.createAlias',
    action: 'alias.create',
    resolveResource: async (_input, ctx) => ok({ type: 'alias', ownerActorId: ctx.actor.actorId }),
    handle: async (input, ctx) => {
      const active = await deps.store.aliases.find((row) => row.isActive);
      const aliasResult = createAlias(
        { actorId: ctx.actor.actorId, aliasName: input.aliasName },
        active.map((row) => row.aliasName),
        { id: deps.ids.next('alias'), now: ctx.clock.now() },
      );
      if (!aliasResult.ok) return aliasResult;
      await deps.store.aliases.put(aliasResult.value);
      return ok({
        value: { aliasId: aliasResult.value.id, aliasName: aliasResult.value.aliasName },
        events: [
          {
            aggregateType: 'actor',
            aggregateId: ctx.actor.actorId,
            eventName: 'AliasCreated',
            payload: { aliasId: aliasResult.value.id },
          },
        ],
      });
    },
  };

  const dropAlias: CommandHandler<{ aliasId: string }, { retired: true }> = {
    name: 'identity.retireAlias',
    action: 'alias.retire',
    resolveResource: async (input) => {
      const alias = await deps.store.aliases.get(input.aliasId);
      if (!alias) return err(notFoundError('alias_not_found', 'no such alias'));
      return ok({ type: 'alias', id: alias.id, ownerActorId: alias.actorId });
    },
    handle: async (input) => {
      const alias = await deps.store.aliases.get(input.aliasId);
      if (!alias) return err(notFoundError('alias_not_found', 'no such alias'));
      const retired = retireAlias(alias);
      if (!retired.ok) return retired;
      await deps.store.aliases.put(retired.value);
      return ok({
        value: { retired: true },
        events: [
          {
            aggregateType: 'actor',
            aggregateId: alias.actorId,
            eventName: 'AliasRetired',
            payload: { aliasId: alias.id },
          },
        ],
      });
    },
  };

  const setDefaultVisibility: CommandHandler<{ visibility: Visibility }, { visibility: Visibility }> = {
    name: 'identity.setDefaultVisibility',
    action: 'actor.set_default_visibility',
    resolveResource: async (_input, ctx) => ok({ type: 'actor', ownerActorId: ctx.actor.actorId }),
    handle: async (input, ctx) => {
      if (!isVisibility(input.visibility)) {
        return err(preconditionError('invalid_visibility', 'visibility must be public, alias or anonymous'));
      }
      const actor = await deps.store.actors.get(ctx.actor.actorId);
      if (!actor) return err(notFoundError('actor_not_found', 'no such actor'));
      await deps.store.actors.put({ ...actor, defaultVisibility: input.visibility });
      await writeAudit(deps, ctx, {
        action: 'actor.set_default_visibility',
        resourceType: 'actor',
        resourceId: actor.id,
        before: { defaultVisibility: actor.defaultVisibility },
        after: { defaultVisibility: input.visibility },
      });
      return ok({ value: { visibility: input.visibility }, events: [] });
    },
  };

  deps.bus.register(register);
  deps.bus.register(authenticate);
  deps.bus.register(revoke);
  deps.bus.register(addAlias);
  deps.bus.register(dropAlias);
  deps.bus.register(setDefaultVisibility);
};

/** Resolve the actor context for a session — the entry point every request uses. */
export const resolveActorContext = async (
  deps: EngineDeps,
  sessionId: string | undefined,
): Promise<{ actorId: string; role: Actor['role']; authenticated: boolean; sessionId?: string }> => {
  if (!sessionId) return { actorId: 'guest', role: 'guest', authenticated: false };
  const session: Session | undefined = await deps.store.sessions.get(sessionId);
  if (!session || session.revokedAt !== undefined || session.expiresAt <= deps.clock.now()) {
    return { actorId: 'guest', role: 'guest', authenticated: false };
  }
  const actor = await deps.store.actors.get(session.actorId);
  if (!actor || actor.status !== 'active') {
    return { actorId: 'guest', role: 'guest', authenticated: false };
  }
  return { actorId: actor.id, role: actor.role, authenticated: true, sessionId: session.id };
};
