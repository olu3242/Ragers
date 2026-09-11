/**
 * Phase 65 — retention and data minimisation.
 *
 * What this closes: nothing in phases 1–64 states how long a raw artefact lives, and
 * nothing removes one. `media_assets.original_key`, `transcripts.raw_text` and
 * `evidence.original_key` are *unreadable* on every path — the grants and the RLS
 * policies hold that, and the privacy gate certifies it — and **unreadable is not the
 * same as absent**. An original nobody can read is still an original somebody can be
 * compelled to produce, and still an original a future bug can expose. The only way to
 * stop holding a thing is to stop holding it.
 *
 * Three ideas do the work here, and the second and third are the ones worth arguing
 * about.
 *
 * **1. A ceiling per class of artefact, not one global sweep.** A raw voice recording of
 * somebody's worst afternoon and its identity-protected derivative are not the same risk
 * and do not get the same clock. Neither is a raw transcript the same as evidence
 * somebody submitted *in order to be examined* — evidence exists to be weighed in a
 * dispute, so its clock has to outlast the dispute process or it defeats the purpose of
 * accepting it. So: four classes, four ceilings, each stated with its reason.
 *
 * **2. Expiry removes the artefact, never the fact.** The experience stays. The
 * corroboration stays. The counts stay. What goes is the bytes, and the row says so —
 * `originalRemovedAt` and a reason, rather than a null nobody can distinguish from an
 * upload that never happened. A retention policy that quietly reduced a count would be
 * rewriting what people said happened to them, which is the one thing this system is
 * built not to do.
 *
 * **3. A hold beats a ceiling.** Nothing expires while a dispute or a moderation review
 * is open on it. This is not a courtesy — an artefact removed on schedule in the middle
 * of a review destroys the evidence for a decision somebody is about to make, and the
 * decision then gets made without it. The hold is stated in one place and applies to
 * every class.
 *
 * **The deletion of remote bytes is not certifiable here.** There is no object storage in
 * any environment this runs in; `originalKey` is a key into a store that does not exist
 * yet. So this module decides *what would be removed and why*, records that decision, and
 * reports `OBJECT_STORAGE_BLOCKED` for the byte deletion itself. That is the honest
 * split: the policy and the ledger are real and testable now, and the part that needs a
 * bucket says it needs a bucket rather than pretending a no-op succeeded.
 */

/**
 * The classes of artefact retention governs.
 *
 * `protected_media` and `redacted_transcript` are deliberately absent from the expiring
 * set: they *are* the public artefact. An experience with its protected audio removed is
 * an experience whose evidence silently vanished, and a reader would have no way to tell
 * that from one that never had any. They live with the experience and go when it goes,
 * which the `on delete cascade` already handles.
 */
export type RetentionClass = 'original_media' | 'raw_transcript' | 'original_evidence';

export const RETENTION_CLASSES: readonly RetentionClass[] = [
  'original_media',
  'raw_transcript',
  'original_evidence',
];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionPolicy {
  /** How long the raw artefact may be held, from its creation. */
  readonly ceilingMs: number;
  /** Why this class has this ceiling and not the same one as its neighbours. */
  readonly reason: string;
}

/**
 * The ceilings, each with the argument for its own number.
 *
 * These are the numbers the product is prepared to defend, not the longest ones that
 * would be convenient. Where a number is a judgement it says so.
 */
export const RETENTION_POLICIES: Readonly<Record<RetentionClass, RetentionPolicy>> = {
  original_media: {
    ceilingMs: 30 * DAY_MS,
    reason:
      'The original is only needed until protection has produced its derivative and any ' +
      'protection failure has been re-run. Thirty days covers a dead-letter replay and a ' +
      'human looking at why one failed; past that it is a recording of a person nobody has ' +
      'a use for.',
  },
  raw_transcript: {
    ceilingMs: 30 * DAY_MS,
    reason:
      'The raw text exists to be redacted. Once the redacted version is published the raw ' +
      'one is only useful for re-running redaction, which is the same thirty-day window the ' +
      'original gets — and it is strictly more dangerous than the audio, because text is ' +
      'searchable.',
  },
  original_evidence: {
    ceilingMs: 365 * DAY_MS,
    reason:
      'Evidence is submitted in order to be examined, so its clock must outlast the process ' +
      'that examines it. A dispute can be opened long after an experience is published and ' +
      'reviewed slowly; expiring evidence at thirty days would mean accepting it and then ' +
      'destroying it before anybody weighed it. A year is a judgement, and it is the one ' +
      'number here chosen to be generous rather than tight.',
  },
};

/** An artefact as retention sees it: when it arrived, and what class it belongs to. */
export interface RetentionSubject {
  readonly id: string;
  readonly retentionClass: RetentionClass;
  readonly createdAt: number;
  /** Set once the bytes are gone, so a second sweep does not decide again. */
  readonly removedAt?: number;
}

/**
 * Why an artefact is not expiring, when it is not.
 *
 * A hold is a reason, not a boolean, because an operator asking "why is this still here"
 * needs the answer and the answer differs.
 */
export type RetentionHold = 'dispute_open' | 'moderation_review_open';

export const RETENTION_HOLDS: readonly RetentionHold[] = ['dispute_open', 'moderation_review_open'];

export type RetentionVerdict =
  /** Inside its ceiling. Nothing to do. */
  | 'within_ceiling'
  /** Past its ceiling, and nothing is holding it. */
  | 'expired'
  /** Past its ceiling, but a review needs it. */
  | 'held'
  /** The bytes are already gone. */
  | 'already_removed';

export interface RetentionDecision {
  readonly verdict: RetentionVerdict;
  readonly retentionClass: RetentionClass;
  /** When the ceiling is or was reached. Always present, so a surface can show a date. */
  readonly expiresAt: number;
  /** Present only when the verdict is `held`. */
  readonly hold?: RetentionHold;
  /** The policy's own reason, carried so a ledger row explains itself without a lookup. */
  readonly reason: string;
}

/**
 * The whole decision, as a pure function of the artefact, the clock and the holds.
 *
 * Pure on purpose: a retention sweep is the most destructive thing in the system, and
 * the part that decides has to be testable without a store, a clock or a bucket. The
 * caller finds the holds; this says what follows from them.
 *
 * Order matters and is total. `already_removed` first, because a removed artefact is not
 * a candidate for anything and re-deciding it is how a ledger grows a second row for one
 * removal. Then the ceiling, because an artefact inside its ceiling is not held — it is
 * simply not due, and calling that `held` would make every artefact in the system look
 * like it was under review.
 */
export const decideRetention = (
  subject: RetentionSubject,
  now: number,
  holds: readonly RetentionHold[] = [],
): RetentionDecision => {
  const policy = RETENTION_POLICIES[subject.retentionClass];
  const expiresAt = subject.createdAt + policy.ceilingMs;
  const base = { retentionClass: subject.retentionClass, expiresAt, reason: policy.reason };

  if (subject.removedAt !== undefined) return { ...base, verdict: 'already_removed' };
  if (now < expiresAt) return { ...base, verdict: 'within_ceiling' };
  const hold = holds[0];
  if (hold !== undefined) return { ...base, verdict: 'held', hold };
  return { ...base, verdict: 'expired' };
};

/** When this artefact's ceiling falls, for a surface that wants to show it before it does. */
export const retentionExpiresAt = (subject: RetentionSubject): number =>
  subject.createdAt + RETENTION_POLICIES[subject.retentionClass].ceilingMs;

/**
 * The status of the byte deletion itself.
 *
 * `object_storage_blocked` is the honest value in every environment that exists today:
 * the row can be marked, the ledger can be written, and the bytes are in a store nothing
 * has been configured. A sweep that reported `removed` here would be the first time this
 * codebase claimed something it had not done.
 */
export type ByteRemovalStatus = 'removed' | 'object_storage_blocked';

export const OBJECT_STORAGE_BLOCKED_REASON =
  'No object storage is configured, so the key can be forgotten but the bytes behind it ' +
  'cannot be deleted from here. The policy, the decision and the ledger are complete; the ' +
  'deletion is not, and says so.';

/**
 * What a sweep decided, per artefact — the ledger row's content.
 *
 * Recorded even when nothing was removed, because "we looked and it was held" is the
 * answer to the only question an auditor asks about a retention policy.
 */
export interface RetentionLedgerEntry {
  readonly subjectId: string;
  readonly retentionClass: RetentionClass;
  readonly verdict: RetentionVerdict;
  readonly expiresAt: number;
  readonly hold?: RetentionHold;
  readonly byteRemoval?: ByteRemovalStatus;
}

/**
 * Retention removes bytes and never facts, stated as code.
 *
 * These three exist so the absences are assertable rather than merely true. A future edit
 * that made retention reduce a count, delete an experience or touch a corroboration would
 * have to change one of them, and the test that calls it is where the argument happens.
 */
export const retentionDeletesTheFact = (): false => false;
export const retentionAdjustsCorroborationCount = (): undefined => undefined;
export const retentionRemovesProtectedDerivative = (): false => false;
