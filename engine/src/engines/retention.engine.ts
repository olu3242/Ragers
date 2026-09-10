import { eq } from '../ports/store.ts';
import { isContested } from '../domain/dispute.ts';
import {
  decideRetention,
  OBJECT_STORAGE_BLOCKED_REASON,
  type ByteRemovalStatus,
  type RetentionDecision,
  type RetentionHold,
  type RetentionSubject,
} from '../domain/retention.ts';
import type { DisputeRow, EvidenceRow, QueueItem, RetentionSweepRow, Transcript } from '../ports/store.ts';
import type { MediaAsset } from '../domain/voice.ts';
import type { EngineDeps } from './deps.ts';

/**
 * Retention sweep — E2 Capture, with E4 Trust in support. Phase 65.
 *
 * Finds the raw artefacts past their ceiling, checks whether anything is holding them,
 * marks the ones that are due, and writes a ledger row for every artefact it looked at.
 * The policy — which classes, which ceilings, and why each number — is
 * `src/domain/retention.ts`; this is the part that touches rows.
 *
 * **What this does not do, and cannot.** There is no object storage in any environment
 * this runs in. `originalKey` is a key into a bucket nothing has configured, so the bytes
 * behind it cannot be deleted from here. Every removal this sweep performs is therefore
 * recorded as `object_storage_blocked`: the row is marked, the ledger says what would go,
 * and the byte deletion is named as outstanding rather than reported as done. A sweep
 * that wrote `removed` while a bucket somewhere kept the file would be the first time
 * this codebase claimed something it had not done — and it would be the most damaging
 * possible place to start, because the whole point of a retention policy is that
 * somebody can rely on it.
 *
 * **The key column is deliberately kept.** Forgetting the key before the bytes are gone
 * would orphan the file permanently: nothing would know what to delete once storage
 * exists. So `originalKey` stays and `originalRemovedAt` is what says the artefact is no
 * longer to be read. That ordering is not a compromise; it is the only order that ends
 * with the bytes actually gone.
 *
 * **Nothing here deletes a fact.** The experience, the corroboration, the counts and the
 * protected derivative are untouched, and `retentionDeletesTheFact()` /
 * `retentionAdjustsCorroborationCount()` exist so that stays assertable rather than
 * merely true.
 */

/**
 * How many artefacts one sweep will consider, per class.
 *
 * A bound rather than a full table scan, because a sweep that grows with the archive
 * eventually times out and then never runs at all — and a retention policy that stopped
 * running silently is worse than one that runs a little behind. The oldest are the ones
 * past their ceiling, so a bounded sweep run repeatedly converges.
 */
export const MAX_ARTEFACTS_PER_SWEEP = 500;

export interface RetentionSweepResult {
  readonly considered: number;
  readonly expired: number;
  readonly held: number;
  readonly byteRemoval: ByteRemovalStatus;
  readonly entries: readonly RetentionSweepRow[];
}

/**
 * Which reviews are holding this experience's artefacts, if any.
 *
 * A hold is per *experience*, not per artefact, because that is where a review happens:
 * somebody disputes an experience or a moderator has its report queued, and every raw
 * artefact under it is potential evidence for that decision. Removing one on schedule in
 * the middle of the review destroys the basis for a judgement somebody is about to make,
 * and the judgement then gets made without it.
 */
export const holdsOnExperience = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<readonly RetentionHold[]> => {
  const holds: RetentionHold[] = [];

  const disputes = await deps.store.disputes.query([eq<DisputeRow>('experienceId', experienceId)]);
  if (isContested(disputes)) holds.push('dispute_open');

  // `actioned` and `released` are finished; `queued` and `claimed` are a moderator
  // either about to look or looking now.
  const queued = await deps.store.queueItems.query([eq<QueueItem>('targetId', experienceId)]);
  if (queued.some((item) => item.state === 'queued' || item.state === 'claimed')) {
    holds.push('moderation_review_open');
  }

  return holds;
};

/** The ledger row for one decision, written whatever the verdict was. */
const record = async (
  deps: EngineDeps,
  subjectId: string,
  decision: RetentionDecision,
  byteRemoval: ByteRemovalStatus | undefined,
): Promise<RetentionSweepRow> => {
  const row: RetentionSweepRow = {
    id: deps.ids.next('retention'),
    sweptAt: deps.clock.now(),
    subjectId,
    retentionClass: decision.retentionClass,
    verdict: decision.verdict,
    expiresAt: decision.expiresAt,
    ...(decision.hold === undefined ? {} : { hold: decision.hold }),
    ...(byteRemoval === undefined ? {} : { byteRemoval }),
    reason: decision.reason,
  };
  await deps.store.retentionSweeps.put(row);
  return row;
};

/**
 * The sweep, over all three classes.
 *
 * Sequential rather than concurrent on purpose: this is the most destructive operation in
 * the system, and a sweep whose ordering depends on scheduling is a sweep nobody can
 * reproduce from its ledger.
 */
export const sweepRetention = async (deps: EngineDeps): Promise<RetentionSweepResult> => {
  const now = deps.clock.now();
  const entries: RetentionSweepRow[] = [];
  let expired = 0;
  let held = 0;

  const consider = async (
    subject: RetentionSubject,
    experienceId: string | undefined,
    remove: () => Promise<void>,
  ): Promise<void> => {
    // Holds are only looked up for an artefact that is actually due. Asking on every row
    // would mean two queries per artefact in the archive to answer a question that only
    // matters for the few past their ceiling.
    const provisional = decideRetention(subject, now, []);
    const holds =
      provisional.verdict === 'expired' && experienceId !== undefined
        ? await holdsOnExperience(deps, experienceId)
        : [];
    const decision = decideRetention(subject, now, holds);

    if (decision.verdict === 'expired') {
      await remove();
      expired += 1;
      entries.push(await record(deps, subject.id, decision, 'object_storage_blocked'));
      deps.metrics.increment('retention.expired', { class: decision.retentionClass });
      return;
    }
    if (decision.verdict === 'held') {
      held += 1;
      deps.metrics.increment('retention.held', { hold: decision.hold ?? 'unknown' });
    }
    entries.push(await record(deps, subject.id, decision, undefined));
  };

  // ── Originals ───────────────────────────────────────────────────────────
  const assets = (await deps.store.mediaAssets.query([])).slice(0, MAX_ARTEFACTS_PER_SWEEP);
  for (const asset of assets) {
    await consider(
      {
        id: asset.id,
        retentionClass: 'original_media',
        createdAt: asset.createdAt,
        ...(asset.originalRemovedAt === undefined ? {} : { removedAt: asset.originalRemovedAt }),
      },
      asset.experienceId,
      async () => {
        // The protected derivative is untouched: it *is* the public artefact, and an
        // experience whose protected audio vanished would be indistinguishable from one
        // that never had any.
        const next: MediaAsset = {
          ...asset,
          originalRemovedAt: now,
          originalRemovalReason: OBJECT_STORAGE_BLOCKED_REASON,
          originalByteRemoval: 'object_storage_blocked',
        };
        await deps.store.mediaAssets.put(next);
      },
    );
  }

  // ── Raw transcripts ─────────────────────────────────────────────────────
  const transcripts = (await deps.store.transcripts.query([])).slice(0, MAX_ARTEFACTS_PER_SWEEP);
  for (const transcript of transcripts) {
    // A transcript hangs off its media asset, which is what carries the experience.
    const asset = await deps.store.mediaAssets.get(transcript.mediaAssetId);
    await consider(
      {
        id: transcript.id,
        retentionClass: 'raw_transcript',
        createdAt: transcript.createdAt,
        ...(transcript.rawRemovedAt === undefined ? {} : { removedAt: transcript.rawRemovedAt }),
      },
      asset?.experienceId,
      async () => {
        // `redactedText` survives: it is the published text, and removing it would erase
        // what somebody said rather than the raw record of how they said it.
        const next: Transcript = {
          ...transcript,
          rawRemovedAt: now,
          rawRemovalReason: OBJECT_STORAGE_BLOCKED_REASON,
          rawByteRemoval: 'object_storage_blocked',
        };
        await deps.store.transcripts.put(next);
      },
    );
  }

  // ── Original evidence ───────────────────────────────────────────────────
  const evidence = (await deps.store.evidence.query([])).slice(0, MAX_ARTEFACTS_PER_SWEEP);
  for (const item of evidence) {
    await consider(
      {
        id: item.id,
        retentionClass: 'original_evidence',
        createdAt: item.createdAt,
        ...(item.originalRemovedAt === undefined ? {} : { removedAt: item.originalRemovedAt }),
      },
      item.experienceId,
      async () => {
        const next: EvidenceRow = {
          ...item,
          originalRemovedAt: now,
          originalRemovalReason: OBJECT_STORAGE_BLOCKED_REASON,
          originalByteRemoval: 'object_storage_blocked',
        };
        await deps.store.evidence.put(next);
      },
    );
  }

  return {
    considered: entries.length,
    expired,
    held,
    // The sweep's own honest summary. Not derived per row, because the answer is the same
    // for every row until an environment has a bucket, and reporting it once is what
    // makes it hard to overlook.
    byteRemoval: 'object_storage_blocked',
    entries,
  };
};

/** The ledger for one artefact, newest first — what a surface shows when asked why. */
export const retentionHistoryFor = async (
  deps: EngineDeps,
  subjectId: string,
): Promise<readonly RetentionSweepRow[]> =>
  [...(await deps.store.retentionSweeps.query([eq<RetentionSweepRow>('subjectId', subjectId)]))].sort(
    (left, right) => right.sweptAt - left.sweptAt,
  );

/**
 * Retention has no command, and this is where that is stated.
 *
 * Expiry is a consequence of a clock, not a decision somebody takes about somebody else.
 * A `retention.remove` command would be a way for one person to destroy another's
 * evidence on demand, and there is no legitimate caller for it: an author deleting their
 * own experience already cascades, and an operator who needs an artefact gone before its
 * ceiling has a legal process rather than a button.
 */
export const retentionAcceptsACommand = (): false => false;
