import { createCommandBus, type Transactional } from './runtime/bus.ts';
import { createQuotaGuard } from './runtime/quota.ts';
import { createOrchestrator } from './runtime/orchestrator.ts';
import { createHealthRegistry } from './runtime/health.ts';
import { createWatchErasureConsumer, registerWatchEngine } from './engines/watch.engine.ts';
import { createConfidencePointConsumer } from './engines/confidence.engine.ts';
import { registerControlEngine } from './engines/control.engine.ts';
import { createWatchNotificationConsumer } from './engines/notification.engine.ts';
import { createMetrics } from './runtime/metrics.ts';
import { createRetryPolicy } from './runtime/retry.ts';
import { systemClock, type Clock } from './runtime/clock.ts';
import { uuidIdFactory, type IdFactory } from './runtime/ids.ts';
import { createConsoleLogger, type Logger } from './runtime/logger.ts';
import { createAuthorizer } from './policy/policy.ts';
import { createMemoryStore } from './adapters/memory/store.ts';
import {
  createMemoryDeadLetterStore,
  createMemoryDeliveryLedger,
  createMemoryIdempotencyStore,
  createMemoryJobHistory,
  createMemoryOutbox,
  createMemoryWorkerRegistry,
} from './adapters/memory/runtime-stores.ts';
import {
  createDeterministicAssistanceProvider,
  createFakeObjectStore,
  createFakePiiDetector,
  createFakeTranscriptionProvider,
} from './adapters/fakes.ts';
import { createPostgresStore } from './adapters/postgres/store.ts';
import {
  createPostgresDeadLetterStore,
  createPostgresDeliveryLedger,
  createPostgresIdempotencyStore,
  createPostgresJobHistory,
  createPostgresOutbox,
  createPostgresWorkerRegistry,
} from './adapters/postgres/runtime-stores.ts';
import { outsideTransaction, type Db } from './adapters/postgres/client.ts';
import { defaultConfig, type EngineConfig, type EngineDeps, type EngineProviders } from './engines/deps.ts';
import { registerIdentityEngine } from './engines/identity.engine.ts';
import { registerExperienceEngine } from './engines/experience.engine.ts';
import {
  createMediaFailedConsumer,
  createMediaReadyConsumer,
  registerVoiceEngine,
} from './engines/voice.engine.ts';
import {
  createMediaProtectionConsumer,
  createTranscriptRedactionConsumer,
} from './engines/privacy.engine.ts';
import { createTranscriptionConsumer } from './engines/voiceintel.engine.ts';
import { createScreeningConsumer, registerSafetyEngine } from './engines/safety.engine.ts';
import {
  createFeedProjectionConsumer,
  createFeedPurgeConsumer,
  createFeedSuppressionConsumer,
} from './engines/feed.engine.ts';
import { createCounterProjectionConsumer, registerReactionEngine } from './engines/reaction.engine.ts';
import { createSearchIndexConsumer, createSearchPurgeConsumer } from './engines/search.engine.ts';
import {
  createSubjectExtractionConsumer,
  createSubjectPurgeConsumer,
} from './engines/subject.engine.ts';
import { createBlockApplicationConsumer, registerGraphEngine } from './engines/graph.engine.ts';
import {
  createNotificationFanOutConsumer,
  registerNotificationEngine,
} from './engines/notification.engine.ts';
import { createReputationConsumer } from './engines/reputation.engine.ts';
import { createRankingConsumer } from './engines/ranking.engine.ts';
import {
  createDeletionPropagationConsumer,
  createExportConsumer,
  registerCreatorEngine,
} from './engines/creator.engine.ts';
import { registerGovernanceEngine } from './engines/governance.engine.ts';
import { createAnalyticsIngestConsumer } from './engines/analytics.engine.ts';
import { createExtractionConsumer, registerNormalizationEngine } from './engines/normalization.engine.ts';
import {
  createClusterAssignmentConsumer,
  createClusterCounterConsumer,
} from './engines/matching.engine.ts';
import { createSignalSnapshotConsumer } from './engines/signal.engine.ts';
import { registerEvidenceEngine } from './engines/evidence.engine.ts';
import { createSignalStatusConsumer, registerResolutionEngine } from './engines/resolution.engine.ts';
import { registerOrganizationEngine } from './engines/organization.engine.ts';
import { registerDisputeEngine } from './engines/dispute.engine.ts';
import { registerRelationEngine } from './engines/relation.engine.ts';
import { registerProposalEngine } from './engines/proposal.engine.ts';
import { registerEnrichmentEngine } from './engines/enrichment.engine.ts';
import { registerCaseEngine } from './engines/case.engine.ts';
import { createSeverityConsumer } from './engines/severity.engine.ts';
import { createEscalationConsumer } from './engines/escalation.engine.ts';
import { createHandoffConsumer } from './engines/handoff.engine.ts';
import { createRecommendationErasureConsumer } from './engines/conclusion.engine.ts';
import { createPriorityConsumer } from './engines/priority.engine.ts';
import { createDeliveryConsumer, registerIntegrationEngine } from './engines/integration.engine.ts';
import { createResponsivenessConsumer } from './engines/responsiveness.engine.ts';
import {
  createAbuseDetectionConsumer,
  createTrustRecomputeConsumer,
} from './engines/trust.engine.ts';
import {
  createCorroborationCounterConsumer,
  registerCorroborationEngine,
} from './engines/corroboration.engine.ts';
import { createReplyCascadeConsumer, registerConversationEngine } from './engines/conversation.engine.ts';
import type { EngineStore } from './ports/store.ts';
import type { HealthRegistry } from './runtime/health.ts';
import type { JobHistory, WorkerRegistry } from './runtime/jobs.ts';
import type { DeliveryLedger } from './runtime/orchestrator.ts';

export interface EngineOptions {
  readonly store?: EngineStore;
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  readonly logger?: Logger;
  readonly providers?: Partial<EngineProviders>;
  readonly config?: Partial<EngineConfig>;
  readonly retry?: { maxAttempts?: number; baseMs?: number; factor?: number; maxMs?: number };
  /**
   * Phase 61 throttling. On by default.
   *
   * Turned off only by suites that dispatch at a volume no person produces — the
   * command-boundary sweep sends every command eleven malformed payloads as three
   * actors, which is thousands of requests and legitimately exceeds every quota. A
   * suite testing refusals should be refused for the reason it is testing.
   */
  readonly throttle?: boolean;
  /** Identity of this worker, so two processes can be distinguished. */
  readonly workerId?: string;
  readonly leaseMs?: number;
  readonly maxConcurrent?: number;
  /**
   * When supplied, every store — domain and runtime — is backed by Postgres.
   * This is the difference between a preview process and a deployment: without
   * it, state lives in the process and a restart starts from nothing.
   */
  readonly db?: Db;
}

export interface Engine extends EngineDeps {
  readonly health: HealthRegistry;
  readonly workers: WorkerRegistry;
  readonly jobHistory: JobHistory;
  readonly deliveries: DeliveryLedger;
}

/**
 * Composition root. Wiring lives here and nowhere else, so an engine module
 * never reaches for a concrete adapter.
 */
export const createEngine = (options: EngineOptions = {}): Engine => {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? uuidIdFactory;
  const logger = options.logger ?? createConsoleLogger({ service: 'ragers-engine' });
  const metrics = createMetrics();
  const store = options.store ?? (options.db ? createPostgresStore(options.db) : createMemoryStore());
  const authorizer = createAuthorizer();
  const retry = createRetryPolicy(options.retry ?? { maxAttempts: 3, baseMs: 1_000, factor: 2 });

  // Durable when a database is supplied, in-process otherwise. The engines never
  // see the difference: they only ever hold the ports.
  const db = options.db;
  const idempotency = db ? createPostgresIdempotencyStore(db) : createMemoryIdempotencyStore(clock);
  const outbox = db ? createPostgresOutbox(db, clock, ids) : createMemoryOutbox(clock, ids);
  const deadLetters = db ? createPostgresDeadLetterStore(db, clock, ids) : createMemoryDeadLetterStore(clock, ids);
  const deliveries = db ? createPostgresDeliveryLedger(db, ids) : createMemoryDeliveryLedger();
  const workers = db ? createPostgresWorkerRegistry(db) : createMemoryWorkerRegistry();
  const jobHistory = db ? createPostgresJobHistory(db, ids) : createMemoryJobHistory();

  // With a database, a command's rows and its events commit together. Without
  // one there is nothing to fall out of step with, so the pass-through stands.
  const transaction: Transactional | undefined = db
    ? (work) => db.transaction(async () => work())
    : undefined;

  /**
   * The escape from that transaction, for writes that have to outlive a refusal.
   *
   * Pass-through without a database, because there is no transaction to leave.
   */
  const durably = db ? outsideTransaction : <T>(work: () => Promise<T>): Promise<T> => work();

  // Phase 61. Wired here rather than defaulted inside the bus, because a bus that
  // constructed its own throttle would make every unit test subject to one — and
  // because the store it counts in is the composition root's business, not the bus's.
  const quota =
    options.throttle === false ? undefined : createQuotaGuard({ windows: store.quotaWindows, clock });

  const bus = createCommandBus({
    authorizer,
    idempotency,
    outbox,
    clock,
    ids,
    logger,
    metrics,
    ...(quota === undefined ? {} : { quota }),
    ...(transaction === undefined ? {} : { transaction }),
  });
  const orchestrator = createOrchestrator({
    outbox,
    deliveries,
    deadLetters,
    retry,
    clock,
    ids,
    logger,
    metrics,
    workers,
    history: jobHistory,
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
    ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
  });

  const providers: EngineProviders = {
    transcription: options.providers?.transcription ?? createFakeTranscriptionProvider(),
    pii: options.providers?.pii ?? createFakePiiDetector(),
    objectStore: options.providers?.objectStore ?? createFakeObjectStore(),
    // Phase 44: the deterministic provider is the *default*, not a test double. With no
    // model configured the Copilot still works — modestly, and honestly, reporting
    // `live: false` so the harness knows live-provider behaviour is untested.
    assistance: options.providers?.assistance ?? createDeterministicAssistanceProvider(),
    // Optional and deliberately undefaulted: with no transport a delivery stays pending and
    // is retried, rather than being marked sent against a fake that always succeeds.
    ...(options.providers?.webhookTransport === undefined
      ? {}
      : { webhookTransport: options.providers.webhookTransport }),
  };

  const deps: EngineDeps = {
    store,
    bus,
    orchestrator,
    outbox,
    deadLetters,
    authorizer,
    retry,
    clock,
    ids,
    logger,
    metrics,
    providers,
    config: { ...defaultConfig, ...(options.config ?? {}) },
    durably,
  };

  // Commands
  registerIdentityEngine(deps);
  registerExperienceEngine(deps);
  registerVoiceEngine(deps);
  registerSafetyEngine(deps);
  registerReactionEngine(deps);
  registerConversationEngine(deps);
  registerGraphEngine(deps);
  // Phase 78 — watching a thing. Separate from the social graph on purpose: a follow between
  // people raises a mutual-visibility question a watch does not.
  registerWatchEngine(deps);
  // Phase 94: the six operator controls. Governed commands like everything else, so a kill
  // switch is not the one unaudited action in a codebase whose audit rule exists to prevent that.
  registerControlEngine(deps);
  registerNotificationEngine(deps);
  registerCreatorEngine(deps);
  registerGovernanceEngine(deps);
  registerCorroborationEngine(deps);
  registerNormalizationEngine(deps);
  registerEvidenceEngine(deps);
  registerResolutionEngine(deps);
  registerOrganizationEngine(deps);
  registerDisputeEngine(deps);
  registerRelationEngine(deps);
  registerProposalEngine(deps);
  registerEnrichmentEngine(deps);
  registerCaseEngine(deps);
  registerIntegrationEngine(deps);

  // Consumers, in dependency order: protect -> ready/transcribe -> screen -> project
  orchestrator.subscribe(createMediaProtectionConsumer(deps));
  orchestrator.subscribe(createMediaReadyConsumer(deps));
  orchestrator.subscribe(createMediaFailedConsumer(deps));
  orchestrator.subscribe(createTranscriptionConsumer(deps));
  orchestrator.subscribe(createTranscriptRedactionConsumer(deps));
  orchestrator.subscribe(createScreeningConsumer(deps));
  orchestrator.subscribe(createFeedProjectionConsumer(deps));
  orchestrator.subscribe(createFeedSuppressionConsumer(deps));
  orchestrator.subscribe(createFeedPurgeConsumer(deps));
  orchestrator.subscribe(createCounterProjectionConsumer(deps));
  orchestrator.subscribe(createReplyCascadeConsumer(deps));
  orchestrator.subscribe(createSubjectExtractionConsumer(deps));
  orchestrator.subscribe(createSubjectPurgeConsumer(deps));
  orchestrator.subscribe(createSearchIndexConsumer(deps));
  orchestrator.subscribe(createSearchPurgeConsumer(deps));
  orchestrator.subscribe(createBlockApplicationConsumer(deps));
  orchestrator.subscribe(createNotificationFanOutConsumer(deps));
  orchestrator.subscribe(createReputationConsumer(deps));
  orchestrator.subscribe(createRankingConsumer(deps));
  orchestrator.subscribe(createDeletionPropagationConsumer(deps));
  orchestrator.subscribe(createExportConsumer(deps));
  orchestrator.subscribe(createAnalyticsIngestConsumer(deps));
  orchestrator.subscribe(createCorroborationCounterConsumer(deps));
  // Experience Signal Engine intelligence: extract -> cluster -> measure, then
  // trust over the durable facts all three produce.
  orchestrator.subscribe(createExtractionConsumer(deps));
  orchestrator.subscribe(createClusterAssignmentConsumer(deps));
  orchestrator.subscribe(createClusterCounterConsumer(deps));
  orchestrator.subscribe(createSignalSnapshotConsumer(deps));
  orchestrator.subscribe(createTrustRecomputeConsumer(deps));
  orchestrator.subscribe(createAbuseDetectionConsumer(deps));
  // Phases 32 and 34: classify from what people asserted, then escalate on the
  // classification and on time passing. Escalation is subscribed after severity so a
  // single enrichment produces a band before the rules read one.
  orchestrator.subscribe(createSeverityConsumer(deps));
  orchestrator.subscribe(createEscalationConsumer(deps));
  // Phase 40: governed state is handed to the intelligence layer last, so it can only
  // ever propose over measurements the phases above it have already made governed.
  // Phases 41–43: urgency and impact feed priority, so the priority consumer runs after
  // severity and escalation have written the inputs it reads.
  orchestrator.subscribe(createPriorityConsumer(deps));
  orchestrator.subscribe(createHandoffConsumer(deps));
  // Phase 64: a deleted experience stops being cited by the recommendation ledger.
  orchestrator.subscribe(createRecommendationErasureConsumer(deps));
  // Phase 49: outbound delivery is a consumer over the same outbox, so a webhook inherits
  // the leased-job runtime's retries and dead-letter queue rather than getting its own.
  orchestrator.subscribe(createDeliveryConsumer(deps));
  // Phase 78: a deleted experience takes its watches with it. There is no foreign key to
  // cascade — `target_id` points at one of two tables — so this is a consumer.
  orchestrator.subscribe(createWatchErasureConsumer(deps));
  // Phase 79: the watchers of a thing are told when its *outcome* changes. The first
  // notification whose recipient is not the author, which is what made the pipeline's
  // authorization stage a live check.
  orchestrator.subscribe(createWatchNotificationConsumer(deps));
  // Phase 82: the confidence series, written on the four events that can move it. Not
  // `ExperienceShared`, which the corroboration consumer also listens for — a share is not a
  // claim, and subscribing to it here would have been the quiet way to let amplification move
  // a trust figure.
  orchestrator.subscribe(createConfidencePointConsumer(deps));
  orchestrator.subscribe(createSignalStatusConsumer(deps));
  orchestrator.subscribe(createResponsivenessConsumer(deps));

  const health = createHealthRegistry(clock);
  health.register({
    name: 'outbox',
    check: async () => {
      const pending = await outbox.pendingCount();
      if (pending > 1_000) return { state: 'degraded', detail: `${pending} events pending` };
      return { state: 'healthy' };
    },
  });
  if (db) {
    health.register({
      name: 'database',
      check: async () => {
        try {
          await db.query('select 1');
          return { state: 'healthy' };
        } catch (cause) {
          return {
            state: 'unhealthy',
            detail: cause instanceof Error ? cause.message : 'database unreachable',
          };
        }
      },
    });
  }
  health.register({
    name: 'dead_letters',
    check: async () => {
      const count = (await deadLetters.list()).length;
      return count === 0 ? { state: 'healthy' } : { state: 'degraded', detail: `${count} dead-lettered` };
    },
  });

  return { ...deps, health, workers, jobHistory, deliveries };
};
