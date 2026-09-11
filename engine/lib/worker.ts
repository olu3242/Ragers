import type { Engine } from '../src/engine.ts';

/**
 * The orchestrator drain loop.
 *
 * Commands persist events transactionally, but something has to deliver them.
 * In a single-node deployment that is this in-process loop; at scale it is the
 * same `drain` call run by a separate worker process (`npm run worker`) so the
 * request path and the delivery path scale independently.
 *
 * Guarded to one loop per process: a second call is a no-op rather than a
 * second competing consumer.
 */
const RUNNING = Symbol.for('ragers.orchestrator.worker');

interface WorkerHandle {
  stop(): void;
}

const registry = globalThis as unknown as Record<symbol, WorkerHandle | undefined>;

export const startOrchestratorWorker = (
  engine: Engine,
  options: { intervalMs?: number } = {},
): WorkerHandle => {
  const existing = registry[RUNNING];
  if (existing) return existing;

  const intervalMs = options.intervalMs ?? 250;
  let stopped = false;
  let draining = false;

  const tick = async (): Promise<void> => {
    // Never overlap drains: at-least-once delivery plus concurrent drains would
    // multiply redundant consumer work for no benefit.
    if (draining || stopped) return;
    draining = true;
    try {
      await engine.orchestrator.drain();
    } catch (cause) {
      engine.logger.error('worker.drain_failed', {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      draining = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Do not hold the process open on the loop alone.
  if (typeof timer.unref === 'function') timer.unref();

  const handle: WorkerHandle = {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      registry[RUNNING] = undefined;
    },
  };
  registry[RUNNING] = handle;
  return handle;
};
