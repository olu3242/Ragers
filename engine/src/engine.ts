import { createCommandBus } from './runtime/bus.ts';
import { createOrchestrator } from './runtime/orchestrator.ts';
import { createHealthRegistry } from './runtime/health.ts';
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
  createMemoryOutbox,
} from './adapters/memory/runtime-stores.ts';
import {
  createFakeObjectStore,
  createFakePiiDetector,
  createFakeTranscriptionProvider,
} from './adapters/fakes.ts';
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
import { createReplyCascadeConsumer, registerConversationEngine } from './engines/conversation.engine.ts';
import type { EngineStore } from './ports/store.ts';
import type { HealthRegistry } from './runtime/health.ts';

export interface EngineOptions {
  readonly store?: EngineStore;
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  readonly logger?: Logger;
  readonly providers?: Partial<EngineProviders>;
  readonly config?: Partial<EngineConfig>;
  readonly retry?: { maxAttempts?: number; baseMs?: number; factor?: number; maxMs?: number };
}

export interface Engine extends EngineDeps {
  readonly health: HealthRegistry;
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
  const store = options.store ?? createMemoryStore();
  const authorizer = createAuthorizer();
  const retry = createRetryPolicy(options.retry ?? { maxAttempts: 3, baseMs: 1_000, factor: 2 });

  const idempotency = createMemoryIdempotencyStore(clock);
  const outbox = createMemoryOutbox(clock, ids);
  const deadLetters = createMemoryDeadLetterStore(clock, ids);
  const deliveries = createMemoryDeliveryLedger();

  const bus = createCommandBus({ authorizer, idempotency, outbox, clock, ids, logger, metrics });
  const orchestrator = createOrchestrator({
    outbox,
    deliveries,
    deadLetters,
    retry,
    clock,
    ids,
    logger,
    metrics,
  });

  const providers: EngineProviders = {
    transcription: options.providers?.transcription ?? createFakeTranscriptionProvider(),
    pii: options.providers?.pii ?? createFakePiiDetector(),
    objectStore: options.providers?.objectStore ?? createFakeObjectStore(),
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
  };

  // Commands
  registerIdentityEngine(deps);
  registerExperienceEngine(deps);
  registerVoiceEngine(deps);
  registerSafetyEngine(deps);
  registerReactionEngine(deps);
  registerConversationEngine(deps);

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

  const health = createHealthRegistry(clock);
  health.register({
    name: 'outbox',
    check: async () => {
      const pending = await outbox.pendingCount();
      if (pending > 1_000) return { state: 'degraded', detail: `${pending} events pending` };
      return { state: 'healthy' };
    },
  });
  health.register({
    name: 'dead_letters',
    check: async () => {
      const count = (await deadLetters.list()).length;
      return count === 0 ? { state: 'healthy' } : { state: 'degraded', detail: `${count} dead-lettered` };
    },
  });

  return { ...deps, health };
};
