import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { err, ok, type Result } from '../runtime/result.ts';
import { preconditionError, validationError, type EngineError } from '../runtime/errors.ts';

/**
 * RC3: a sign-in credential, because until now there was none.
 *
 * ## What this replaces
 *
 * `identity.authenticate` took `{ email }`, found the actor and issued a session. Knowing a
 * moderator's or an admin's email address was enough to become them. RC2 closed that by refusing
 * by default, which was right and left the product with no way for anybody to sign back in —
 * recorded as the blocker conditioning `SECURITY_READY`. This is the credential.
 *
 * ## Why a password and not a magic link
 *
 * A verified magic link or an OTP is the better mechanism and it needs a **transport**: something
 * that delivers a token to an address the person controls. No email or SMS provider exists in this
 * repository, and a one-time token nothing can deliver is not an authentication mechanism — it is a
 * table. So the smallest secure thing the repo actually supports is a password, and the honest
 * consequence is written down rather than glossed: **a password is replayable if it is captured**,
 * which is why the deployment record makes HTTPS, `Secure` and `HttpOnly` non-optional rather than
 * recommended. Swapping in a token mechanism later changes this module and nothing above it.
 *
 * ## Why scrypt
 *
 * It is in `node:crypto`, so this adds no dependency to a codebase whose engine core has four. It
 * is memory-hard, which is the property that matters against an attacker holding the table. Argon2
 * would be a better default and is not available without a native dependency; the parameters are
 * stored **per row** so raising them later is a rotation rather than a migration, and a row written
 * under the old cost keeps verifying until its owner next signs in.
 */

/** The only algorithm this codebase writes. Stored per row so a future one can coexist. */
export type CredentialAlgorithm = 'scrypt';

/**
 * Cost parameters, stored beside the hash.
 *
 * `N = 2^15` with `r = 8` is about 32 MB per verification — enough to make offline guessing
 * expensive, small enough that a serverless request does not fall over. A stored row carries the
 * parameters it was written with, so these can be raised without invalidating anybody's password.
 */
export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keylen: number;
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 32_768, r: 8, p: 1, keylen: 64 };

/** scrypt needs its memory budget raised past the default 32 MB for N = 2^15. */
const MAX_MEMORY = 192 * 1024 * 1024;

export interface ActorCredential {
  /** The actor id. **The credential is keyed by actor, so one actor holds at most one.** */
  readonly id: string;
  readonly algorithm: CredentialAlgorithm;
  readonly params: ScryptParams;
  readonly salt: string;
  readonly hash: string;
  readonly createdAt: number;
  readonly rotatedAt: number;
  /**
   * Consecutive failures since the last success, and the instant before which no attempt is
   * considered. Both are on the credential rather than on a caller, because a per-actor quota
   * cannot express "this caller" — the gap `docs/architecture/ENGINE_GAPS.md` already records.
   */
  readonly failedAttempts: number;
  readonly throttleExpiresAt?: number;
}

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/**
 * Minimum length and nothing else.
 *
 * Composition rules (a digit, a symbol, mixed case) measurably produce *worse* passwords —
 * `Passw0rd!` satisfies every one of them — and a maximum exists only because scrypt will happily
 * hash a megabyte and that is a denial-of-service vector rather than a security feature.
 */
export const passwordProblem = (password: unknown): string | undefined => {
  if (typeof password !== 'string') return 'a password is required';
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `a password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `a password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  return undefined;
};

const derive = (password: string, salt: Buffer, params: ScryptParams): Buffer =>
  scryptSync(password.normalize('NFKC'), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAX_MEMORY,
  });

/**
 * Write a credential for an actor.
 *
 * `password` never reaches a return value, an event or a log: the only things that leave here are
 * a salt and a derived key.
 */
export const createCredential = (
  input: { readonly actorId: string; readonly password: unknown },
  meta: { readonly now: number; readonly params?: ScryptParams },
): Result<ActorCredential, EngineError> => {
  const problem = passwordProblem(input.password);
  if (problem !== undefined) return err(validationError('password_unacceptable', problem));
  const params = meta.params ?? DEFAULT_SCRYPT_PARAMS;
  const salt = randomBytes(32);
  const hash = derive(input.password as string, salt, params);
  return ok({
    id: input.actorId,
    algorithm: 'scrypt',
    params,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    createdAt: meta.now,
    rotatedAt: meta.now,
    failedAttempts: 0,
  });
};

/** Rotation keeps the row's identity and its creation date, so "when was this first set" survives. */
export const rotateCredential = (
  credential: ActorCredential,
  password: unknown,
  meta: { readonly now: number; readonly params?: ScryptParams },
): Result<ActorCredential, EngineError> => {
  const next = createCredential({ actorId: credential.id, password }, meta);
  if (!next.ok) return next;
  return ok({ ...next.value, createdAt: credential.createdAt });
};

/**
 * Failure backoff, with its trade-off stated.
 *
 * After five consecutive failures a credential refuses for a window that doubles to a cap. This is
 * the real control against guessing one known account's password, and it is **also** a way for
 * somebody who knows an email address to make that account wait — a denial of service against one
 * person. The alternative is no limit at all, which is worse, and the proper answer is per-caller
 * throttling at the edge, which a per-actor window cannot express. Recorded rather than hidden.
 *
 * The refusal a throttled credential produces is the *same* refusal a wrong password produces, so
 * the backoff never becomes an oracle for which addresses have accounts.
 */
export const THROTTLE_AFTER_FAILURES = 5;
export const THROTTLE_BASE_MS = 30 * 1_000;
export const THROTTLE_MAX_MS = 15 * 60 * 1_000;

export const throttleWindowFor = (failedAttempts: number): number => {
  if (failedAttempts < THROTTLE_AFTER_FAILURES) return 0;
  const doublings = failedAttempts - THROTTLE_AFTER_FAILURES;
  return Math.min(THROTTLE_BASE_MS * 2 ** doublings, THROTTLE_MAX_MS);
};

export const isThrottled = (credential: ActorCredential, now: number): boolean =>
  credential.throttleExpiresAt !== undefined && credential.throttleExpiresAt > now;

/**
 * Verify a password against a stored credential.
 *
 * `timingSafeEqual` rather than `===`, and the lengths are compared first because it throws on a
 * length mismatch. A stored hash of the wrong length is treated as a failure rather than an
 * exception: a corrupt row must not become a 500 that distinguishes itself from a wrong password.
 */
export const verifyPassword = (credential: ActorCredential, password: unknown): boolean => {
  if (typeof password !== 'string' || password.length === 0) return false;
  let stored: Buffer;
  try {
    stored = Buffer.from(credential.hash, 'base64');
  } catch {
    return false;
  }
  if (stored.length !== credential.params.keylen) return false;
  const salt = Buffer.from(credential.salt, 'base64');
  let candidate: Buffer;
  try {
    candidate = derive(password, salt, credential.params);
  } catch {
    return false;
  }
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
};

/**
 * Spend the same work as a real verification, and always fail.
 *
 * **This closes a timing oracle, and it is the whole reason the refusals above can be identical.**
 * A wrong password costs one scrypt derivation — tens of milliseconds. An address with no account,
 * or an account with no credential, would cost a table lookup and nothing else. The refusal text
 * would be the same and the *clock* would not, so anybody could tell which addresses hold accounts
 * by timing the response, on a product whose first promise is that you can speak without exposing
 * yourself.
 *
 * So the no-account and no-credential paths call this instead of returning early. The decoy salt is
 * fixed and the derived key is discarded; the only thing being bought is the time.
 */
const DECOY_SALT = Buffer.from(
  // A constant, because a random salt per call would be indistinguishable in cost and would only
  // make the code look more cryptographic than it is.
  'cmFnZXJzLWRlY295LXNhbHQtZm9yLXVuaWZvcm0tdGltaW5nLXYx',
  'base64',
);

export const spendVerificationWork = (
  password: unknown,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): false => {
  const candidate = typeof password === 'string' && password.length > 0 ? password : 'decoy';
  try {
    derive(candidate.slice(0, PASSWORD_MAX_LENGTH), DECOY_SALT, params);
  } catch {
    // Cost spent either way. A throw here must not distinguish itself from a wrong password.
  }
  return false;
};

/** After a failure: one more strike, and a window if the threshold is crossed. */
export const recordFailure = (credential: ActorCredential, now: number): ActorCredential => {
  const failedAttempts = credential.failedAttempts + 1;
  const window = throttleWindowFor(failedAttempts);
  return {
    ...credential,
    failedAttempts,
    ...(window > 0 ? { throttleExpiresAt: now + window } : {}),
  };
};

/** After a success: the strikes are gone, and so is any window. */
export const recordSuccess = (credential: ActorCredential): ActorCredential => {
  const { throttleExpiresAt: _cleared, ...rest } = credential;
  return { ...rest, failedAttempts: 0 };
};

/**
 * Absences, asserted rather than assumed — the pattern used throughout this codebase.
 *
 * A password is never recoverable, only replaceable; a credential never carries a role, because
 * authority lives on the actor and a credential that could grant one would be a second authority
 * model beside the policy matrix.
 */
export const credentialCanBeRead = (): boolean => false;
export const credentialCarriesARole = (): boolean => false;
