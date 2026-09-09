import type { Result } from '../runtime/result.ts';
import type { EngineError } from '../runtime/errors.ts';

/**
 * External provider boundaries. Every one has a deterministic fake used in
 * tests, so no vendor is load-bearing in the domain and failure paths are
 * exercised without network access.
 */

export interface TranscriptionInput {
  readonly mediaAssetId: string;
  readonly storageKey: string;
  readonly durationMs: number;
}

export interface TranscriptionOutput {
  readonly text: string;
  readonly language: string;
  readonly confidence: number;
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(input: TranscriptionInput): Promise<Result<TranscriptionOutput, EngineError>>;
}

/** A PII finding reports its class and location, never the detected value. */
export interface PiiFinding {
  readonly piiClass: 'person_name' | 'phone' | 'email' | 'address' | 'plate' | 'face' | 'other';
  readonly start: number;
  readonly end: number;
}

export interface PiiDetector {
  readonly name: string;
  detectInText(text: string): Promise<Result<readonly PiiFinding[], EngineError>>;
  /** Media protection produces a new storage key for the protected derivative. */
  protectAudio(input: {
    readonly mediaAssetId: string;
    readonly originalKey: string;
  }): Promise<Result<{ protectedKey: string; findings: readonly PiiFinding[] }, EngineError>>;
}

export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<Result<void, EngineError>>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<Result<void, EngineError>>;
  keys(): Promise<readonly string[]>;
}
