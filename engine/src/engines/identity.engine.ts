import { err, ok } from '../runtime/result.ts';
import {
  conflictError,
  notFoundError,
  preconditionError,
  unauthorizedError,
  validationError,
} from '../runtime/errors.ts';
import {
  createAlias,
  issueSession,
  registerActor,
  retireAlias,
  revokeSession,
  type Actor,
  type Session,
} from '../domain/identity.ts';
import {
  createCredential,
  isThrottled,
  passwordProblem,
  spendVerificationWork,
  recordFailure,
  recordSuccess,
  rotateCredential,
  verifyPassword,
} from '../domain/credential.ts';
import { isVisibility, type Visibility } from '../domain/types.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { EngineDeps } from './deps.ts';
import { writeAudit } from './support.ts';
import { eq } from '../ports/store.ts';

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
      const existing = await deps.store.actors.queryOne([eq('email', email)]);
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

  /**
   * RC3 sign-in. **A credential is required, and the refusal never says which part was wrong.**
   *
   * Every failure below — no such address, no credential set, wrong password, throttled, account
   * not active — returns the identical `authentication_failed`. That is not tidiness: a refusal
   * that distinguished them would let anybody enumerate which addresses hold accounts, and on a
   * product whose whole promise is that you can speak without exposing yourself, the membership
   * list is itself sensitive.
   *
   * `allowPasswordlessSignIn` survives as the development escape hatch it was, and now means
   * exactly one thing: skip the credential check. It is gated on `RAGERS_TEST_SEED` at the
   * composition root and is `false` in `defaultConfig`.
   */
  const authenticate: CommandHandler<{ email: string; password?: unknown }, AuthResult> = {
    name: 'identity.authenticate',
    action: 'actor.authenticate',
    resolveResource: async () => ok({ type: 'actor' }),
    handle: async (input, ctx) => {
      const failed = () =>
        err(unauthorizedError('authentication_failed', 'those credentials are not valid'));

      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      const credentialsRequired = !deps.config.allowPasswordlessSignIn;

      // Every early exit below spends a verification's worth of work first, so the refusals are
      // indistinguishable by the clock as well as by their text. See `spendVerificationWork`.
      if (email.length === 0) {
        if (credentialsRequired) spendVerificationWork(input.password);
        return failed();
      }

      const actor = await deps.store.actors.queryOne([eq('email', email)]);
      if (!actor) {
        if (credentialsRequired) spendVerificationWork(input.password);
        return failed();
      }

      if (credentialsRequired) {
        const credential = await deps.store.actorCredentials.get(actor.id);
        // An account with no credential cannot be signed into. Distinguishing that from a wrong
        // password would say "this address exists but has not finished setting up", which is more
        // than a stranger should learn.
        if (!credential) {
          spendVerificationWork(input.password);
          return failed();
        }
        if (isThrottled(credential, ctx.clock.now())) {
          spendVerificationWork(input.password, credential.params);
          return failed();
        }

        if (!verifyPassword(credential, input.password)) {
          // The strike is recorded before the refusal returns, so a burst of guesses cannot
          // outrun the backoff by failing fast.
          await deps.store.actorCredentials.put(recordFailure(credential, ctx.clock.now()));
          return failed();
        }
        await deps.store.actorCredentials.put(recordSuccess(credential));
      }

      const sessionResult = issueSession(actor, { id: deps.ids.next('sess'), now: ctx.clock.now() });
      // `issueSession` refuses a suspended or closed actor. Collapsed into the same refusal: that
      // an account is suspended is a moderation fact and not a sign-in hint.
      if (!sessionResult.ok) return failed();

      /**
       * **Session rotation.** Every other live session for this actor is revoked as this one is
       * issued, so a session captured earlier stops working the moment its owner signs in again —
       * which is the one recovery action a person can take by themselves. It also bounds how many
       * live sessions one account can accumulate, which is what makes revocation meaningful.
       */
      const existing = await deps.store.sessions.query([eq('actorId', actor.id)]);
      const now = ctx.clock.now();
      for (const session of existing) {
        if (session.revokedAt === undefined && session.expiresAt > now) {
          await deps.store.sessions.put(revokeSession(session, now));
        }
      }

      await deps.store.sessions.put(sessionResult.value);
      await deps.store.actors.put({ ...actor, lastActiveAt: now });

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

  /**
   * Set or replace your own password.
   *
   * `ownerActorId` is the caller, so the policy matrix enforces that nobody sets anybody else's —
   * **including an admin**, because an operator who can write a member's credential can become
   * that member, and every governance rule in this codebase assumes an action attributed to a
   * person was taken by them.
   *
   * Replacing an existing password requires the current one. Without that check a stolen session
   * would be upgradeable into permanent account ownership, which is a different and worse thing
   * than a stolen session.
   */
  const setPassword: CommandHandler<
    { password: unknown; currentPassword?: unknown },
    { set: true; rotated: boolean }
  > = {
    name: 'identity.setPassword',
    action: 'actor.set_password',
    resolveResource: async (_input, ctx) => ok({ type: 'actor', ownerActorId: ctx.actor.actorId }),
    handle: async (input, ctx) => {
      const problem = passwordProblem(input.password);
      if (problem !== undefined) return err(validationError('password_unacceptable', problem));

      const actor = await deps.store.actors.get(ctx.actor.actorId);
      if (!actor) return err(notFoundError('actor_not_found', 'no such actor'));

      const existing = await deps.store.actorCredentials.get(actor.id);
      if (existing) {
        if (isThrottled(existing, ctx.clock.now())) {
          return err(unauthorizedError('authentication_failed', 'those credentials are not valid'));
        }
        if (!verifyPassword(existing, input.currentPassword)) {
          await deps.store.actorCredentials.put(recordFailure(existing, ctx.clock.now()));
          return err(unauthorizedError('authentication_failed', 'those credentials are not valid'));
        }
      }

      const next = existing
        ? rotateCredential(existing, input.password, { now: ctx.clock.now() })
        : createCredential({ actorId: actor.id, password: input.password }, { now: ctx.clock.now() });
      if (!next.ok) return next;
      await deps.store.actorCredentials.put(recordSuccess(next.value));

      // Phase 68, clause 2: this changes what somebody may do. The trail records that a credential
      // was written and carries no part of it — not the password, not the hash, not the salt.
      await writeAudit(deps, ctx, {
        action: 'actor.set_password',
        resourceType: 'actor',
        resourceId: actor.id,
        before: { hasCredential: existing !== undefined },
        after: { hasCredential: true },
      });

      return ok({
        value: { set: true, rotated: existing !== undefined },
        events: [
          {
            aggregateType: 'actor',
            aggregateId: actor.id,
            eventName: 'CredentialSet',
            payload: { actorId: actor.id, rotated: existing !== undefined },
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

      // Phase 68, clause 2: revocation changes what somebody may do, immediately and
      // without warning them. Whether they did it themselves or somebody with authority did
      // it to them is exactly what the trail has to distinguish.
      await writeAudit(deps, ctx, {
        action: 'session.revoke',
        resourceType: 'session',
        resourceId: session.id,
        before: { actorId: session.actorId },
        after: { revoked: true },
      });

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
      const active = await deps.store.aliases.query([{ field: 'isActive', op: 'isTrue' }]);
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
  deps.bus.register(setPassword);
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
