import { err, ok } from '../runtime/result.ts';
import { internalError } from '../runtime/errors.ts';
import { applyRedactions } from '../adapters/fakes.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { PiiFinding } from '../ports/providers.ts';
import type { EngineDeps } from './deps.ts';

/**
 * P10 Privacy & PII Engine.
 *
 * This is the machinery behind the "Identity Protected" promise. It fails
 * closed: if protection cannot complete, the experience stays in
 * `pending_media` and is never published, and the author is told why.
 */

/** Counts by class only. A finding never carries the value it detected. */
const summariseFindings = (findings: readonly PiiFinding[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.piiClass] = (counts[finding.piiClass] ?? 0) + 1;
  }
  return counts;
};

export const createMediaProtectionConsumer = (deps: EngineDeps): Consumer => ({
  name: 'privacy.protect_media',
  events: ['VoiceAssetAttached'],
  handle: async (event) => {
    const mediaAssetId = String(event.payload['mediaAssetId'] ?? '');
    const asset = await deps.store.mediaAssets.get(mediaAssetId);
    if (!asset) return ok(undefined);
    // Idempotent: an already-protected asset is not reprocessed.
    if (asset.protectionStatus === 'protected') return ok(undefined);
    if (asset.protectionStatus === 'dead_letter') return ok(undefined);

    const attempt = asset.attemptCount + 1;
    await deps.store.mediaAssets.put({ ...asset, protectionStatus: 'processing', attemptCount: attempt });

    const result = await deps.providers.pii.protectAudio({
      mediaAssetId: asset.id,
      originalKey: asset.originalKey,
    });

    if (!result.ok) {
      const exhausted = !deps.retry.shouldRetry(result.error, attempt);
      await deps.store.mediaAssets.put({
        ...asset,
        protectionStatus: exhausted ? 'dead_letter' : 'failed',
        attemptCount: attempt,
        failureReason: result.error.code,
      });
      if (exhausted) {
        // Tell the aggregate so the author sees a blocking explanation rather
        // than an experience stuck in limbo.
        await deps.outbox.append(
          [
            {
              aggregateType: 'experience',
              aggregateId: asset.experienceId ?? asset.id,
              eventName: 'MediaProtectionFailed',
              payload: { mediaAssetId: asset.id, reason: result.error.code },
            },
          ],
          event.correlationId,
        );
        deps.metrics.increment('privacy.protection_dead_lettered');
      }
      return err(result.error);
    }

    await deps.store.mediaAssets.put({
      ...asset,
      protectedKey: result.value.protectedKey,
      protectionStatus: 'protected',
      processingStatus: 'ready',
      attemptCount: attempt,
      protectionFindings: summariseFindings(result.value.findings),
    });
    deps.metrics.increment('privacy.media_protected');

    await deps.outbox.append(
      [
        {
          aggregateType: 'experience',
          aggregateId: asset.experienceId ?? asset.id,
          eventName: 'MediaProtected',
          payload: { mediaAssetId: asset.id, findingCount: result.value.findings.length },
        },
      ],
      event.correlationId,
    );
    return ok(undefined);
  },
});

/**
 * Redact a transcript before anything can read it. `redactedText` is the only
 * field any read path returns, and it is written only here.
 */
export const createTranscriptRedactionConsumer = (deps: EngineDeps): Consumer => ({
  name: 'privacy.redact_transcript',
  events: ['TranscriptionCompleted'],
  handle: async (event) => {
    const transcriptId = String(event.payload['transcriptId'] ?? '');
    const transcript = await deps.store.transcripts.get(transcriptId);
    if (!transcript) return ok(undefined);
    if (transcript.redactedText !== undefined) return ok(undefined); // idempotent
    if (transcript.rawText === undefined) {
      return err(internalError('transcript_missing_raw', 'nothing to redact'));
    }

    const findings = await deps.providers.pii.detectInText(transcript.rawText);
    if (!findings.ok) return err(findings.error);

    const redactedText = applyRedactions(transcript.rawText, findings.value);
    await deps.store.transcripts.put({
      ...transcript,
      redactedText,
      processingStatus: 'ready',
      redactionFindings: summariseFindings(findings.value),
    });
    deps.metrics.increment('privacy.transcript_redacted');

    const asset = await deps.store.mediaAssets.get(transcript.mediaAssetId);
    await deps.outbox.append(
      [
        {
          aggregateType: 'experience',
          aggregateId: asset?.experienceId ?? transcript.mediaAssetId,
          eventName: 'TranscriptRedacted',
          payload: { transcriptId: transcript.id, mediaAssetId: transcript.mediaAssetId },
        },
      ],
      event.correlationId,
    );
    return ok(undefined);
  },
});
