import { cookies } from 'next/headers';
import { resolveActorContext } from '../src/engines/identity.engine.ts';
import { GUEST, type ActorContext } from '../src/runtime/authz.ts';
import { getEngine } from './engine-instance.ts';

export const SESSION_COOKIE = 'ragers_session';

/**
 * Resolve the caller from their session cookie. An invalid, expired or revoked
 * session resolves to a guest rather than an error, so read surfaces keep
 * working while write surfaces refuse.
 */
export const currentActor = async (): Promise<ActorContext> => {
  const store = await cookies();
  const sessionId = store.get(SESSION_COOKIE)?.value;
  const resolved = await resolveActorContext(getEngine(), sessionId);
  return resolved.authenticated ? resolved : GUEST;
};
