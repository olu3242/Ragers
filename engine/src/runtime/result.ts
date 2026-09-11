/**
 * Result — explicit success/failure without exceptions on the command path.
 * Every command handler and consumer returns a Result so failure is part of
 * the type, not a control-flow surprise.
 */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

/** Unwrap a Result, throwing on failure. Tests and composition roots only. */
export const expect = <T, E>(r: Result<T, E>, context: string): T => {
  if (r.ok) return r.value;
  throw new Error(`${context}: ${JSON.stringify(r.error)}`);
};

export const mapOk = <T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> =>
  r.ok ? ok(f(r.value)) : r;
