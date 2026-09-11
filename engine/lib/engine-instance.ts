import process from 'node:process';
import { createEngine, type Engine } from '../src/engine.ts';
import { startOrchestratorWorker } from './worker.ts';
import { configuredDb, passwordlessSignInAllowed } from './engine-store.ts';

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
 * deployment swaps the in-memory adapters for the Postgres/Supabase ones — which
 * `configuredDb()` now actually does from `DATABASE_URL`. No engine module
 * changes, because they only ever see the ports.
 *
 * With no database configured the in-memory adapters remain, which is right for local
 * development and for the tests, and wrong for anything else: nothing survives a restart
 * and a second process sees different data. `/api/readiness` reports which it is.
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
    // **The lines that were missing.** Until these existed the comment above was describing an
    // intention rather than a behaviour: every request used the in-memory adapters even with
    // DATABASE_URL set, so nothing survived a restart and two processes saw different data.
    //
    // `db` rather than `store`, because a database is what makes the *runtime* stores Postgres too
    // — the outbox above all. With only `store` passed, the domain rows would persist and the
    // undelivered events would not, which is a worse failure than either backend alone.
    const db = configuredDb();
    instance = createEngine({
      ...(db === undefined ? {} : { db }),
      config: { allowPasswordlessSignIn: passwordlessSignInAllowed() },
    });
    registry[ENGINE] = instance;
    if (process.env['RAGERS_DISABLE_WORKER'] !== '1') {
      startOrchestratorWorker(instance);
    }
  }
  return instance;
};
