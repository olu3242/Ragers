import process from 'node:process';
import { createEngine } from '../src/engine.ts';
import { startOrchestratorWorker } from '../lib/worker.ts';
import { configuredDb } from '../lib/engine-store.ts';

/**
 * Standalone delivery worker, for deployments that scale the request path and
 * the delivery path separately. Run the web tier with RAGERS_DISABLE_WORKER=1
 * so exactly one process drains.
 */
// The same decision as the web tier, from the same function. If these two disagreed about which
// database they hold, the worker would drain its own empty outbox while the web tier's filled up —
// which is precisely what happened while both called `createEngine()` with no arguments.
//
// It deliberately does not pass `allowPasswordlessSignIn`: the worker dispatches no sign-in, so
// the permissive development setting has no business reaching this process at all.
const db = configuredDb();
const engine = createEngine(db === undefined ? {} : { db });
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
