import type { WorkState } from './work.ts';

/**
 * Transactional outbox. Domain events are written in the same transaction as
 * the state change, then delivered at-least-once, in `sequence` order per
 * aggregate. Consumers must therefore be idempotent.
 */
export interface DomainEventEnvelope {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly eventName: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Groups every event caused by one command. */
  readonly correlationId: string;
  /** The event that caused this one, so a chain can be walked backwards. */
  readonly causationId?: string;
  readonly occurredAt: number;
}

export interface OutboxRecord extends DomainEventEnvelope {
  readonly state: WorkState;
  readonly attemptCount: number;
  readonly nextAttemptAt: number;
  readonly lastError?: string;
  readonly deliveredAt?: number;
}

export interface NewDomainEvent {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventName: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Set when this event is emitted while handling another one. */
  readonly causationId?: string;
}

export interface Outbox {
  /** Append events for one aggregate, assigning monotonic sequence numbers. */
  append(events: readonly NewDomainEvent[], correlationId: string): Promise<readonly OutboxRecord[]>;
  /** Claim due, undelivered events in per-aggregate sequence order. */
  claimDue(limit: number): Promise<readonly OutboxRecord[]>;
  markDelivered(id: string): Promise<void>;
  markFailed(id: string, error: string, nextAttemptAt: number): Promise<void>;
  markDeadLettered(id: string, error: string): Promise<void>;
  all(): Promise<readonly OutboxRecord[]>;
  pendingCount(): Promise<number>;
}
