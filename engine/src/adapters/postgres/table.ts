import type { Db } from './client.ts';
import { toEngineError } from './client.ts';
import type { Criteria, QueryOptions, Table } from '../../ports/store.ts';

/**
 * Generic row mapper between the domain shape (camelCase, epoch-millisecond
 * timestamps) and the relational shape (snake_case, timestamptz, numeric).
 *
 * Field names convert automatically; only genuine exceptions are declared, so a
 * new column does not need a mapping entry.
 */
export interface TableDescriptor<T extends { readonly id: string }> {
  /** SQL relation name. */
  readonly relation: string;
  /** Column backing the domain `id`. */
  readonly idColumn: string;
  /**
   * Domain fields that do not map to a column by snake_case conversion.
   * A field mapped to `null` is not persisted (it is derived on read).
   */
  readonly overrides?: Readonly<Record<string, string | null>>;
  /** Domain fields whose column is the primary key under a different name. */
  readonly derivedId?: (row: Record<string, unknown>) => string;
}

const snake = (field: string): string => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Columns stored as timestamptz but carried as epoch milliseconds in the domain. */
const TIMESTAMP_COLUMNS = new Set([
  'created_at',
  'updated_at',
  'published_at',
  'deleted_at',
  'last_active_at',
  'issued_at',
  'expires_at',
  'revoked_at',
  'occurred_at',
  'computed_at',
  'claimed_at',
  'granted_at',
  'completed_at',
  'read_at',
  'delivered_at',
  'next_attempt_at',
  'consumed_at',
]);

/** Columns declared `numeric` in SQL, which pg returns as strings. */
const NUMERIC_COLUMNS = new Set([
  'approval_rate',
  'confidence',
  'weight',
  'rank_score',
  'engagement_score',
  'fairness_score',
  'recency_decay',
  'balance_adjustment',
  'final_score',
  'velocity',
  'value',
  'byte_size',
]);

const toDbValue = (column: string, value: unknown): unknown => {
  if (value === undefined) return null;
  if (value === null) return null;
  if (TIMESTAMP_COLUMNS.has(column) && typeof value === 'number') return new Date(value).toISOString();
  return value;
};

const fromDbValue = (column: string, value: unknown): unknown => {
  if (value === null) return undefined;
  if (TIMESTAMP_COLUMNS.has(column) && value instanceof Date) return value.getTime();
  if (NUMERIC_COLUMNS.has(column) && typeof value === 'string') return Number(value);
  if (typeof value === 'bigint') return Number(value);
  return value;
};

const OPERATORS: Readonly<Record<string, (column: string, index: number) => string>> = {
  eq: (c, i) => `${c} = $${i}`,
  ne: (c, i) => `${c} is distinct from $${i}`,
  gt: (c, i) => `${c} > $${i}`,
  gte: (c, i) => `${c} >= $${i}`,
  lt: (c, i) => `${c} < $${i}`,
  lte: (c, i) => `${c} <= $${i}`,
  in: (c, i) => `${c} = any($${i})`,
  isTrue: (c) => `${c} is true`,
  isFalse: (c) => `${c} is false`,
  isNull: (c) => `${c} is null`,
  notNull: (c) => `${c} is not null`,
};

const VALUELESS = new Set(['isTrue', 'isFalse', 'isNull', 'notNull']);

export const createPostgresTable = <T extends { readonly id: string }>(
  db: Db,
  descriptor: TableDescriptor<T>,
  /** Guard so a mistaken full scan is loud rather than slow. */
  fullScanLimit = 10_000,
): Table<T> => {
  const columnFor = (field: string): string | undefined => {
    const override = descriptor.overrides?.[field];
    if (override === null) return undefined;
    if (override !== undefined) return override;
    if (field === 'id') return descriptor.idColumn;
    return snake(field);
  };

  const toRow = (record: Record<string, unknown>): T => {
    const out: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(record)) {
      const converted = fromDbValue(column, value);
      if (converted === undefined) continue;
      // Reverse the column mapping, preferring a declared override.
      const declared = Object.entries(descriptor.overrides ?? {}).find(([, col]) => col === column);
      // When the primary key is also a meaningful domain field — feed_entries is
      // keyed by experience_id — map it to that field and let `derivedId` supply
      // the domain id, rather than losing the field to `id`.
      const field = declared
        ? declared[0]
        : column === descriptor.idColumn && !descriptor.derivedId
          ? 'id'
          : column.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
      out[field] = converted;
    }
    if (descriptor.derivedId) out['id'] = descriptor.derivedId(out);
    return out as T;
  };

  const compile = (criteria: Criteria<T>, startIndex = 1): { clause: string; params: unknown[] } => {
    if (criteria.length === 0) return { clause: '', params: [] };
    const params: unknown[] = [];
    const parts: string[] = [];
    let index = startIndex;
    for (const criterion of criteria) {
      const column = columnFor(criterion.field);
      if (!column) continue;
      const build = OPERATORS[criterion.op];
      if (!build) continue;
      if (VALUELESS.has(criterion.op)) {
        parts.push(build(column, 0));
      } else {
        params.push(toDbValue(column, criterion.value));
        parts.push(build(column, index));
        index += 1;
      }
    }
    return { clause: parts.length > 0 ? ` where ${parts.join(' and ')}` : '', params };
  };

  const suffix = (options?: QueryOptions<T>): string => {
    let out = '';
    const orderBy = options?.orderBy;
    if (orderBy) {
      const column = columnFor(orderBy.field);
      if (column) out += ` order by ${column} ${orderBy.direction === 'desc' ? 'desc' : 'asc'}`;
    }
    if (options?.limit !== undefined) out += ` limit ${Math.max(0, Math.floor(options.limit))}`;
    return out;
  };

  const run = async (sql: string, params: readonly unknown[]): Promise<readonly T[]> => {
    try {
      const rows = await db.query<Record<string, unknown>>(sql, params);
      return rows.map(toRow);
    } catch (cause) {
      throw Object.assign(new Error(toEngineError(cause).message), { engineError: toEngineError(cause) });
    }
  };

  return {
    get: async (id) => {
      const rows = await run(`select * from ${descriptor.relation} where ${descriptor.idColumn} = $1`, [id]);
      return rows[0];
    },

    put: async (row) => {
      const entries: [string, unknown][] = [];
      for (const [field, value] of Object.entries(row as Record<string, unknown>)) {
        const column = columnFor(field);
        // A derived id has no column of its own; skip it rather than inventing one.
        if (!column) continue;
        if (field === 'id' && descriptor.derivedId) continue;
        if (entries.some(([existing]) => existing === column)) continue;
        entries.push([column, toDbValue(column, value)]);
      }
      if (!entries.some(([column]) => column === descriptor.idColumn)) {
        entries.push([descriptor.idColumn, row.id]);
      }

      const columns = entries.map(([column]) => column);
      const params = entries.map(([, value]) => value);
      const placeholders = columns.map((_column, index) => `$${index + 1}`);
      const updates = columns
        .filter((column) => column !== descriptor.idColumn)
        .map((column) => `${column} = excluded.${column}`);

      // Upsert: `put` is idempotent, which is what every consumer relies on.
      const sql =
        `insert into ${descriptor.relation} (${columns.join(', ')}) values (${placeholders.join(', ')}) ` +
        `on conflict (${descriptor.idColumn}) do ${
          updates.length > 0 ? `update set ${updates.join(', ')}` : 'nothing'
        }`;
      try {
        await db.query(sql, params);
      } catch (cause) {
        throw Object.assign(new Error(toEngineError(cause).message), { engineError: toEngineError(cause) });
      }
    },

    remove: async (id) => {
      await db.query(`delete from ${descriptor.relation} where ${descriptor.idColumn} = $1`, [id]);
    },

    all: async () => run(`select * from ${descriptor.relation} limit ${fullScanLimit}`, []),

    query: async (criteria, options) => {
      const { clause, params } = compile(criteria);
      return run(`select * from ${descriptor.relation}${clause}${suffix(options)}`, params);
    },

    queryOne: async (criteria) => {
      const { clause, params } = compile(criteria);
      const rows = await run(`select * from ${descriptor.relation}${clause} limit 1`, params);
      return rows[0];
    },

    countWhere: async (criteria) => {
      const { clause, params } = compile(criteria);
      const rows = await db.query<{ count: string }>(
        `select count(*)::text as count from ${descriptor.relation}${clause}`,
        params,
      );
      return Number(rows[0]?.count ?? 0);
    },

    // Predicate forms have to materialise the table, so they exist for tests only.
    find: async (predicate) => (await run(`select * from ${descriptor.relation} limit ${fullScanLimit}`, [])).filter(predicate),
    findOne: async (predicate) => (await run(`select * from ${descriptor.relation} limit ${fullScanLimit}`, [])).find(predicate),
    count: async (predicate) => {
      if (!predicate) {
        const rows = await db.query<{ count: string }>(`select count(*)::text as count from ${descriptor.relation}`);
        return Number(rows[0]?.count ?? 0);
      }
      return (await run(`select * from ${descriptor.relation} limit ${fullScanLimit}`, [])).filter(predicate).length;
    },
  };
};
