import { err, ok } from '../runtime/result.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { Transcript } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * P8 Voice Intelligence Engine.
 *
 * Enrichment never blocks publication or playback: a voice experience is fully
 * usable while its transcript is still `queued`. Failure degrades to an
 * explicit "transcript unavailable" state rather than an empty box.
 */
export const createTranscriptionConsumer = (deps: EngineDeps): Consumer => ({
  name: 'voice.transcribe',
  events: ['MediaProtected'],
  handle: async (event) => {
    const mediaAssetId = String(event.payload['mediaAssetId'] ?? '');
    const asset = await deps.store.mediaAssets.get(mediaAssetId);
    if (!asset || asset.kind !== 'audio') return ok(undefined);

    const existing = await deps.store.transcripts.findOne((row) => row.mediaAssetId === mediaAssetId);
    // Idempotent: a transcript that already has text is not re-requested.
    if (existing?.rawText !== undefined) return ok(undefined);
    if (existing?.processingStatus === 'dead_letter') return ok(undefined);

    const attempt = (existing?.attemptCount ?? 0) + 1;
    const transcriptId = existing?.id ?? deps.ids.next('tr');
    const base: Transcript = {
      id: transcriptId,
      mediaAssetId,
      processingStatus: 'processing',
      attemptCount: attempt,
      provider: deps.providers.transcription.name,
      createdAt: existing?.createdAt ?? deps.clock.now(),
    };
    await deps.store.transcripts.put(base);

    const result = await deps.providers.transcription.transcribe({
      mediaAssetId,
      // Transcription runs inside the trust boundary, on the original.
      storageKey: asset.originalKey,
      durationMs: asset.durationMs,
    });

    if (!result.ok) {
      const exhausted = !deps.retry.shouldRetry(result.error, attempt);
      await deps.store.transcripts.put({
        ...base,
        processingStatus: exhausted ? 'dead_letter' : 'failed',
        failureReason: result.error.code,
      });
      if (exhausted) {
        deps.metrics.increment('voice.transcription_dead_lettered');
        await deps.outbox.append(
          [
            {
              aggregateType: 'experience',
              aggregateId: asset.experienceId ?? mediaAssetId,
              eventName: 'TranscriptionFailed',
              payload: { transcriptId, mediaAssetId, reason: result.error.code },
            },
          ],
          event.correlationId,
        );
      }
      return err(result.error);
    }

    await deps.store.transcripts.put({
      ...base,
      // rawText is internal only: no read path returns it, and redaction is
      // what produces the readable form.
      rawText: result.value.text,
      language: result.value.language,
      confidence: result.value.confidence,
      processingStatus: 'processing',
    });
    deps.metrics.increment('voice.transcribed');

    await deps.outbox.append(
      [
        {
          aggregateType: 'experience',
          aggregateId: asset.experienceId ?? mediaAssetId,
          eventName: 'TranscriptionCompleted',
          payload: { transcriptId, mediaAssetId, language: result.value.language },
        },
      ],
      event.correlationId,
    );
    return ok(undefined);
  },
});
