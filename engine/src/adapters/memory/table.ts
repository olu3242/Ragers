import {
  matchesCriteria,
  type Criteria,
  type QueryOptions,
  type Table,
} from '../../ports/store.ts';

/**
 * In-memory table. Rows are frozen on write so a caller cannot mutate stored
 * state by holding a reference — the same discipline a real database enforces.
 */
export const createMemoryTable = <T extends { readonly id: string }>(): Table<T> => {
  const rows = new Map<string, T>();

  const applyOptions = (matched: readonly T[], options?: QueryOptions<T>): readonly T[] => {
    let result = [...matched];
    const orderBy = options?.orderBy;
    if (orderBy) {
      result.sort((a, b) => {
        const left = (a as Record<string, unknown>)[orderBy.field];
        const right = (b as Record<string, unknown>)[orderBy.field];
        const comparison =
          typeof left === 'number' && typeof right === 'number'
            ? left - right
            : String(left).localeCompare(String(right));
        return orderBy.direction === 'desc' ? -comparison : comparison;
      });
    }
    if (options?.limit !== undefined) result = result.slice(0, options.limit);
    return result;
  };

  return {
    get: async (id) => rows.get(id),
    put: async (row) => {
      rows.set(row.id, Object.freeze({ ...row }));
    },
    remove: async (id) => {
      rows.delete(id);
    },
    all: async () => [...rows.values()],

    // Deliberately free of `await` between the read and the write: JavaScript
    // runs this body to completion before another dispatch resumes, so the
    // check-and-set is atomic here in the same way `insert ... on conflict do
    // nothing` is atomic in Postgres.
    compareAndSet: async (row, expected) => {
      const current = rows.get(row.id);
      if (expected === 'absent') {
        if (current !== undefined) return false;
      } else if (current === undefined || !matchesCriteria(current, expected)) {
        return false;
      }
      rows.set(row.id, Object.freeze({ ...row }));
      return true;
    },

    query: async (criteria: Criteria<T>, options?: QueryOptions<T>) =>
      applyOptions([...rows.values()].filter((row) => matchesCriteria(row, criteria)), options),
    queryOne: async (criteria: Criteria<T>) =>
      [...rows.values()].find((row) => matchesCriteria(row, criteria)),
    countWhere: async (criteria: Criteria<T>) =>
      [...rows.values()].filter((row) => matchesCriteria(row, criteria)).length,

    find: async (predicate) => [...rows.values()].filter(predicate),
    findOne: async (predicate) => [...rows.values()].find(predicate),
    count: async (predicate) =>
      predicate ? [...rows.values()].filter(predicate).length : rows.size,
  };
};
