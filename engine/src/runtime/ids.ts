import { randomUUID } from 'node:crypto';

/** Id generation is injected so tests get stable, readable identifiers. */
export interface IdFactory {
  next(prefix: string): string;
}

export const uuidIdFactory: IdFactory = {
  next: (prefix: string) => `${prefix}_${randomUUID()}`,
};

export const sequentialIdFactory = (): IdFactory => {
  const counters = new Map<string, number>();
  return {
    next: (prefix: string) => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${String(n).padStart(4, '0')}`;
    },
  };
};

/** Stable pseudonymous hash — used by analytics so actor ids never reach the sink. */
export const pseudonymize = async (actorId: string, salt: string): Promise<string> => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(`${salt}:${actorId}`).digest('hex').slice(0, 32);
};
