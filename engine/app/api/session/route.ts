import { getEngine } from '../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, jsonError, readJson } from '../../../lib/api.ts';
import { SESSION_COOKIE } from '../../../lib/session.ts';
import { GUEST } from '../../../src/runtime/authz.ts';
import type { AuthResult } from '../../../src/engines/identity.engine.ts';

/**
 * Sign up or sign in. Both paths return the same shape and the same failure,
 * so neither discloses whether an account already exists.
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
    // HttpOnly so the session is unreachable from page scripts.
    `${SESSION_COOKIE}=${result.value.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
      Math.floor((result.value.expiresAt - Date.now()) / 1000)
    }`,
  );
  return response;
};
