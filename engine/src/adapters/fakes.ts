import { err, ok } from '../runtime/result.ts';
import { transientError, internalError, preconditionError } from '../runtime/errors.ts';
import type {
  AssistanceProvider,
  ObjectStore,
  PiiDetector,
  PiiFinding,
  TranscriptionProvider,
} from '../ports/providers.ts';

/**
 * Deterministic provider fakes.
 *
 * Every failure mode the engines must handle is reachable by configuration, so
 * fail-closed behaviour, retries and dead-lettering are exercised without a
 * network call or a real vendor.
 */

export interface FakeControls {
  /** Fail this many times before succeeding. */
  transientFailures?: number;
  /** Fail permanently. */
  hardFail?: boolean;
}

export const createFakeTranscriptionProvider = (
  controls: FakeControls & { text?: string } = {},
): TranscriptionProvider => {
  let remaining = controls.transientFailures ?? 0;
  return {
    name: 'fake-transcription',
    transcribe: async (input) => {
      if (controls.hardFail) return err(internalError('transcription_unprocessable', 'cannot transcribe'));
      if (remaining > 0) {
        remaining -= 1;
        return err(transientError('transcription_unavailable', 'provider temporarily unavailable'));
      }
      return ok({
        text: controls.text ?? `transcript of ${input.mediaAssetId}`,
        language: 'en',
        confidence: 0.94,
      });
    },
  };
};

/**
 * Deterministic PII detector. It recognises a small set of shapes plus an
 * explicit marker so tests can plant identifying detail precisely.
 */
const PERSON_PATTERN = /\b[A-Z][a-z]+ [A-Z][a-z]+\b/g;
const PHONE_PATTERN = /\b\d{3}[- ]?\d{3}[- ]?\d{4}\b/g;
const EMAIL_PATTERN = /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/g;
const PLATE_PATTERN = /\b[A-Z]{3}[- ]?\d{3,4}\b/g;

export const createFakePiiDetector = (controls: FakeControls = {}): PiiDetector => {
  let remaining = controls.transientFailures ?? 0;
  const consumeFailure = () => {
    if (controls.hardFail) return err(internalError('pii_unprocessable', 'cannot process this asset'));
    if (remaining > 0) {
      remaining -= 1;
      return err(transientError('pii_unavailable', 'detector temporarily unavailable'));
    }
    return undefined;
  };

  return {
    name: 'fake-pii',
    detectInText: async (text) => {
      const failure = consumeFailure();
      if (failure) return failure;
      const findings: PiiFinding[] = [];
      const scan = (pattern: RegExp, piiClass: PiiFinding['piiClass']): void => {
        for (const match of text.matchAll(new RegExp(pattern))) {
          if (match.index === undefined) continue;
          findings.push({ piiClass, start: match.index, end: match.index + match[0].length });
        }
      };
      scan(EMAIL_PATTERN, 'email');
      scan(PHONE_PATTERN, 'phone');
      scan(PLATE_PATTERN, 'plate');
      scan(PERSON_PATTERN, 'person_name');
      return ok(findings.sort((a, b) => a.start - b.start));
    },
    protectAudio: async (input) => {
      const failure = consumeFailure();
      if (failure) return failure;
      return ok({
        // The protected derivative is always a distinct key from the original.
        protectedKey: input.originalKey.replace(/^original\//, 'protected/'),
        findings: [],
      });
    },
  };
};

export const createFakeObjectStore = (): ObjectStore & { size(): number } => {
  const objects = new Map<string, Uint8Array>();
  return {
    put: async (key, bytes) => {
      objects.set(key, bytes);
      return ok(undefined);
    },
    exists: async (key) => objects.has(key),
    remove: async (key) => {
      objects.delete(key);
      return ok(undefined);
    },
    keys: async () => [...objects.keys()].sort(),
    size: () => objects.size,
  };
};

/** Redaction: replace each finding's span with a class marker, never the value. */
export const applyRedactions = (text: string, findings: readonly PiiFinding[]): string => {
  if (findings.length === 0) return text;
  const ordered = [...findings].sort((a, b) => b.start - a.start);
  let out = text;
  for (const finding of ordered) {
    out = `${out.slice(0, finding.start)}[${finding.piiClass}]${out.slice(finding.end)}`;
  }
  return out;
};

/**
 * The deterministic assistance provider — Phase 44's fallback.
 *
 * Not a stub, and not a stand-in for a model. It is a *real* provider that summarises the
 * governed state it was handed, deterministically, without inventing anything: every
 * sentence it produces is assembled from the context labels it was given, and its
 * references are a subset of the references it received.
 *
 * That matters because it is what ships when no model provider is configured. The Copilot
 * therefore works — modestly — rather than being absent, and `live: false` is what tells
 * the certification harness the live-provider behaviour is untested rather than passing.
 *
 * `failing` exists so the fail-closed path is exercised: a provider that is down must
 * produce no proposal at all, not a proposal with an empty rationale.
 */
export const createDeterministicAssistanceProvider = (
  options: {
    readonly failing?: boolean;
    /**
     * Override the reported confidence.
     *
     * For exercising the *shape* of a confident provider without pretending one is
     * configured — `live` stays false, so nothing reads this as live-provider evidence.
     * Agents whose floor sits above 0.5 otherwise escalate on every run, which is correct
     * behaviour and also means their proposing path would never be tested at all.
     */
    readonly confidence?: number;
  } = {},
): AssistanceProvider => ({
  name: 'deterministic',
  // The honest answer, and the one the harness reads: this is not a model.
  live: false,
  assist: async (input) => {
    if (options.failing) {
      // Transient, not internal: a provider being down is a condition to retry and to
      // report, never a reason to produce a suggestion with nothing behind it.
      return err(transientError('assistance_unavailable', 'no assistance provider is configured'));
    }
    if (input.references.length === 0) {
      // Refused rather than answered. A suggestion with nothing to check cannot become a
      // proposal — `proposal.create` would refuse it — so producing one would only waste
      // a reviewer's attention.
      return err(
        preconditionError('assistance_needs_references', 'a suggestion must point at rows a reviewer can open'),
      );
    }

    const labels = input.context.map((entry) => entry.label);
    const summary =
      labels.length === 0
        ? `Nothing to summarise for ${input.task}.`
        : `${input.task.replaceAll('_', ' ')}: ${labels.join(', ')}.`;

    return ok({
      summary,
      // Assembled from what it was given, and it says so — a reader must be able to tell
      // this apart from a model's reading of the same rows.
      rationale:
        `Assembled from ${input.references.length} referenced ` +
        `${input.references.length === 1 ? 'row' : 'rows'} without interpretation. ` +
        'No model is configured, so nothing here is inferred.',
      // Deliberately modest. A deterministic restatement is not a confident reading, and
      // several agents' confidence floors are above this — so they escalate instead of
      // proposing, which is the correct behaviour when no model is available.
      confidence: options.confidence ?? 0.5,
      references: input.references,
    });
  },
});
