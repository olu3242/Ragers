import { createEngine, type Engine, type EngineOptions } from '../../src/engine.ts';
import { fixedClock, type FixedClock } from '../../src/runtime/clock.ts';
import { sequentialIdFactory } from '../../src/runtime/ids.ts';
import { createMemoryLogger, type MemoryLogger } from '../../src/runtime/logger.ts';
import { expect } from '../../src/runtime/result.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { AuthResult } from '../../src/engines/identity.engine.ts';

export interface EngineHarness {
  readonly engine: Engine;
  readonly clock: FixedClock;
  readonly logger: MemoryLogger;
  /** Register an actor and return its authenticated context. */
  signUp(email: string, displayName?: string): Promise<{ actor: ActorContext; auth: AuthResult }>;
  /** Promote an actor to a role, as the governance engine would. */
  promote(actorId: string, role: 'moderator' | 'admin'): Promise<ActorContext>;
  /** Run every queued consumer to completion. */
  settle(): Promise<void>;
  nextKey(): string;
}

export const createEngineHarness = (options: Omit<EngineOptions, 'clock' | 'ids' | 'logger'> = {}): EngineHarness => {
  const clock = fixedClock();
  const ids = sequentialIdFactory();
  const logger = createMemoryLogger();
  const engine = createEngine({ ...options, clock, ids, logger });

  let keyCounter = 0;
  const nextKey = (): string => {
    keyCounter += 1;
    return `idem-${keyCounter}`;
  };

  const signUp = async (email: string, displayName = 'Test Actor') => {
    const result = await engine.bus.dispatch<unknown, AuthResult>({
      name: 'identity.register',
      input: { email, displayName },
      actor: { actorId: 'guest', role: 'guest', authenticated: false },
      idempotencyKey: nextKey(),
    });
    const auth = expect(result, `sign up ${email}`);
    return {
      auth,
      actor: {
        actorId: auth.actorId,
        role: auth.role,
        authenticated: true,
        sessionId: auth.sessionId,
      } satisfies ActorContext,
    };
  };

  const promote = async (actorId: string, role: 'moderator' | 'admin'): Promise<ActorContext> => {
    const actor = await engine.store.actors.get(actorId);
    if (!actor) throw new Error(`no such actor ${actorId}`);
    await engine.store.actors.put({ ...actor, role });
    return { actorId, role, authenticated: true, sessionId: 'sess-promoted' };
  };

  const settle = async (): Promise<void> => {
    for (let round = 0; round < 12; round += 1) {
      const report = await engine.orchestrator.drain();
      if (report.claimed === 0) break;
      // Only advance time when something is actually backing off, so settling a
      // healthy pipeline does not consume time-based windows under test.
      if (report.retried > 0) clock.advance(120_000);
    }
  };

  return { engine, clock, logger, signUp, promote, settle, nextKey };
};
