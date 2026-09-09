import { randomUUID } from 'node:crypto';
import type { EngineError } from '../src/runtime/errors.ts';
import type { Result } from '../src/runtime/result.ts';

/** Map the error taxonomy onto HTTP without leaking internal detail. */
const STATUS_BY_KIND: Readonly<Record<EngineError['kind'], number>> = {
  validation: 400,
  unauthorized: 403,
  not_found: 404,
  conflict: 409,
  precondition: 422,
  rate_limited: 429,
  transient: 503,
  internal: 500,
};

export interface ApiFailure {
  readonly error: { readonly code: string; readonly message: string };
}

export const jsonOk = (value: unknown, status = 200): Response =>
  Response.json(value as Record<string, unknown>, { status });

export const jsonError = (error: EngineError): Response =>
  Response.json(
    // `details` stays internal: it can carry diagnostic context.
    { error: { code: error.code, message: error.message } } satisfies ApiFailure,
    { status: STATUS_BY_KIND[error.kind] ?? 500 },
  );

export const respond = <T>(result: Result<T, EngineError>, status = 200): Response =>
  result.ok ? jsonOk(result.value, status) : jsonError(result.error);

/**
 * An idempotency key is required on every write. A client that supplies one can
 * retry safely; one that does not gets a fresh key per request, which is the
 * correct behaviour for a genuinely new intent.
 */
export const idempotencyKeyFrom = (request: Request): string =>
  request.headers.get('idempotency-key') ?? randomUUID();

export const correlationIdFrom = (request: Request): string =>
  request.headers.get('x-correlation-id') ?? randomUUID();

export const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  try {
    const body = await request.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
