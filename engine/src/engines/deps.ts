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
  /**
   * Whether `identity.authenticate` may issue a session from an email address alone.
   *
   * **This exists because it found a real hole.** `identity.authenticate` took `{ email }`,
   * looked the actor up and issued a session — no password, no token, no magic link — and
   * `/api/session` exposes that path to anybody. So knowing a moderator's or an admin's email
   * address was enough to become them.
   *
   * The proper fix is a credential mechanism (a verified magic-link token, or a password with a
   * hash column) and it is a product decision with its own migration and its own provider. What
   * this flag does in the meantime is make the hole **impossible to deploy by accident**: the
   * default is `false`, the engine refuses, and a development or test environment has to say so
   * out loud — the same pattern as the `RAGERS_TEST_SEED` fixture route.
   *
   * It lives in the engine config rather than in the route on purpose. A check in
   * `app/api/session/route.ts` would be a control enforced at a surface, which is exactly what
   * Phase 94 argues is not a control: a second caller reaching the bus directly would bypass it.
   */
  readonly allowPasswordlessSignIn: boolean;
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
  // **Default deny.** See the field's own comment: no credential mechanism exists yet, so
  // sign-in is refused unless an environment explicitly opts in for development.
  allowPasswordlessSignIn: false,
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
  /**
   * Run a write so that it survives a rollback of the command's transaction.
   *
   * **For writes whose entire purpose is to record that a refusal happened.** The bus runs a
   * handler inside a transaction and rolls it back when the handler returns an error, which is
   * right: a refused command must not leave half a state change behind. A failed-sign-in counter is
   * the exception that proves it — roll that back and the backoff counts to zero forever, so a
   * password can be guessed without limit.
   *
   * Pass-through with the in-memory adapters, because there is no transaction to escape. That is
   * also why the defect it fixes was invisible: the counter incremented in every test and existed
   * only in memory.
   *
   * Deliberately narrow, and it should stay so. Anything reached through here is outside the
   * command's atomicity guarantee, so it must be a write that is *correct on its own* — a counter,
   * not half of a state change.
   */
  readonly durably: <T>(work: () => Promise<T>) => Promise<T>;
}
