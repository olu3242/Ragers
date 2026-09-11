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

/**
 * Assistance provider — Phase 44, the Copilot's boundary.
 *
 * A port rather than a client, for the same reason transcription is one: no vendor is
 * load-bearing in the domain, and the failure path is exercised without network access.
 *
 * The shape is deliberately narrow. A provider is handed **governed state that has already
 * been read** and returns a *suggestion with references* — it is never handed a query to
 * run, a table to read, or a command to call. So a provider cannot reach into the engine
 * even if it wanted to, and the worst a compromised or hallucinating one can do is produce
 * a suggestion a person then declines.
 *
 * Every suggestion must carry at least one reference to a durable row. That is not a
 * courtesy to reviewers: `proposal.create` refuses a proposal without traceable evidence,
 * so a suggestion with no references cannot become a proposal and is never shown.
 */
export interface AssistanceReference {
  readonly kind: 'experience' | 'corroboration' | 'evidence' | 'cluster' | 'signal_snapshot' | 'risk_event';
  readonly id: string;
}

export interface AssistanceInput {
  /** What kind of help is wanted, e.g. 'summarise_pattern'. */
  readonly task: string;
  /**
   * The governed state to reason over, already read and already redacted by the caller.
   * A provider never fetches anything itself.
   */
  readonly context: readonly { readonly label: string; readonly text: string }[];
  readonly references: readonly AssistanceReference[];
}

export interface AssistanceOutput {
  readonly summary: string;
  readonly rationale: string;
  /** The provider's own estimate of its own suggestion. Never treated as a finding. */
  readonly confidence: number;
  /** Must be a subset of the references it was given. Nothing invented. */
  readonly references: readonly AssistanceReference[];
}

export interface AssistanceProvider {
  readonly name: string;
  /** True when a real provider is configured. False for the deterministic fallback. */
  readonly live: boolean;
  assist(input: AssistanceInput): Promise<Result<AssistanceOutput, EngineError>>;
}

/**
 * Webhook transport — Phase 49.
 *
 * A port, and optional. Outbound HTTP is the one thing in this engine that cannot be
 * exercised without a network, so it is isolated behind the smallest possible interface:
 * given a url, a body and a signature, either it went or it did not.
 *
 * When no transport is configured a delivery stays `pending` and is retried, rather than
 * being marked sent. Claiming a send that never happened would make the audit trail a
 * fiction, which is worse than an undelivered webhook.
 */
export interface WebhookTransport {
  readonly name: string;
  send(request: {
    readonly url: string;
    readonly body: string;
    readonly signature: string;
  }): Promise<Result<{ readonly status: number }, EngineError>>;
}
