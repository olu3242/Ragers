import { createEngine, type Engine } from '../src/engine.ts';

/**
 * One engine per server process.
 *
 * The in-memory adapters are the development default. A deployment swaps them
 * for the Postgres/Supabase adapters by passing `store` here — no engine module
 * changes, because they only ever see the ports.
 */
let instance: Engine | undefined;

export const getEngine = (): Engine => {
  instance ??= createEngine();
  return instance;
};
