import type { Clock } from '../runtime/clock.ts';
import type { IdFactory } from '../runtime/ids.ts';
import type { Logger } from '../runtime/logger.ts';
import type { Metrics } from '../runtime/metrics.ts';
import type { CommandBus } from '../runtime/bus.ts';
import type { Orchestrator } from '../runtime/orchestrator.ts';
import type { Outbox } from '../runtime/outbox.ts';
import type { DeadLetterStore } from '../runtime/deadletter.ts';
import type { Authorizer } from '../runtime/authz.ts';
import type { RetryPolicy } from '../runtime/retry.ts';
import type { EngineStore } from '../ports/store.ts';
import type {
  AssistanceProvider,
  ObjectStore,
  PiiDetector,
  TranscriptionProvider,
  WebhookTransport,
} from '../ports/providers.ts';

export interface EngineConfig {
  /** Window in which an author may still edit a published experience. */
  readonly editWindowMs: number;
  /** Minimum volume before a trend is shown at all. */
  readonly trendMinVolume: number;
  /** Salt for analytics pseudonymisation. */
  readonly analyticsSalt: string;
  /** Target share of Raves used by the balance adjustment. */
  readonly targetRaveShare: number;
}

export const defaultConfig: EngineConfig = {
  editWindowMs: 15 * 60 * 1_000,
  trendMinVolume: 3,
  analyticsSalt: 'ragers-analytics-v1',
  targetRaveShare: 0.5,
};

export interface EngineProviders {
  readonly transcription: TranscriptionProvider;
  readonly pii: PiiDetector;
  readonly objectStore: ObjectStore;
  /**
   * Phase 44. Defaults to the deterministic provider, which reports `live: false` — so the
   * Copilot works modestly rather than being absent, and the harness can tell that
   * live-provider behaviour is untested rather than passing.
   */
  readonly assistance: AssistanceProvider;
  /**
   * Phase 49. Optional: with none configured a delivery stays pending and is retried rather
   * than being marked sent, so the audit trail never claims something that did not happen.
   */
  readonly webhookTransport?: WebhookTransport;
}

export interface EngineDeps {
  readonly store: EngineStore;
  readonly bus: CommandBus;
  readonly orchestrator: Orchestrator;
  readonly outbox: Outbox;
  readonly deadLetters: DeadLetterStore;
  readonly authorizer: Authorizer;
  readonly retry: RetryPolicy;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly providers: EngineProviders;
  readonly config: EngineConfig;
}
