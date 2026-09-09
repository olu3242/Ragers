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
  };
};
