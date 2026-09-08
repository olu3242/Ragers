import { err, ok, type Result } from './result.ts';
import { internalError, unauthorizedError, type EngineError } from './errors.ts';
import type { ActorContext, Authorizer, PolicyAction, ResourceRef } from './authz.ts';
import type { IdempotencyStore } from './idempotency.ts';
import type { NewDomainEvent, Outbox } from './outbox.ts';
import type { Clock } from './clock.ts';
import type { IdFactory } from './ids.ts';
import type { Logger } from './logger.ts';
import type { Metrics } from './metrics.ts';

export interface CommandEnvelope<TInput> {
  readonly name: string;
  readonly input: TInput;
  readonly actor: ActorContext;
  /** Required. Absent idempotency is a programming error, not a default. */
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

export interface HandlerOutcome<TOutput> {
  readonly value: TOutput;
  readonly events?: readonly NewDomainEvent[];
}

export interface CommandContext {
  readonly actor: ActorContext;
  readonly correlationId: string;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly logger: Logger;
}

export interface CommandHandler<TInput, TOutput> {
  readonly name: string;
  readonly action: PolicyAction;
  /**
   * Resolve the resource being acted on, so ownership and status can be
   * authorized before any domain transition runs. Returning a not-found error
   * here keeps existence checks ahead of the policy gate.
   */
  resolveResource(input: TInput, ctx: CommandContext): Promise<Result<ResourceRef, EngineError>>;
  handle(input: TInput, ctx: CommandContext): Promise<Result<HandlerOutcome<TOutput>, EngineError>>;
}

export interface CommandBusDeps {
  readonly authorizer: Authorizer;
  readonly idempotency: IdempotencyStore;
  readonly outbox: Outbox;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

export interface CommandBus {
  register<TInput, TOutput>(handler: CommandHandler<TInput, TOutput>): void;
  dispatch<TInput, TOutput>(envelope: CommandEnvelope<TInput>): Promise<Result<TOutput, EngineError>>;
  registeredCommands(): readonly string[];
}

/**
 * The single write path. Order is fixed and not negotiable:
 *   idempotency → resolve → authorize → domain transition → persist+outbox → complete.
 * Handlers are held privately, so no caller can skip the authorize step by
 * invoking a handler directly.
 */
export const createCommandBus = (deps: CommandBusDeps): CommandBus => {
  const handlers = new Map<string, CommandHandler<unknown, unknown>>();

  const dispatch = async <TInput, TOutput>(
    envelope: CommandEnvelope<TInput>,
  ): Promise<Result<TOutput, EngineError>> => {
    const started = deps.clock.now();
    const handler = handlers.get(envelope.name) as CommandHandler<TInput, TOutput> | undefined;
    if (!handler) {
      return err(internalError('command_not_registered', `No handler for command ${envelope.name}`));
    }

    const correlationId = envelope.correlationId ?? deps.ids.next('corr');
    const logger = deps.logger.child({ command: envelope.name, correlationId, actorId: envelope.actor.actorId });
    const ctx: CommandContext = {
      actor: envelope.actor,
      correlationId,
      clock: deps.clock,
      ids: deps.ids,
      logger,
    };

    // 1. Idempotency — a replay returns the first outcome, never a second effect.
    const reservation = await deps.idempotency.reserve(
      envelope.idempotencyKey,
      envelope.actor.actorId,
      envelope.name,
    );
    if (reservation.status === 'replayed') {
      deps.metrics.increment('command.replayed', { command: envelope.name });
      const record = reservation.record;
      if (record.error) return err(record.error);
      return ok(record.response as TOutput);
    }
    if (reservation.status === 'in_flight') {
      deps.metrics.increment('command.in_flight', { command: envelope.name });
      return err(
        unauthorizedError('command_in_flight', 'A command with this idempotency key is already running'),
      );
    }

    const finishErr = async (error: EngineError): Promise<Result<TOutput, EngineError>> => {
      // Rejections are recorded so a replay is stable, except transient ones,
      // which must remain retryable under the same key.
      if (error.retryable) await deps.idempotency.release(envelope.idempotencyKey);
      else await deps.idempotency.fail(envelope.idempotencyKey, error);
      deps.metrics.increment('command.failed', { command: envelope.name, kind: error.kind });
      logger.warn('command.failed', { code: error.code, kind: error.kind });
      return err(error);
    };

    try {
      // 2. Resolve the target resource.
      const resolved = await handler.resolveResource(envelope.input, ctx);
      if (!resolved.ok) return await finishErr(resolved.error);

      // 3. Authorize. Deny by default.
      const decision = deps.authorizer.authorize(envelope.actor, handler.action, resolved.value);
      if (!decision.allowed) {
        deps.metrics.increment('policy.denied', { action: handler.action, code: decision.code });
        return await finishErr(unauthorizedError(decision.code, decision.reason, { action: handler.action }));
      }

      // 4. Domain transition.
      const outcome = await handler.handle(envelope.input, ctx);
      if (!outcome.ok) return await finishErr(outcome.error);

      // 5. Persist domain events transactionally with the state change.
      const events = outcome.value.events ?? [];
      if (events.length > 0) await deps.outbox.append(events, correlationId);

      // 6. Complete idempotency.
      await deps.idempotency.complete(envelope.idempotencyKey, outcome.value.value);

      deps.metrics.increment('command.succeeded', { command: envelope.name });
      deps.metrics.observe('command.duration_ms', deps.clock.now() - started, { command: envelope.name });
      logger.info('command.succeeded', { events: events.length });
      return ok(outcome.value.value);
    } catch (cause) {
      const error = internalError('command_threw', `Command ${envelope.name} threw`, {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
      await deps.idempotency.fail(envelope.idempotencyKey, error);
      deps.metrics.increment('command.threw', { command: envelope.name });
      logger.error('command.threw', { code: error.code });
      return err(error);
    }
  };

  return {
    register: <TInput, TOutput>(handler: CommandHandler<TInput, TOutput>) => {
      if (handlers.has(handler.name)) throw new Error(`Duplicate command handler: ${handler.name}`);
      handlers.set(handler.name, handler as unknown as CommandHandler<unknown, unknown>);
    },
    dispatch,
    registeredCommands: () => [...handlers.keys()].sort(),
  };
};
