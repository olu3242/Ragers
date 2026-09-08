import type { EngineError } from './errors.ts';

/**
 * Idempotency: a replayed command returns the first outcome and causes no
 * second effect. Reservation is separate from completion so a crash between
 * the two leaves the key reserved rather than falsely completed.
 */
export interface IdempotencyRecord {
  readonly key: string;
  readonly actorId: string;
  readonly commandName: string;
  readonly state: 'reserved' | 'completed';
  readonly response?: unknown;
  readonly error?: EngineError;
  readonly createdAt: number;
}

export type ReserveOutcome =
  | { readonly status: 'reserved' }
  | { readonly status: 'in_flight'; readonly record: IdempotencyRecord }
  | { readonly status: 'replayed'; readonly record: IdempotencyRecord };

export interface IdempotencyStore {
  reserve(key: string, actorId: string, commandName: string): Promise<ReserveOutcome>;
  complete(key: string, response: unknown): Promise<void>;
  fail(key: string, error: EngineError): Promise<void>;
  release(key: string): Promise<void>;
  get(key: string): Promise<IdempotencyRecord | undefined>;
}
