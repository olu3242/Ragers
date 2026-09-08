import { createAuthorizer } from '../../src/policy/policy.ts';
import { fixedClock, type FixedClock } from '../../src/runtime/clock.ts';
import { sequentialIdFactory } from '../../src/runtime/ids.ts';
import { createMemoryLogger, type MemoryLogger } from '../../src/runtime/logger.ts';
import { createMetrics, type Metrics } from '../../src/runtime/metrics.ts';
import { createRetryPolicy, type RetryPolicy, type RetryPolicyOptions } from '../../src/runtime/retry.ts';
import { createCommandBus, type CommandBus } from '../../src/runtime/bus.ts';
import { createOrchestrator, type Orchestrator } from '../../src/runtime/orchestrator.ts';
import type { Authorizer } from '../../src/runtime/authz.ts';
import type { IdempotencyStore } from '../../src/runtime/idempotency.ts';
import type { Outbox } from '../../src/runtime/outbox.ts';
import type { DeadLetterStore } from '../../src/runtime/deadletter.ts';
import type { DeliveryLedger } from '../../src/runtime/orchestrator.ts';
import {
  createMemoryDeadLetterStore,
  createMemoryDeliveryLedger,
  createMemoryIdempotencyStore,
  createMemoryOutbox,
} from '../../src/adapters/memory/runtime-stores.ts';

export interface RuntimeHarness {
  readonly clock: FixedClock;
  readonly ids: ReturnType<typeof sequentialIdFactory>;
  readonly logger: MemoryLogger;
  readonly metrics: Metrics;
  readonly authorizer: Authorizer;
  readonly idempotency: IdempotencyStore;
  readonly outbox: Outbox;
  readonly deadLetters: DeadLetterStore;
  readonly deliveries: DeliveryLedger;
  readonly retry: RetryPolicy;
  readonly bus: CommandBus;
  readonly orchestrator: Orchestrator;
}

export const createRuntimeHarness = (options: { retry?: RetryPolicyOptions } = {}): RuntimeHarness => {
  const clock = fixedClock();
  const ids = sequentialIdFactory();
  const logger = createMemoryLogger();
  const metrics = createMetrics();
  const authorizer = createAuthorizer();
  const idempotency = createMemoryIdempotencyStore(clock);
  const outbox = createMemoryOutbox(clock, ids);
  const deadLetters = createMemoryDeadLetterStore(clock, ids);
  const deliveries = createMemoryDeliveryLedger();
  const retry = createRetryPolicy(options.retry ?? { maxAttempts: 3, baseMs: 1_000, factor: 2 });

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

  return {
    clock,
    ids,
    logger,
    metrics,
    authorizer,
    idempotency,
    outbox,
    deadLetters,
    deliveries,
    retry,
    bus,
    orchestrator,
  };
};

export const member = (actorId = 'actor_0001') => ({
  actorId,
  role: 'member' as const,
  authenticated: true,
  sessionId: 'sess_0001',
});

export const moderator = (actorId = 'actor_mod') => ({
  actorId,
  role: 'moderator' as const,
  authenticated: true,
  sessionId: 'sess_mod',
});

export const admin = (actorId = 'actor_admin') => ({
  actorId,
  role: 'admin' as const,
  authenticated: true,
  sessionId: 'sess_admin',
});

export const guest = () => ({ actorId: 'guest', role: 'guest' as const, authenticated: false });
