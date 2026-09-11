/**
 * Error taxonomy. `kind` decides retry behaviour: only `transient` is retried.
 * Invalid input is never retried — replaying it produces the same rejection.
 */
export type ErrorKind =
  | 'validation'
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'precondition'
  | 'rate_limited'
  | 'transient'
  | 'internal';

export interface EngineError {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

const RETRYABLE: ReadonlySet<ErrorKind> = new Set<ErrorKind>(['transient', 'rate_limited']);

export const engineError = (
  kind: ErrorKind,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): EngineError => ({
  kind,
  code,
  message,
  retryable: RETRYABLE.has(kind),
  ...(details === undefined ? {} : { details }),
});

export const validationError = (code: string, message: string, details?: Record<string, unknown>): EngineError =>
  engineError('validation', code, message, details);

export const unauthorizedError = (code: string, message: string, details?: Record<string, unknown>): EngineError =>
  engineError('unauthorized', code, message, details);

export const notFoundError = (code: string, message: string, details?: Record<string, unknown>): EngineError =>
  engineError('not_found', code, message, details);

export const conflictError = (code: string, message: string, details?: Record<string, unknown>): EngineError =>
  engineError('conflict', code, message, details);

export const preconditionError = (code: string, message: string, details?: Record<string, unknown>): EngineError =>
  engineError('precondition', code, message, details);

export const transientError = (code: string, message: string, details?: Record<string, unknown>): EngineError =>
  engineError('transient', code, message, details);

export const internalError = (code: string, message: string, details?: Record<string, unknown>): EngineError =>
  engineError('internal', code, message, details);
