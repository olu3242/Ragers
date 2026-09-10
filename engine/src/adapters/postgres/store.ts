import { createPostgresTable, type TableDescriptor } from './table.ts';
import type { Db } from './client.ts';
import type { EngineStore } from '../../ports/store.ts';

/**
 * Descriptors for every relation. Only genuine exceptions are declared: field
 * names otherwise convert by snake_case, so adding a column needs no entry here.
 *
 * Several projections are keyed by the aggregate they project rather than by a
 * surrogate id — `feed_entries.experience_id`, `actor_reputation.actor_id` — so
 * their domain `id` is derived on read rather than stored twice.
 */
const descriptor = <T extends { readonly id: string }>(d: TableDescriptor<T>): TableDescriptor<T> => d;

export const createPostgresStore = (db: Db): EngineStore => {
  const table = <T extends { readonly id: string }>(d: TableDescriptor<T>) => createPostgresTable<T>(db, d);

  return {
    actors: table(descriptor({ relation: 'actors', idColumn: 'id' })),
    aliases: table(descriptor({ relation: 'aliases', idColumn: 'id' })),
    sessions: table(descriptor({ relation: 'sessions', idColumn: 'id' })),
    experiences: table(descriptor({ relation: 'experiences', idColumn: 'id' })),
    mediaAssets: table(descriptor({ relation: 'media_assets', idColumn: 'id' })),
    uploadTargets: table(descriptor({ relation: 'upload_targets', idColumn: 'id' })),
    transcripts: table(descriptor({ relation: 'transcripts', idColumn: 'id' })),
    replies: table(descriptor({ relation: 'replies', idColumn: 'id' })),
    reactions: table(descriptor({ relation: 'reactions', idColumn: 'id' })),
    fairVotes: table(descriptor({ relation: 'fair_votes', idColumn: 'id' })),

    // Keyed by the experience they belong to.
    counters: table(
      descriptor({
        relation: 'experience_counters',
        idColumn: 'experience_id',
        derivedId: (row) => String(row['experienceId'] ?? ''),
      }),
    ),
    feedEntries: table(
      descriptor({
        relation: 'feed_entries',
        idColumn: 'experience_id',
        derivedId: (row) => String(row['experienceId'] ?? ''),
      }),
    ),
    searchDocuments: table(
      descriptor({
        relation: 'search_documents',
        idColumn: 'experience_id',
        derivedId: (row) => String(row['experienceId'] ?? ''),
      }),
    ),
    rankingInputs: table(
      descriptor({
        relation: 'ranking_inputs',
        idColumn: 'experience_id',
        derivedId: (row) => String(row['experienceId'] ?? ''),
      }),
    ),
    reputation: table(
      descriptor({
        relation: 'actor_reputation',
        idColumn: 'actor_id',
        derivedId: (row) => String(row['actorId'] ?? ''),
      }),
    ),

    reports: table(descriptor({ relation: 'reports', idColumn: 'id' })),
    queueItems: table(descriptor({ relation: 'moderation_queue', idColumn: 'id' })),
    moderationActions: table(descriptor({ relation: 'moderation_actions', idColumn: 'id' })),
    screenings: table(descriptor({ relation: 'screenings', idColumn: 'id' })),
    subjects: table(descriptor({ relation: 'subjects', idColumn: 'id' })),
    experienceSubjects: table(descriptor({ relation: 'experience_subjects', idColumn: 'id' })),
    graphEdges: table(descriptor({ relation: 'graph_edges', idColumn: 'id' })),
    notifications: table(descriptor({ relation: 'notifications', idColumn: 'id' })),
    notificationPreferences: table(descriptor({ relation: 'notification_preferences', idColumn: 'id' })),

    // `window` is reserved in Postgres, so the column is window_span.
    trends: table(descriptor({ relation: 'trends', idColumn: 'id', overrides: { window: 'window_span' } })),
    metricSnapshots: table(
      descriptor({ relation: 'metric_snapshots', idColumn: 'id', overrides: { window: 'window_span' } }),
    ),

    deletionRequests: table(descriptor({ relation: 'deletion_requests', idColumn: 'id' })),
    exportRequests: table(descriptor({ relation: 'export_requests', idColumn: 'id' })),
    auditEvents: table(descriptor({ relation: 'audit_events', idColumn: 'id' })),
    roleAssignments: table(descriptor({ relation: 'role_assignments', idColumn: 'id' })),
    analyticsEvents: table(descriptor({ relation: 'analytics_events', idColumn: 'id' })),

    // ── Experience Signal Engine ──────────────────────────────────────────
    categories: table(descriptor({ relation: 'categories', idColumn: 'id' })),
    issueTypes: table(descriptor({ relation: 'issue_types', idColumn: 'id' })),
    entities: table(descriptor({ relation: 'entities', idColumn: 'id' })),
    entityAliases: table(descriptor({ relation: 'entity_aliases', idColumn: 'id' })),
    locations: table(descriptor({ relation: 'locations', idColumn: 'id' })),
    corroborations: table(descriptor({ relation: 'experience_corroborations', idColumn: 'id' })),
    shares: table(descriptor({ relation: 'experience_shares', idColumn: 'id' })),
    clusters: table(descriptor({ relation: 'experience_clusters', idColumn: 'id' })),
    clusterMembers: table(descriptor({ relation: 'experience_cluster_members', idColumn: 'id' })),
    evidence: table(descriptor({ relation: 'evidence', idColumn: 'id' })),
    evidenceAssessments: table(descriptor({ relation: 'evidence_assessments', idColumn: 'id' })),
    resolutionReports: table(descriptor({ relation: 'resolution_reports', idColumn: 'id' })),
    resolutionEvents: table(descriptor({ relation: 'resolution_events', idColumn: 'id' })),
    organizationProfiles: table(descriptor({ relation: 'organization_profiles', idColumn: 'id' })),
    organizationMemberships: table(descriptor({ relation: 'organization_memberships', idColumn: 'id' })),
    organizationResponses: table(descriptor({ relation: 'organization_responses', idColumn: 'id' })),
    riskEvents: table(descriptor({ relation: 'risk_events', idColumn: 'id' })),
    moderationCases: table(descriptor({ relation: 'moderation_cases', idColumn: 'id' })),
    signalSnapshots: table(descriptor({ relation: 'signal_snapshots', idColumn: 'id' })),
    disputes: table(descriptor({ relation: 'experience_disputes', idColumn: 'id' })),
    relations: table(descriptor({ relation: 'experience_relations', idColumn: 'id' })),
    proposals: table(descriptor({ relation: 'intelligence_proposals', idColumn: 'id' })),
    enrichments: table(descriptor({ relation: 'experience_enrichments', idColumn: 'id' })),
    severities: table(descriptor({ relation: 'experience_severities', idColumn: 'id' })),
    escalations: table(descriptor({ relation: 'experience_escalations', idColumn: 'id' })),
    organizationCases: table(descriptor({ relation: 'organization_cases', idColumn: 'id' })),
    handoffs: table(descriptor({ relation: 'intelligence_handoffs', idColumn: 'id' })),
    priorities: table(descriptor({ relation: 'experience_priorities', idColumn: 'id' })),
    agentRuns: table(descriptor({ relation: 'agent_runs', idColumn: 'id' })),
    subscriptions: table(descriptor({ relation: 'integration_subscriptions', idColumn: 'id' })),
    deliveries: table(descriptor({ relation: 'integration_deliveries', idColumn: 'id' })),
    recommendations: table(descriptor({ relation: 'recommendations', idColumn: 'id' })),
    actionPlans: table(descriptor({ relation: 'action_plans', idColumn: 'id' })),
    actionPlanSteps: table(descriptor({ relation: 'action_plan_steps', idColumn: 'id' })),
    quotaWindows: table(descriptor({ relation: 'quota_windows', idColumn: 'id' })),
    retentionSweeps: table(descriptor({ relation: 'retention_sweeps', idColumn: 'id' })),
    watches: table(descriptor({ relation: 'experience_watches', idColumn: 'id' })),
    // Keyed by the organization it describes: one plan per organization.
    entitlements: table(
      descriptor({
        relation: 'organization_entitlements',
        idColumn: 'organization_id',
        derivedId: (row) => String(row['organizationId'] ?? ''),
      }),
    ),
    // Keyed by the organization it describes.
    responsiveness: table(
      descriptor({
        relation: 'responsiveness_snapshots',
        idColumn: 'organization_id',
        derivedId: (row) => String(row['organizationId'] ?? ''),
      }),
    ),
    // Keyed by the experience they describe.
    experienceMetadata: table(
      descriptor({
        relation: 'experience_metadata',
        idColumn: 'experience_id',
        derivedId: (row) => String(row['experienceId'] ?? ''),
      }),
    ),
    // Keyed by actor.
    trustAssessments: table(
      descriptor({
        relation: 'trust_assessments',
        idColumn: 'actor_id',
        derivedId: (row) => String(row['actorId'] ?? ''),
      }),
    ),
  };
};
