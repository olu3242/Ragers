import process from 'node:process';
import { createEngine } from '../src/engine.ts';
import { startOrchestratorWorker } from '../lib/worker.ts';

/**
 * Standalone delivery worker, for deployments that scale the request path and
 * the delivery path separately. Run the web tier with RAGERS_DISABLE_WORKER=1
 * so exactly one process drains.
 */
const engine = createEngine();
const worker = startOrchestratorWorker(engine, { intervalMs: 250 });

engine.logger.info('worker.started', {});

const shutdown = (signal: string): void => {
  engine.logger.info('worker.stopping', { signal });
  worker.stop();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Keep the process alive; the drain timer is unref'd by design.
setInterval(() => {}, 1 << 30);
