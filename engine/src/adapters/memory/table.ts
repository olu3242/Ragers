import type { Table } from '../../ports/store.ts';

/**
 * In-memory table. Rows are frozen on write so a caller cannot mutate stored
 * state by holding a reference — the same discipline a real database enforces.
 */
export const createMemoryTable = <T extends { readonly id: string }>(): Table<T> => {
  const rows = new Map<string, T>();
  return {
    get: async (id) => rows.get(id),
    put: async (row) => {
      rows.set(row.id, Object.freeze({ ...row }));
    },
    remove: async (id) => {
      rows.delete(id);
    },
    all: async () => [...rows.values()],
    find: async (predicate) => [...rows.values()].filter(predicate),
    findOne: async (predicate) => [...rows.values()].find(predicate),
    count: async (predicate) =>
      predicate ? [...rows.values()].filter(predicate).length : rows.size,
  };
};
