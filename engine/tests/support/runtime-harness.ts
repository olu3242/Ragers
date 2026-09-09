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
  createMemoryJobHistory,
  createMemoryOutbox,
  createMemoryWorkerRegistry,
} from '../../src/adapters/memory/runtime-stores.ts';
import type { JobHistory, WorkerRegistry } from '../../src/runtime/jobs.ts';

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
  readonly workers: WorkerRegistry;
  readonly jobHistory: JobHistory;
}

/**
 * State a second harness can share, so two "workers" can be pointed at one
 * backlog — which is how restart and contention are exercised.
 */
export interface SharedRuntimeState {
  readonly outbox: Outbox;
  readonly deliveries: DeliveryLedger;
  readonly deadLetters: DeadLetterStore;
  readonly workers: WorkerRegistry;
  readonly clock: FixedClock;
}

export const createRuntimeHarness = (
  options: {
    retry?: RetryPolicyOptions;
    shared?: SharedRuntimeState;
    workerId?: string;
    maxConcurrent?: number;
    leaseMs?: number;
  } = {},
): RuntimeHarness => {
  const clock = options.shared?.clock ?? fixedClock();
  const ids = sequentialIdFactory();
  const logger = createMemoryLogger();
  const metrics = createMetrics();
  const authorizer = createAuthorizer();
  const idempotency = createMemoryIdempotencyStore(clock);
  const outbox = options.shared?.outbox ?? createMemoryOutbox(clock, ids);
  const deadLetters = options.shared?.deadLetters ?? createMemoryDeadLetterStore(clock, ids);
  const deliveries = options.shared?.deliveries ?? createMemoryDeliveryLedger();
  const workers = options.shared?.workers ?? createMemoryWorkerRegistry();
  const jobHistory = createMemoryJobHistory();
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
    workers,
    history: jobHistory,
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
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
    workers,
    jobHistory,
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
