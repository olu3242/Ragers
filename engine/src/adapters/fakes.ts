import { err, ok } from '../runtime/result.ts';
import { transientError, internalError } from '../runtime/errors.ts';
import type { ObjectStore, PiiDetector, PiiFinding, TranscriptionProvider } from '../ports/providers.ts';

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
