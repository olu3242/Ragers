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
 * Ragers-native engagement mechanics. Generic Like / Upvote / Repost is
 * deliberately absent: it is not the engagement loop this product is built on.
 */
export type ReactionType = 'been_there' | 'same' | 'fair_point' | 'disagree';
export const REACTION_TYPES: readonly ReactionType[] = ['been_there', 'same', 'fair_point', 'disagree'];

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
