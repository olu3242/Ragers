/**
 * Shared domain vocabulary.
 *
 * The category list is carried over verbatim from the shipped composer in
 * `app.html` so the preview client and the engine agree without a migration.
 */

/** A Rage is behaviour that should happen less; a Rave, behaviour that should happen more. */
export type ExperienceKind = 'rage' | 'rave';
export const EXPERIENCE_KINDS: readonly ExperienceKind[] = ['rage', 'rave'];

/** Text and voice are creation modes of one aggregate, never separate entities. */
export type CreationMode = 'text' | 'voice';
export const CREATION_MODES: readonly CreationMode[] = ['text', 'voice'];

export type Visibility = 'public' | 'alias' | 'anonymous';
export const VISIBILITIES: readonly Visibility[] = ['public', 'alias', 'anonymous'];

/** Tightening order. Loosening is refused — see P17. */
export const VISIBILITY_STRENGTH: Readonly<Record<Visibility, number>> = {
  public: 0,
  alias: 1,
  anonymous: 2,
};

export type ExperienceStatus =
  | 'draft'
  | 'validating'
  | 'pending_media'
  | 'pending_moderation'
  | 'published'
  | 'under_review'
  | 'hidden'
  | 'removed'
  | 'deleted';

export const EXPERIENCE_STATUSES: readonly ExperienceStatus[] = [
  'draft',
  'validating',
  'pending_media',
  'pending_moderation',
  'published',
  'under_review',
  'hidden',
  'removed',
  'deleted',
];

export const CATEGORIES: readonly string[] = [
  'Everyday courtesy',
  'Driving & transit',
  'Work & school',
  'Shopping & service',
  'Neighborhood',
  'Other',
];

/**
 * Ragers-native reactions: *responses* to a claim.
 *
 * Generic Like / Upvote / Repost is deliberately absent — it is not the
 * engagement loop this product is built on. `been_there` is absent for a
 * different reason: it meant "this happened to me too", which is a claim, not a
 * response, and claims are corroborations now. Keeping both would give the
 * product two "me too" signals with different weights in different tables,
 * which is exactly the conflation the Experience Signal Engine exists to remove.
 */
export type ReactionType = 'same' | 'fair_point' | 'disagree';
export const REACTION_TYPES: readonly ReactionType[] = ['same', 'fair_point', 'disagree'];

/**
 * Mechanics that were shipped and have since been replaced. Kept as data so the
 * boundary can answer a stale client precisely — "use Re-Rage" — rather than
 * with a generic validation failure.
 */
export const RETIRED_REACTION_TYPES: readonly string[] = ['been_there'];

/** Explicitly rejected engagement mechanics, kept as data so the rule is testable. */
export const REJECTED_REACTION_TYPES: readonly string[] = [
  'like',
  'love',
  'upvote',
  'downvote',
  'repost',
  'retweet',
  'share',
  'favorite',
];

export type ReportReason = 'naming_shaming' | 'harassment' | 'spam' | 'other';
export const REPORT_REASONS: readonly ReportReason[] = ['naming_shaming', 'harassment', 'spam', 'other'];

export type ModerationActionKind = 'warn' | 'remove' | 'restore' | 'no_action';

/** Body limits. Voice may carry an empty body; text may not. */
export const BODY_MAX_LENGTH = 280;
export const BODY_MIN_LENGTH = 1;

/** Voice bounds. */
export const VOICE_MIN_DURATION_MS = 1_000;
export const VOICE_MAX_DURATION_MS = 120_000;
export const VOICE_MAX_BYTES = 8 * 1024 * 1024;
export const VOICE_ALLOWED_MIME_TYPES: readonly string[] = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
];

export const isExperienceKind = (value: unknown): value is ExperienceKind =>
  typeof value === 'string' && (EXPERIENCE_KINDS as readonly string[]).includes(value);

export const isCreationMode = (value: unknown): value is CreationMode =>
  typeof value === 'string' && (CREATION_MODES as readonly string[]).includes(value);

export const isVisibility = (value: unknown): value is Visibility =>
  typeof value === 'string' && (VISIBILITIES as readonly string[]).includes(value);

export const isReactionType = (value: unknown): value is ReactionType =>
  typeof value === 'string' && (REACTION_TYPES as readonly string[]).includes(value);

export const MODERATION_ACTION_KINDS: readonly ModerationActionKind[] = [
  'warn',
  'remove',
  'restore',
  'no_action',
];

export const isModerationActionKind = (value: unknown): value is ModerationActionKind =>
  typeof value === 'string' && (MODERATION_ACTION_KINDS as readonly string[]).includes(value);

export const isReportReason = (value: unknown): value is ReportReason =>
  typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value);

/**
 * A decision note — why a case was closed, a proposal rejected, a dispute declined.
 *
 * Three domains take one of these and every one of them had the same two holes: a
 * `note` typed `string | undefined` was trimmed without checking it was a string, so
 * a caller sending a number crashed the handler, and nothing bounded its length, so
 * one command could store an arbitrarily large note. Checked in one place because it
 * is one rule; the caller turns the outcome into its own message, because *why* a
 * note is required differs in each of the three.
 */
export const REVIEW_NOTE_MAX_LENGTH = 2_000;

export type NoteCheck =
  | { readonly ok: true; readonly note: string }
  | { readonly ok: false; readonly code: 'note_not_text' | 'note_too_long' };

export const checkNote = (value: unknown): NoteCheck => {
  if (value === undefined || value === null) return { ok: true, note: '' };
  if (typeof value !== 'string') return { ok: false, code: 'note_not_text' };
  const trimmed = value.trim();
  if (trimmed.length > REVIEW_NOTE_MAX_LENGTH) return { ok: false, code: 'note_too_long' };
  return { ok: true, note: trimmed };
};
