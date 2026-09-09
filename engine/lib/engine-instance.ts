import process from 'node:process';
import { createEngine, type Engine } from '../src/engine.ts';
import { startOrchestratorWorker } from './worker.ts';

/**
 * One engine per server process.
 *
 * The instance is held on `globalThis`, not in a module-level binding: Next.js
 * compiles route handlers and pages into separate bundles, each with its own
 * module registry, so a module-level singleton would give the API one engine and
 * the feed page another — and with in-memory adapters they would not see each
 * other's data.
 *
 * That sharing is per *process*. Running more than one node is exactly why a
 * deployment swaps the in-memory adapters for the Postgres/Supabase ones by
 * passing `store` here; no engine module changes, because they only ever see
 * the ports.
 *
 * Creating the engine also starts the drain loop, because an engine whose events
 * are never delivered is not a working engine — nothing would reach the feed.
 * Set RAGERS_DISABLE_WORKER=1 when the drain loop runs as a separate process.
 */
const ENGINE = Symbol.for('ragers.engine.instance');

const registry = globalThis as unknown as Record<symbol, Engine | undefined>;

export const getEngine = (): Engine => {
  let instance = registry[ENGINE];
  if (!instance) {
    instance = createEngine();
    registry[ENGINE] = instance;
    if (process.env['RAGERS_DISABLE_WORKER'] !== '1') {
      startOrchestratorWorker(instance);
    }
  }
  return instance;
};
