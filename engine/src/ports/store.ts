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
import type { QuotaWindow } from '../domain/quota.ts';
import type {
  ByteRemovalStatus,
  RetentionClass,
  RetentionHold,
  RetentionVerdict,
} from '../domain/retention.ts';
import type { Role } from '../runtime/authz.ts';
import type { Corroboration, ExperienceShare } from '../domain/corroboration.ts';
import type { ResolutionEvent, ResolutionReport } from '../domain/resolution.ts';
import type { ExperienceEnrichment } from '../domain/enrichment.ts';
import type { OrganizationCase } from '../domain/case.ts';
import type { SeverityBand } from '../domain/severity.ts';
import type { UrgencyLevel } from '../domain/urgency.ts';
import type { EntitledFeature, PlanTier } from '../domain/entitlement.ts';
import type { IntegrationEvent, Subscription } from '../domain/integration.ts';
import type { PriorityBand, DominantFactor } from '../domain/priority.ts';
import type { Dispute } from '../domain/dispute.ts';
import type { ExperienceRelation } from '../domain/relation.ts';
import type { IntelligenceProposal } from '../domain/proposal.ts';

/** Persisted shapes for the ESE domain objects. */
export type CorroborationRow = Corroboration;
export type ShareRow = ExperienceShare;
export type EnrichmentRow = ExperienceEnrichment;
export type OrganizationCaseRow = OrganizationCase;
export type ResolutionReportRow = ResolutionReport;
export type ResolutionEventRow = ResolutionEvent;
export type DisputeRow = Dispute;
export type RelationRow = ExperienceRelation;
export type ProposalRow = IntelligenceProposal;

/**
 * Derived responsiveness, recomputed from rows like every other counter.
 *
 * Named responsiveness, not SLA: no service-level agreement exists, and calling a
 * measurement an SLA would assert a commitment nobody made. `sampleSize` travels
 * with the medians so a figure from two cases cannot read as a track record.
 */
export interface ResponsivenessSnapshot {
  readonly id: string;
  readonly organizationId: string;
  readonly casesTotal: number;
  readonly casesAnswered: number;
  readonly casesConfirmedResolved: number;
  readonly casesOpen: number;
  readonly medianAcknowledgementMs?: number;
  readonly medianFirstResponseMs?: number;
  readonly medianResolutionMs?: number;
  readonly oldestOpenMs?: number;
  readonly responseRate: number;
  readonly resolutionRate: number;
  readonly sampleSize: number;
  readonly computedAt: number;
}

/**
 * Declarative query criteria.
 *
 * A JavaScript predicate cannot be pushed down to SQL, so engines filter with
 * criteria instead: the in-memory adapter evaluates them directly and the
 * Postgres adapter compiles them to a WHERE clause. `tests/unit/ports.query.test.ts`
 * asserts no engine module uses the predicate form, so a full-table scan cannot
 * be reintroduced silently.
 */
export type CriterionOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'isTrue'
  | 'isFalse'
  | 'isNull'
  | 'notNull';

export interface Criterion<T> {
  readonly field: keyof T & string;
  readonly op: CriterionOp;
  readonly value?: unknown;
}

export type Criteria<T> = readonly Criterion<T>[];

export interface QueryOptions<T> {
  readonly limit?: number;
  readonly orderBy?: { readonly field: keyof T & string; readonly direction: 'asc' | 'desc' };
}

/** Convenience builder for the common single-equality case. */
export const eq = <T>(field: keyof T & string, value: unknown): Criterion<T> => ({ field, op: 'eq', value });

/**
 * "This column has no value."
 *
 * Provided because the alternative at call sites is `query([])` followed by a filter
 * in JavaScript — a full-table scan that silently truncates at the row limit. A
 * predicate that belongs in SQL should reach SQL.
 */
export const ne = <T>(field: keyof T & string, value: unknown): Criterion<T> => ({ field, op: 'ne', value });

export const isNull = <T>(field: keyof T & string): Criterion<T> => ({ field, op: 'isNull' });

export const notNull = <T>(field: keyof T & string): Criterion<T> => ({ field, op: 'notNull' });

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

  /**
   * Compare-and-set: the port's only mutual-exclusion primitive.
   *
   * Writes `row` only when what is currently stored under its id satisfies
   * `expected` — `'absent'` requires that no row exists at all — and returns
   * whether the write happened. `put` is an upsert and so cannot tell the winner
   * of a race from the losers; this can, which is what an invariant like "one
   * corroboration per person per experience" needs when eight requests arrive at
   * once. Callers must therefore key the row on its natural key, not on a fresh
   * id per attempt, or there is nothing to collide on.
   */
  compareAndSet(row: T, expected: 'absent' | Criteria<T>): Promise<boolean>;

  /** Declarative, adapter-translatable filtering. Engines use these three. */
  query(criteria: Criteria<T>, options?: QueryOptions<T>): Promise<readonly T[]>;
  queryOne(criteria: Criteria<T>): Promise<T | undefined>;
  countWhere(criteria: Criteria<T>): Promise<number>;

  /**
   * Predicate filtering. Retained for test convenience only: the Postgres
   * adapter has to fetch the table to evaluate a JavaScript predicate, so
   * engine code must use `query` instead.
   */
  find(predicate: (row: T) => boolean): Promise<readonly T[]>;
  findOne(predicate: (row: T) => boolean): Promise<T | undefined>;
  count(predicate?: (row: T) => boolean): Promise<number>;
}

/** Evaluate one criterion against a row. Shared by the in-memory adapter and tests. */
export const matchesCriterion = <T>(row: T, criterion: Criterion<T>): boolean => {
  const actual = (row as Record<string, unknown>)[criterion.field];
  switch (criterion.op) {
    case 'eq':
      return actual === criterion.value;
    case 'ne':
      return actual !== criterion.value;
    case 'gt':
      return typeof actual === 'number' && actual > (criterion.value as number);
    case 'gte':
      return typeof actual === 'number' && actual >= (criterion.value as number);
    case 'lt':
      return typeof actual === 'number' && actual < (criterion.value as number);
    case 'lte':
      return typeof actual === 'number' && actual <= (criterion.value as number);
    case 'in':
      return Array.isArray(criterion.value) && criterion.value.includes(actual);
    case 'isTrue':
      return actual === true;
    case 'isFalse':
      return actual === false;
    case 'isNull':
      return actual === undefined || actual === null;
    case 'notNull':
      return actual !== undefined && actual !== null;
  }
};

export const matchesCriteria = <T>(row: T, criteria: Criteria<T>): boolean =>
  criteria.every((criterion) => matchesCriterion(row, criterion));

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
  /**
   * Retired: "been there" meant "this happened to me too", which is now a
   * corroboration. Retained for the migration window so existing rows read.
   */
  readonly beenThere: number;
  readonly same: number;
  readonly fairPoint: number;
  readonly disagree: number;
  readonly fairYes: number;
  readonly fairNo: number;
  readonly replyCount: number;
  /** Corroborations — claims, not reactions. */
  readonly reRageCount?: number;
  readonly reRaveCount?: number;
  readonly corroboratorCount?: number;
  /** Amplification. Never a claim. */
  readonly shareCount?: number;
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
  /** Phase 65 — the raw text's removal record. Strictly more dangerous than the audio. */
  readonly rawRemovedAt?: number;
  readonly rawRemovalReason?: string;
  readonly rawByteRemoval?: 'removed' | 'object_storage_blocked';
}

// ── P9 Trust & safety ─────────────────────────────────────────────────────
export type TargetType = 'experience' | 'reply';
export const TARGET_TYPES: readonly TargetType[] = ['experience', 'reply'];
export const isTargetType = (value: unknown): value is TargetType =>
  typeof value === 'string' && (TARGET_TYPES as readonly string[]).includes(value);

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

/**
 * Enumerated as data, not only as a type, because a preference row is keyed on the
 * kind: an unchecked string let one caller write an unbounded number of preference
 * rows, each one silencing nothing.
 */
export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'reaction_received',
  'fair_vote_received',
  'reply_received',
  'moderation_outcome',
];

export const isNotificationKind = (value: unknown): value is NotificationKind =>
  typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value);

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


// ── Experience Signal Engine ──────────────────────────────────────────────
/**
 * Taxonomy. Promoted from the validated string vocabulary so matching and
 * clustering have joinable, aliasable records to work with.
 */
export interface Category {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface IssueType {
  readonly id: string;
  readonly categoryId: string;
  readonly name: string;
  readonly slug: string;
  readonly appliesTo?: ExperienceKind;
}

/** What an experience was *with*. Deliberately never a person. */
export interface Entity {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly kind: 'organization' | 'service' | 'product' | 'venue' | 'platform';
  readonly claimedAt?: number;
}

export interface EntityAlias {
  readonly id: string;
  readonly entityId: string;
  readonly alias: string;
}

/** Coarse by design: a precise location is an identifying detail. */
export interface Location {
  readonly id: string;
  readonly label: string;
  readonly region?: string;
  readonly countryCode?: string;
}

/**
 * Extraction and confirmation are separate columns, and publication reads the
 * confirmed one. This is what stops an AI suggestion silently becoming the
 * user's claim.
 */
export interface ExperienceMetadata {
  readonly id: string;
  readonly experienceId: string;
  readonly extracted: Readonly<Record<string, unknown>>;
  readonly confirmed: Readonly<Record<string, unknown>>;
  readonly extractionSource: 'none' | 'text' | 'voice';
  readonly confirmedAt?: number;
  readonly confirmedBy?: string;
}

export interface ClusterRow {
  readonly id: string;
  readonly kind: ExperienceKind;
  readonly entityId?: string;
  readonly categoryId?: string;
  readonly issueTypeId?: string;
  readonly headline: string;
  readonly totalExperiences: number;
  readonly corroborations: number;
  readonly uniqueExperiencers: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ClusterMember {
  readonly id: string;
  readonly clusterId: string;
  readonly experienceId: string;
  readonly relationship: string;
  readonly score: number;
  readonly factors: Readonly<Record<string, number>>;
}

export interface EvidenceRow {
  readonly id: string;
  readonly experienceId?: string;
  readonly corroborationId?: string;
  /**
   * A dispute or a resolution report as a parent — Phase 37.
   *
   * The column for `disputeId` has existed since migration 0007, which replaced the
   * one-parent check to admit it; nothing could write it because the port row did not
   * carry the field. `resolutionReportId` is new in 0009. Exactly one parent is set,
   * enforced by the database.
   */
  readonly disputeId?: string;
  readonly resolutionReportId?: string;
  readonly submittedBy: string;
  readonly kind: string;
  /** Internal only, like original media. */
  readonly originalKey: string;
  readonly protectedKey?: string;
  readonly protectionStatus: 'queued' | 'processing' | 'protected' | 'failed' | 'dead_letter';
  readonly byteSize: number;
  readonly mimeType: string;
  readonly contentDigest?: string;
  readonly createdAt: number;
  /**
   * Phase 65 — the original's removal record.
   *
   * Evidence gets the longest ceiling of the three raw classes, because it was submitted
   * in order to be examined and a dispute can be opened long after publication. Expiring
   * it early would mean accepting evidence and destroying it before anybody weighed it.
   */
  readonly originalRemovedAt?: number;
  readonly originalRemovalReason?: string;
  readonly originalByteRemoval?: 'removed' | 'object_storage_blocked';
}

/** An assessment is not a verdict: "consistent" is not "verified". */
export interface EvidenceAssessment {
  readonly id: string;
  readonly evidenceId: string;
  readonly outcome: 'unassessed' | 'consistent' | 'inconclusive' | 'contradicted';
  readonly notes?: string;
  readonly assessedBy?: string;
  readonly createdAt: number;
}

export interface OrganizationProfile {
  readonly id: string;
  readonly entityId: string;
  readonly displayName: string;
  readonly claimedBy?: string;
  readonly claimedAt?: number;
  readonly status: 'unclaimed' | 'pending' | 'claimed' | 'suspended';
}

export interface OrganizationMembership {
  readonly id: string;
  readonly organizationId: string;
  readonly actorId: string;
  readonly role: 'member' | 'admin';
  readonly grantedBy?: string;
  readonly grantedAt: number;
  readonly revokedAt?: number;
}

export interface OrganizationResponse {
  readonly id: string;
  readonly organizationId: string;
  readonly experienceId?: string;
  readonly clusterId?: string;
  readonly authorId: string;
  readonly kind: string;
  readonly body: string;
  readonly isPublic: boolean;
  readonly correlationId: string;
  readonly createdAt: number;
}

/** Internal only. No public trust score is exposed. */
export interface TrustAssessmentRow {
  readonly id: string;
  readonly actorId: string;
  readonly accountConfidence: number;
  readonly contributionConfidence: number;
  readonly evidenceConfidence: number;
  readonly riskFlags: readonly string[];
  readonly updatedAt: number;
}

export interface RiskEvent {
  readonly id: string;
  readonly actorId?: string;
  readonly kind: string;
  readonly severity: 'low' | 'medium' | 'high';
  /** A summary, never the raw content that triggered it. */
  readonly detail: Readonly<Record<string, unknown>>;
  readonly correlationId?: string;
  readonly createdAt: number;
}

export interface ModerationCase {
  readonly id: string;
  readonly targetType: TargetType;
  readonly targetId: string;
  readonly state: 'open' | 'actioned' | 'closed';
  readonly openedBy?: string;
  readonly openedAt: number;
  readonly closedAt?: number;
}

export interface SignalSnapshotRow {
  readonly id: string;
  readonly clusterId?: string;
  readonly experienceId?: string;
  readonly windowSpan: string;
  readonly rageCount: number;
  readonly raveCount: number;
  readonly reRageCount: number;
  readonly reRaveCount: number;
  readonly uniqueExperiencers: number;
  readonly contextSupportedCount: number;
  readonly voiceSupportedCount: number;
  readonly evidenceSupportedCount: number;
  readonly responseRate: number;
  readonly resolutionRate: number;
  readonly medianResolutionMs?: number;
  readonly repeatIncidence: number;
  readonly geographicConcentration: Readonly<Record<string, number>>;
  readonly growthRate: number;
  readonly signalAcceleration: number;
  readonly reopenRate: number;
  readonly computedAt: number;
}

/** The full persistence surface of the engine. */
/**
 * A severity classification, stored so it is auditable rather than recomputed
 * differently by each reader. It records the *basis* alongside the band: a band with
 * no visible basis is a number in disguise.
 */
export interface SeverityRow {
  readonly id: string;
  readonly experienceId: string;
  readonly band: SeverityBand;
  readonly confidence: number;
  readonly basis: readonly string[];
  readonly independentExperiencers: number;
  readonly unassessed: boolean;
  readonly classifiedAt: number;
}

/**
 * An escalation. One row per (experience, rule) by construction — the natural key is
 * the escalation key — so a sweep that runs twice enqueues nothing twice.
 */
export interface EscalationRow {
  readonly id: string;
  readonly experienceId: string;
  readonly ruleId: string;
  readonly because: string;
  readonly queueItemId?: string;
  readonly createdAt: number;
  readonly resolvedAt?: number;
}

/**
 * A record that governed state was offered to the intelligence layer, and which
 * proposal it produced. It holds no recommendation of its own — the proposal lives in
 * `intelligence_proposals`, under the contract that refuses one without traceable
 * evidence.
 */
/**
 * Phase 58 — the fact that a conclusion was already recommended.
 *
 * Keyed on what the conclusion is *about* rather than on when it was drawn, so a sweep
 * over unchanged state collides with itself instead of producing a second copy. The
 * recommendation itself is the proposal; this is the ledger that stops duplicates.
 */
export interface RecommendationRow {
  /** `kind|subject|sorted experience ids`. Deterministic, and the collision point. */
  readonly id: string;
  readonly kind: string;
  readonly subjectId: string;
  readonly acrossExperienceIds: readonly string[];
  readonly distinctPeople: number;
  readonly lifecycleState: string;
  /** Absent when the proposal was refused: noticed, and produced nothing actionable. */
  readonly proposalId?: string;
  readonly createdAt: number;
}

/**
 * Phase 59 — a plan of governed steps, approved once.
 *
 * There is no field here naming an E1–E11 row the plan changed, because a step's effect
 * belongs to the engine that owns it. What is recorded is whether each dispatch happened.
 */
export interface ActionPlanRow {
  readonly id: string;
  readonly proposalId: string;
  readonly subjectId: string;
  /** The reviewer. A plan is attributed to a person, never to the engine. */
  readonly approvedBy: string;
  readonly status: 'pending' | 'completed' | 'partially_completed' | 'failed';
  readonly stepCount: number;
  readonly dispatchedCount: number;
  readonly createdAt: number;
  readonly executedAt?: number;
}

export interface ActionPlanStepRow {
  readonly id: string;
  readonly planId: string;
  readonly stepOrder: number;
  readonly command: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly targetEngine: string;
  readonly dispatched: boolean;
  /** The owning engine's own refusal, verbatim. */
  readonly dispatchError?: string;
  readonly executedAt?: number;
}

/**
 * Phase 61 — one throttle window per (actor, class).
 *
 * Note what is absent: no reason, no severity, no suspicion, no score. A quota is not a
 * judgement, and a row that could carry one would eventually be read as one.
 */
export type QuotaWindowRow = QuotaWindow;

/**
 * Phase 65 — one row per artefact per sweep, including the artefacts nothing happened to.
 *
 * "We looked and it was held" is the answer to the only question anybody asks about a
 * retention policy, and a ledger recording only removals could not give it. The reason is
 * denormalised deliberately: a row read a year from now has to explain itself without
 * depending on what the policy says by then.
 */
export interface RetentionSweepRow {
  readonly id: string;
  readonly sweptAt: number;
  readonly subjectId: string;
  readonly retentionClass: RetentionClass;
  readonly verdict: RetentionVerdict;
  readonly expiresAt: number;
  readonly hold?: RetentionHold;
  readonly byteRemoval?: ByteRemovalStatus;
  readonly reason: string;
}

export interface HandoffRow {
  readonly id: string;
  readonly triggerId: string;
  readonly subjectId: string;
  readonly proposalId?: string;
  readonly createdAt: number;
}

/**
 * Urgency, impact and priority for one experience — Phases 41–43.
 *
 * A cache of a derivation, not a source of truth. There is deliberately no command to
 * write it: a `priority.set` would be a way to move somebody's complaint up or down the
 * queue by hand, and Phase 43's whole claim is that a position is answerable from the
 * rows instead.
 *
 * The named inputs are carried through rather than collapsed into a score, so a reader
 * can see which dimension decided the band.
 */
export interface PriorityRow {
  readonly id: string;
  readonly experienceId: string;
  readonly band: PriorityBand;
  readonly reason: string;
  readonly dominant: readonly string[];
  readonly urgency: UrgencyLevel;
  /** Why it is urgent, in the words a person reads. */
  readonly urgencyFactors: readonly string[];
  readonly severity?: SeverityBand;
  readonly peopleAffected?: number;
  readonly impactKnown: boolean;
  readonly confidence?: number;
  readonly unresolvedDays: number;
  readonly unassessed: boolean;
  readonly computedAt: number;
}

/**
 * One agent run — Phases 44–46.
 *
 * A ledger of what an agent did, including when it *declined* to act. The outcomes matter
 * as much as the proposals: `escalated` means it was not confident enough,
 * `provider_unavailable` means no model answered, and `refused` means it asked for
 * something outside its own declaration. All three are recorded rather than swallowed,
 * because an agent that quietly does nothing is indistinguishable from one that is working.
 */
export interface AgentRunRow {
  readonly id: string;
  readonly agentId: string;
  readonly subjectId: string;
  readonly proposalType: string;
  readonly outcome: string;
  readonly proposalId?: string;
  readonly detail?: string;
  readonly createdAt: number;
}

/**
 * An organization's plan — Phase 48.
 *
 * Note what is absent: no priority boost, no moderation tier, no visibility multiplier. Not
 * set to zero — absent. A field that exists at zero is one edit away from being non-zero,
 * and the integrity layer has no input for entitlement at all, so there is nothing to switch.
 */
export interface EntitlementRow {
  readonly id: string;
  readonly organizationId: string;
  readonly tier: PlanTier;
  readonly features: readonly EntitledFeature[];
  readonly updatedAt: number;
}

export type SubscriptionRow = Subscription & { readonly id: string };

/**
 * One outbound delivery attempt — Phase 49.
 *
 * Keyed on (subscription, outbox event), which is what makes replay safe: at-least-once
 * delivery means the same event *will* be handled twice, and the second handling finds this
 * row and sends nothing.
 */
export interface DeliveryRow {
  readonly id: string;
  readonly subscriptionId: string;
  readonly organizationId: string;
  readonly outboxId: string;
  readonly event: IntegrationEvent;
  readonly signature: string;
  /** The exact bytes signed and sent, so a dispute about a delivery is settleable. */
  readonly body: string;
  readonly state: 'pending' | 'sent' | 'failed';
  readonly attemptCount: number;
  readonly sentAt?: number;
  readonly lastError?: string;
  readonly createdAt: number;
}

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

  // ── Experience Signal Engine ────────────────────────────────────────────
  readonly categories: Table<Category>;
  readonly issueTypes: Table<IssueType>;
  readonly entities: Table<Entity>;
  readonly entityAliases: Table<EntityAlias>;
  readonly locations: Table<Location>;
  readonly experienceMetadata: Table<ExperienceMetadata>;
  readonly corroborations: Table<CorroborationRow>;
  readonly shares: Table<ShareRow>;
  readonly clusters: Table<ClusterRow>;
  readonly clusterMembers: Table<ClusterMember>;
  readonly evidence: Table<EvidenceRow>;
  readonly evidenceAssessments: Table<EvidenceAssessment>;
  readonly resolutionReports: Table<ResolutionReportRow>;
  readonly resolutionEvents: Table<ResolutionEventRow>;
  readonly organizationProfiles: Table<OrganizationProfile>;
  readonly organizationMemberships: Table<OrganizationMembership>;
  readonly organizationResponses: Table<OrganizationResponse>;
  readonly trustAssessments: Table<TrustAssessmentRow>;
  readonly riskEvents: Table<RiskEvent>;
  readonly moderationCases: Table<ModerationCase>;
  readonly signalSnapshots: Table<SignalSnapshotRow>;

  // ── Engine contract gaps: dispute, relate, responsiveness, proposals ────
  readonly disputes: Table<DisputeRow>;
  readonly relations: Table<RelationRow>;
  readonly responsiveness: Table<ResponsivenessSnapshot>;
  readonly proposals: Table<ProposalRow>;

  // ── Phases 31–35: enrichment, severity, escalation, organization cases ──
  readonly enrichments: Table<EnrichmentRow>;
  readonly severities: Table<SeverityRow>;
  readonly escalations: Table<EscalationRow>;
  readonly organizationCases: Table<OrganizationCaseRow>;

  // ── Phase 40: the governed intelligence handoff ledger ──────────────────
  readonly handoffs: Table<HandoffRow>;

  // ── Phases 41–43: urgency, impact and explainable priority ──────────────
  readonly priorities: Table<PriorityRow>;

  // ── Phases 44–46: governed agent runs ───────────────────────────────────
  readonly agentRuns: Table<AgentRunRow>;

  // ── Phases 48–49: entitlements and governed outbound delivery ───────────
  readonly entitlements: Table<EntitlementRow>;
  readonly subscriptions: Table<SubscriptionRow>;
  readonly deliveries: Table<DeliveryRow>;

  // ── Phases 58–59 ─────────────────────────────────────────────────────────
  readonly recommendations: Table<RecommendationRow>;
  readonly actionPlans: Table<ActionPlanRow>;
  readonly actionPlanSteps: Table<ActionPlanStepRow>;

  // ── Phase 61 ─────────────────────────────────────────────────────────────
  readonly quotaWindows: Table<QuotaWindowRow>;

  // ── Phase 65 ─────────────────────────────────────────────────────────────
  readonly retentionSweeps: Table<RetentionSweepRow>;
}
