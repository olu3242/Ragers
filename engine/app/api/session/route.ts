import { getEngine } from '../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, jsonError, readJson } from '../../../lib/api.ts';
import { SESSION_COOKIE } from '../../../lib/session.ts';
import { GUEST } from '../../../src/runtime/authz.ts';
import { cookieAttributes } from '../../../lib/engine-store.ts';
import type { AuthResult } from '../../../src/engines/identity.engine.ts';

/**
 * Sign up or sign in. Both paths return the same shape and the same failure,
 * so neither discloses whether an account already exists.
 *
 * RC3: `mode: 'signin'` now carries a password. The route does not check it and must not — the
 * verification is in the engine, where a caller reaching the bus directly still faces it. What the
 * route owns is the cookie, and that is where RC3's change is: `Secure` is added whenever the
 * deployment is not plain local HTTP, because a session cookie sent in clear is the one way a
 * password-based mechanism loses everything it just proved.
 */
export const POST = async (request: Request): Promise<Response> => {
  const engine = getEngine();
  const body = await readJson(request);
  const mode = body['mode'] === 'signin' ? 'signin' : 'signup';

  const result = await engine.bus.dispatch<unknown, AuthResult>({
    name: mode === 'signup' ? 'identity.register' : 'identity.authenticate',
    input: body,
    actor: GUEST,
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });

  if (!result.ok) return jsonError(result.error);

  const response = Response.json({
    actorId: result.value.actorId,
    displayName: result.value.displayName,
    role: result.value.role,
  });
  response.headers.append(
    'set-cookie',
    // HttpOnly so the session is unreachable from page scripts; Secure so it never travels in
    // clear. `cookieAttributes()` decides the second from the deployment rather than from
    // NODE_ENV, and omits it only for plain local HTTP where a Secure cookie would simply not
    // be sent and sign-in would appear to fail for no visible reason.
    `${SESSION_COOKIE}=${result.value.sessionId}; Path=/; ${cookieAttributes()}; Max-Age=${
      Math.floor((result.value.expiresAt - Date.now()) / 1000)
    }`,
  );
  return response;
};
