import type { EngineError } from './errors.ts';

/**
 * Deterministic backoff. Determinism matters: retry timing is asserted in tests,
 * and an operator reading a dead-letter history must be able to reconstruct it.
 */
export interface RetryPolicy {
  readonly maxAttempts: number;
  backoffMs(attempt: number): number;
  shouldRetry(error: EngineError, attempt: number): boolean;
}

export interface RetryPolicyOptions {
  readonly maxAttempts?: number;
  readonly baseMs?: number;
  readonly maxMs?: number;
  readonly factor?: number;
}

export const createRetryPolicy = (options: RetryPolicyOptions = {}): RetryPolicy => {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseMs = options.baseMs ?? 1_000;
  const maxMs = options.maxMs ?? 60_000;
  const factor = options.factor ?? 2;
  return {
    maxAttempts,
    backoffMs: (attempt: number) => {
      if (attempt < 1) return baseMs;
      return Math.min(maxMs, Math.round(baseMs * factor ** (attempt - 1)));
    },
    shouldRetry: (error: EngineError, attempt: number) => error.retryable && attempt < maxAttempts,
  };
};
