import { ok } from '../runtime/result.ts';
import { pseudonymize } from '../runtime/ids.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { Role } from '../runtime/authz.ts';
import type { AnalyticsEvent, MetricSnapshot } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * P19 Analytics & Observability Engine.
 *
 * The sink is structurally incapable of holding content or an actor id: it
 * stores a pseudonymous hash and scalar properties only. Ingestion never
 * affects the user-facing command path.
 */

/** Property keys that must never be forwarded to analytics. */
const FORBIDDEN_PROPERTY_KEYS = new Set([
  'bodyText',
  'body_text',
  'body',
  'excerpt',
  'rawText',
  'raw_text',
  'transcript',
  'originalKey',
  'original_key',
  'email',
  'actorId',
  'actor_id',
  'aliasId',
  'alias_id',
  'aliasName',
  'reactorActorId',
  'voterActorId',
  'replierActorId',
]);

const scalarProperties = (payload: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> => {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (FORBIDDEN_PROPERTY_KEYS.has(key)) continue;
    if (key.toLowerCase().endsWith('actorid')) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
};

/** Which event carries which actor reference, for pseudonymisation. */
const originActorOf = (payload: Readonly<Record<string, unknown>>): string | undefined => {
  for (const key of ['reactorActorId', 'voterActorId', 'replierActorId', 'actorId']) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
};

export const createAnalyticsIngestConsumer = (deps: EngineDeps): Consumer => ({
  name: 'analytics.ingest',
  events: [
    'ActorRegistered',
    'ExperiencePublished',
    'ReactionAdded',
    'FairVoteCast',
    'ReplyPublished',
    'ContentRemoved',
    'ExperienceDeleted',
    'VoiceAssetAttached',
    'MediaProtected',
    'TranscriptRedacted',
  ],
  handle: async (event) => {
    const id = `analytics:${event.id}`;
    if (await deps.store.analyticsEvents.get(id)) return ok(undefined); // idempotent

    const origin = originActorOf(event.payload);
    const actorHash = origin
      ? await pseudonymize(origin, deps.config.analyticsSalt)
      : await pseudonymize('system', deps.config.analyticsSalt);

    const row: AnalyticsEvent = {
      id,
      eventName: event.eventName,
      actorHash,
      properties: scalarProperties(event.payload),
      correlationId: event.correlationId,
      occurredAt: event.occurredAt,
    };
    await deps.store.analyticsEvents.put(row);
    // Ingestion failure must never fail the command path, so this consumer
    // always reports success.
    return ok(undefined);
  },
});

export interface MetricsReport {
  readonly activationRate: number;
  readonly contentHealth: number;
  readonly fairnessParticipation: number;
  readonly raveShare: number;
  readonly voiceShare: number;
  readonly computedAt: number;
}

/** The PRD §9 success metrics, computed from durable facts. */
export const computeMetrics = async (deps: EngineDeps): Promise<MetricsReport> => {
  const actors = await deps.store.actors.all();
  const experiences = await deps.store.experiences.all();
  const published = experiences.filter((row) => row.status === 'published');
  const removed = experiences.filter((row) => row.status === 'removed');

  const authors = new Set(published.map((row) => row.actorId));
  const activationRate = actors.length === 0 ? 0 : Number((authors.size / actors.length).toFixed(4));

  const totalDecided = published.length + removed.length;
  const contentHealth = totalDecided === 0 ? 0 : Number((removed.length / totalDecided).toFixed(4));

  let withVotes = 0;
  for (const experience of published) {
    const votes = await deps.store.fairVotes.count((row) => row.experienceId === experience.id);
    if (votes > 0) withVotes += 1;
  }
  const fairnessParticipation = published.length === 0 ? 0 : Number((withVotes / published.length).toFixed(4));

  const raves = published.filter((row) => row.kind === 'rave').length;
  const raveShare = published.length === 0 ? 0 : Number((raves / published.length).toFixed(4));
  const voiceCount = published.filter((row) => row.creationMode === 'voice').length;
  const voiceShare = published.length === 0 ? 0 : Number((voiceCount / published.length).toFixed(4));

  const computedAt = deps.clock.now();
  const snapshots: readonly MetricSnapshot[] = [
    { id: `activation:${computedAt}`, metricName: 'activation_rate', window: 'all', value: activationRate, computedAt },
    { id: `health:${computedAt}`, metricName: 'content_health', window: 'all', value: contentHealth, computedAt },
    {
      id: `fairness:${computedAt}`,
      metricName: 'fairness_participation',
      window: 'all',
      value: fairnessParticipation,
      computedAt,
    },
    { id: `rave:${computedAt}`, metricName: 'rave_share', window: 'all', value: raveShare, computedAt },
    { id: `voice:${computedAt}`, metricName: 'voice_share', window: 'all', value: voiceShare, computedAt },
  ];
  for (const snapshot of snapshots) await deps.store.metricSnapshots.put(snapshot);

  return { activationRate, contentHealth, fairnessParticipation, raveShare, voiceShare, computedAt };
};

export const readAnalytics = async (
  deps: EngineDeps,
  actor: { role: Role },
): Promise<readonly AnalyticsEvent[]> => {
  if (actor.role !== 'admin') return [];
  return deps.store.analyticsEvents.all();
};
