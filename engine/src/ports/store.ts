import type { Experience } from '../domain/experience.ts';
import type { Actor, Alias, Session } from '../domain/identity.ts';
import type { MediaAsset, UploadTarget } from '../domain/voice.ts';
import type {
  CreationMode,
  ExperienceKind,
  ModerationActionKind,
  ReactionType,
  ReportReason,
  Visibility,
} from '../domain/types.ts';
import type { WorkState } from '../runtime/work.ts';
import type { Role } from '../runtime/authz.ts';

/**
 * A minimal table port. Every persistence adapter implements the same shape, so
 * the in-memory adapter used by tests and the Postgres adapter used in
 * production are interchangeable without touching an engine.
 */
export interface Table<T extends { readonly id: string }> {
  get(id: string): Promise<T | undefined>;
  put(row: T): Promise<void>;
  remove(id: string): Promise<void>;
  all(): Promise<readonly T[]>;
  find(predicate: (row: T) => boolean): Promise<readonly T[]>;
  findOne(predicate: (row: T) => boolean): Promise<T | undefined>;
  count(predicate?: (row: T) => boolean): Promise<number>;
}

// ── P5 Feed ───────────────────────────────────────────────────────────────
/**
 * Feed projection row. No actorId: the feed cannot leak an author even if a
 * projection is written incorrectly, because there is no column to leak.
 */
export interface FeedEntry {
  readonly id: string;
  readonly experienceId: string;
  readonly kind: ExperienceKind;
  readonly creationMode: CreationMode;
  readonly category: string;
  readonly excerpt: string;
  readonly identityLabel: string;
  readonly identityKind: Visibility;
  readonly hasVoice: boolean;
  readonly durationMs?: number;
  readonly publishedAt: number;
  readonly rankScore: number;
  readonly suppressed: boolean;
}

// ── P6 Engagement ─────────────────────────────────────────────────────────
export interface Reaction {
  readonly id: string;
  readonly experienceId: string;
  readonly actorId: string;
  readonly reactionType: ReactionType;
  readonly createdAt: number;
}

export interface FairVote {
  readonly id: string;
  readonly experienceId: string;
  readonly actorId: string;
  readonly isFair: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ExperienceCounters {
  readonly id: string;
  readonly experienceId: string;
  readonly beenThere: number;
  readonly same: number;
  readonly fairPoint: number;
  readonly disagree: number;
  readonly fairYes: number;
  readonly fairNo: number;
  readonly replyCount: number;
}

// ── P7 Conversation ───────────────────────────────────────────────────────
export interface Reply {
  readonly id: string;
  readonly experienceId: string;
  readonly parentReplyId?: string;
  readonly actorId: string;
  readonly creationMode: CreationMode;
  readonly bodyText: string;
  readonly visibility: Visibility;
  readonly aliasId?: string;
  readonly mediaAssetId?: string;
  readonly status: 'draft' | 'pending_media' | 'pending_moderation' | 'published' | 'hidden' | 'removed' | 'deleted';
  readonly depth: number;
  readonly createdAt: number;
}

export const MAX_REPLY_DEPTH = 4;

// ── P8 Voice intelligence ─────────────────────────────────────────────────
export interface Transcript {
  readonly id: string;
  readonly mediaAssetId: string;
  /** Internal only. Never returned by any read path. */
  readonly rawText?: string;
  /** Public-facing. Present only once redaction has run. */
  readonly redactedText?: string;
  readonly language?: string;
  readonly confidence?: number;
  readonly processingStatus: WorkState;
  readonly attemptCount: number;
  readonly failureReason?: string;
  readonly provider: string;
  readonly redactionFindings?: Readonly<Record<string, number>>;
  readonly createdAt: number;
}

// ── P9 Trust & safety ─────────────────────────────────────────────────────
export type TargetType = 'experience' | 'reply';

export interface Report {
  readonly id: string;
  readonly targetType: TargetType;
  readonly targetId: string;
  readonly reporterActorId: string;
  readonly reasonCode: ReportReason;
  readonly status: 'open' | 'reviewed' | 'closed';
  readonly createdAt: number;
}

export interface QueueItem {
  readonly id: string;
  readonly targetType: TargetType;
  readonly targetId: string;
  readonly priority: number;
  readonly state: 'queued' | 'claimed' | 'actioned' | 'released';
  readonly claimedBy?: string;
  readonly claimedAt?: number;
  readonly createdAt: number;
}

export interface ModerationAction {
  readonly id: string;
  readonly targetType: TargetType;
  readonly targetId: string;
  readonly moderatorId: string;
  readonly action: ModerationActionKind;
  readonly reason: string;
  readonly correlationId: string;
  readonly createdAt: number;
}

export interface ScreeningResult {
  readonly id: string;
  readonly targetType: TargetType;
  readonly targetId: string;
  readonly outcome: 'clear' | 'needs_review';
  readonly signals: readonly string[];
  readonly createdAt: number;
}

// ── P11 Search ────────────────────────────────────────────────────────────
/** Search document. No actorId and no raw transcript, by construction. */
export interface SearchDocument {
  readonly id: string;
  readonly experienceId: string;
  readonly kind: ExperienceKind;
  readonly category: string;
  /** Redacted text only. */
  readonly searchableText: string;
  readonly subjectTerms: readonly string[];
  readonly identityLabel: string;
  readonly hasVoice: boolean;
  readonly publishedAt: number;
}

// ── P12 Subject graph ─────────────────────────────────────────────────────
export interface Subject {
  readonly id: string;
  readonly canonicalTerm: string;
  readonly kind: 'behavior' | 'context' | 'place_type';
  readonly parentSubjectId?: string;
  readonly experienceCount: number;
  readonly state: 'candidate' | 'canonical' | 'merged' | 'retired';
  readonly mergedIntoId?: string;
}

export interface ExperienceSubject {
  readonly id: string;
  readonly experienceId: string;
  readonly subjectId: string;
  readonly weight: number;
  readonly source: 'category' | 'extracted';
}

// ── P13 Social graph ──────────────────────────────────────────────────────
export type GraphTargetRef = 'actor' | 'alias';

export interface GraphEdge {
  readonly id: string;
  readonly kind: 'follow' | 'block' | 'mute';
  readonly actorId: string;
  readonly targetRef: GraphTargetRef;
  readonly targetId: string;
  readonly createdAt: number;
}

// ── P14 Notifications ─────────────────────────────────────────────────────
export type NotificationKind =
  | 'reaction_received'
  | 'fair_vote_received'
  | 'reply_received'
  | 'moderation_outcome';

export interface Notification {
  readonly id: string;
  readonly recipientActorId: string;
  readonly kind: NotificationKind;
  readonly subjectRef: TargetType;
  readonly subjectId: string;
  readonly actorLabel: string;
  readonly dedupeKey: string;
  readonly state: 'pending' | 'delivered' | 'read' | 'suppressed';
  readonly suppressionReason?: string;
  readonly createdAt: number;
  readonly readAt?: number;
}

export interface NotificationPreference {
  readonly id: string;
  readonly actorId: string;
  readonly kind: NotificationKind;
  readonly enabled: boolean;
}

// ── P15 Reputation ────────────────────────────────────────────────────────
export type Standing = 'new' | 'established' | 'trusted' | 'limited';

export interface ActorReputation {
  readonly id: string;
  readonly actorId: string;
  readonly experiencesPublished: number;
  readonly fairYesReceived: number;
  readonly fairNoReceived: number;
  readonly approvalRate: number;
  readonly removalsReceived: number;
  readonly standing: Standing;
  /** Moderator/admin only. Never in a public projection. */
  readonly internalSignals: Readonly<Record<string, number>>;
  readonly updatedAt: number;
}

// ── P16 Ranking & trends ──────────────────────────────────────────────────
export interface RankingInput {
  readonly id: string;
  readonly experienceId: string;
  readonly engagementScore: number;
  readonly fairnessScore: number;
  readonly recencyDecay: number;
  readonly balanceAdjustment: number;
  readonly finalScore: number;
  readonly computedAt: number;
}

export type TrendWindow = '1h' | '24h' | '7d';

export interface Trend {
  readonly id: string;
  readonly subjectId: string;
  readonly window: TrendWindow;
  readonly kind: ExperienceKind;
  readonly volume: number;
  readonly velocity: number;
  readonly state: 'emerging' | 'trending' | 'cooling' | 'expired';
  readonly computedAt: number;
}

// ── P17 Creator control ───────────────────────────────────────────────────
export type PropagationSurface =
  | 'feed'
  | 'search'
  | 'subjects'
  | 'notifications'
  | 'replies'
  | 'media'
  | 'transcripts'
  | 'counters';

export const PROPAGATION_SURFACES: readonly PropagationSurface[] = [
  'feed',
  'search',
  'subjects',
  'notifications',
  'replies',
  'media',
  'transcripts',
  'counters',
];

export interface DeletionRequest {
  readonly id: string;
  readonly actorId: string;
  readonly targetType: TargetType;
  readonly targetId: string;
  readonly state: 'requested' | 'propagating' | 'completed' | 'partially_failed';
  readonly propagation: Readonly<Record<PropagationSurface, boolean>>;
  readonly createdAt: number;
  readonly completedAt?: number;
}

export interface ExportRequest {
  readonly id: string;
  readonly actorId: string;
  readonly state: WorkState;
  readonly artifactKey?: string;
  readonly createdAt: number;
}

// ── P18 Governance ────────────────────────────────────────────────────────
export interface AuditEvent {
  readonly id: string;
  readonly actorId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly before?: Readonly<Record<string, unknown>>;
  readonly after?: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
  readonly createdAt: number;
}

export interface RoleAssignment {
  readonly id: string;
  readonly actorId: string;
  readonly role: Role;
  readonly grantedBy: string;
  readonly grantedAt: number;
  readonly revokedAt?: number;
}

// ── P19 Analytics ─────────────────────────────────────────────────────────
/** Analytics rows carry a pseudonymous hash, never an actorId, and no content. */
export interface AnalyticsEvent {
  readonly id: string;
  readonly eventName: string;
  readonly actorHash: string;
  readonly properties: Readonly<Record<string, string | number | boolean>>;
  readonly correlationId: string;
  readonly occurredAt: number;
}

export interface MetricSnapshot {
  readonly id: string;
  readonly metricName: string;
  readonly window: string;
  readonly value: number;
  readonly computedAt: number;
}

/** The full persistence surface of the engine. */
export interface EngineStore {
  readonly actors: Table<Actor>;
  readonly aliases: Table<Alias>;
  readonly sessions: Table<Session>;
  readonly experiences: Table<Experience>;
  readonly mediaAssets: Table<MediaAsset>;
  readonly uploadTargets: Table<UploadTarget>;
  readonly transcripts: Table<Transcript>;
  readonly replies: Table<Reply>;
  readonly reactions: Table<Reaction>;
  readonly fairVotes: Table<FairVote>;
  readonly counters: Table<ExperienceCounters>;
  readonly feedEntries: Table<FeedEntry>;
  readonly reports: Table<Report>;
  readonly queueItems: Table<QueueItem>;
  readonly moderationActions: Table<ModerationAction>;
  readonly screenings: Table<ScreeningResult>;
  readonly searchDocuments: Table<SearchDocument>;
  readonly subjects: Table<Subject>;
  readonly experienceSubjects: Table<ExperienceSubject>;
  readonly graphEdges: Table<GraphEdge>;
  readonly notifications: Table<Notification>;
  readonly notificationPreferences: Table<NotificationPreference>;
  readonly reputation: Table<ActorReputation>;
  readonly rankingInputs: Table<RankingInput>;
  readonly trends: Table<Trend>;
  readonly deletionRequests: Table<DeletionRequest>;
  readonly exportRequests: Table<ExportRequest>;
  readonly auditEvents: Table<AuditEvent>;
  readonly roleAssignments: Table<RoleAssignment>;
  readonly analyticsEvents: Table<AnalyticsEvent>;
  readonly metricSnapshots: Table<MetricSnapshot>;
}
