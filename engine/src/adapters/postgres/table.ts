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

/**
 * Columns stored as timestamptz but carried as epoch milliseconds in the domain.
 *
 * Recognised by convention rather than by a hand-maintained list: every
 * timestamptz column in the migrations is named `<something>_at` (plus
 * `job_history.at`), and a list had to be edited for each new one — which is
 * exactly the kind of omission that turns into "date/time field value out of
 * range" the first time a new column is written. `tests/unit/schema.migrations.test.ts`
 * asserts the migrations keep to the convention, so the rule cannot silently
 * drift away from the schema.
 */
export const isTimestampColumn = (column: string): boolean => column === 'at' || column.endsWith('_at');

/** Columns declared `numeric` in SQL, which pg returns as strings. */
/**
 * Columns declared `numeric` or `bigint` in SQL, which pg returns as strings.
 *
 * Unlike timestamps these share no naming convention, so the set is explicit —
 * and therefore the same trap the timestamp list was: a new numeric column that
 * nobody adds here reads back as a string, and arithmetic on it silently
 * concatenates. `tests/unit/schema.migrations.test.ts` asserts that every
 * numeric and bigint column in the migrations appears here, so the omission is a
 * test failure rather than a wrong number in production.
 */
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
  // ── Experience Signal Engine ────────────────────────────────────────────
  'score',
  'response_rate',
  'resolution_rate',
  'repeat_incidence',
  'growth_rate',
  'signal_acceleration',
  'reopen_rate',
  'median_resolution_ms',
  'account_confidence',
  'contribution_confidence',
  'evidence_confidence',
  // Runtime bookkeeping.
  'sequence',
  'last_sequence',
  // ── Engine contract gaps ────────────────────────────────────────────────
  'median_acknowledgement_ms',
  'median_first_response_ms',
  'oldest_open_ms',
]);

export const isNumericColumn = (column: string): boolean => NUMERIC_COLUMNS.has(column);

/**
 * Columns declared `jsonb` in SQL.
 *
 * These need explicit serialization, and the reason is a genuinely nasty pg
 * behaviour rather than a preference. node-postgres serializes a plain object to
 * JSON text, but an **array** to a Postgres *array literal* — so a jsonb column
 * holding an array of objects fails outright with "invalid input syntax for type
 * json", and, far worse, an **empty** array silently persists as `{}`: a JSON
 * object, not an empty JSON array. A reader then gets `{}` back where it expected
 * `[]`.
 *
 * That is not a hypothetical. `intelligence_proposals.evidence_refs` is an array of
 * objects and the domain requires at least one, so every proposal written through
 * this adapter failed against Postgres — invisible until now because the live test
 * inserted proposals with raw SQL rather than through the engine.
 *
 * The set is explicit for the same reason `NUMERIC_COLUMNS` is: jsonb columns share
 * no naming convention. `tests/unit/schema.migrations.test.ts` asserts every jsonb
 * column in the migrations appears here, so an omission is a test failure rather
 * than a write that fails in production.
 */
const JSON_COLUMNS = new Set([
  // Runtime bookkeeping.
  'payload',
  'response',
  'error',
  'failure_history',
  'checkpoint',
  // Audit before/after snapshots.
  'before',
  'after',
  // RC3 credential cost parameters, stored per row so raising the cost is a rotation.
  'params',
  // Extraction, confirmation and the findings various engines record.
  'extracted',
  'confirmed',
  'factors',
  'detail',
  'properties',
  'propagation',
  'protection_findings',
  'redaction_findings',
  'internal_signals',
  'geographic_concentration',
  // ── Engine contract gaps ────────────────────────────────────────────────
  'evidence_refs',
  'proposed_input',
  // ── Phases 31–35 ────────────────────────────────────────────────────────
  'values',
  // ── Phase 59 ────────────────────────────────────────────────────────────
  // A plan step's command input. Declared jsonb, so it is serialised here rather
  // than left to pg — which would turn an array-valued input into a Postgres array
  // literal, the defect the whole convention exists to prevent.
  'input',
]);

export const isJsonColumn = (column: string): boolean => JSON_COLUMNS.has(column);

const toDbValue = (column: string, value: unknown): unknown => {
  if (value === undefined) return null;
  if (value === null) return null;
  if (isTimestampColumn(column) && typeof value === 'number') return new Date(value).toISOString();
  // Serialized here rather than left to pg, which would turn an array into a
  // Postgres array literal — see the note on JSON_COLUMNS.
  if (isJsonColumn(column)) return JSON.stringify(value);
  return value;
};

const fromDbValue = (column: string, value: unknown): unknown => {
  if (value === null) return undefined;
  if (isTimestampColumn(column) && value instanceof Date) return value.getTime();
  // pg already parses jsonb into JS values, so a string here means the column holds
  // JSON *text* rather than a structure. Parsing it keeps the round trip symmetric.
  if (isJsonColumn(column) && typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
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

  /** Domain row → (column, value) pairs, with the id column always present. */
  const columnEntries = (row: T): [string, unknown][] => {
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
    return entries;
  };

  return {
    get: async (id) => {
      const rows = await run(`select * from ${descriptor.relation} where ${descriptor.idColumn} = $1`, [id]);
      return rows[0];
    },

    put: async (row) => {
      const entries = columnEntries(row);
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

    /**
     * Compare-and-set, resolved by the database rather than by a read followed by
     * a write. `'absent'` becomes an insert that the primary key arbitrates, so
     * exactly one concurrent caller is told it won; a criteria precondition
     * becomes a conditional update, which writes nothing — and reports false —
     * when the stored row has moved on or does not exist.
     */
    compareAndSet: async (row, expected) => {
      const entries = columnEntries(row);
      try {
        if (expected === 'absent') {
          const columns = entries.map(([column]) => column);
          const params = entries.map(([, value]) => value);
          const placeholders = columns.map((_column, index) => `$${index + 1}`);
          const inserted = await db.query<Record<string, unknown>>(
            `insert into ${descriptor.relation} (${columns.join(', ')}) values (${placeholders.join(', ')}) ` +
              `on conflict (${descriptor.idColumn}) do nothing returning ${descriptor.idColumn}`,
            params,
          );
          return inserted.length === 1;
        }

        // Only the columns that are actually assigned may occupy a placeholder:
        // an unreferenced parameter leaves Postgres unable to infer its type.
        const assignable = entries.filter(([column]) => column !== descriptor.idColumn);
        const assignments = assignable.map(([column], index) => `${column} = $${index + 1}`);
        const idParam = assignable.length + 1;
        const { clause, params: guard } = compile(expected, idParam + 1);
        // `compile` emits its own `where`; fold it into this one.
        const guardClause = clause.replace(/^ where /, ' and ');

        if (assignments.length === 0) {
          // Only the key to write, so the precondition is the whole operation.
          const { clause: soleClause, params: soleGuard } = compile(expected, 2);
          const matched = await db.query(
            `select 1 from ${descriptor.relation} where ${descriptor.idColumn} = $1` +
              `${soleClause.replace(/^ where /, ' and ')} limit 1`,
            [row.id, ...soleGuard],
          );
          return matched.length === 1;
        }

        const updated = await db.query<Record<string, unknown>>(
          `update ${descriptor.relation} set ${assignments.join(', ')} ` +
            `where ${descriptor.idColumn} = $${idParam}${guardClause} returning ${descriptor.idColumn}`,
          [...assignable.map(([, value]) => value), row.id, ...guard],
        );
        return updated.length === 1;
      } catch (cause) {
        const engineError = toEngineError(cause);
        // A unique violation here is the losing side of the race, not a fault.
        if (engineError.code === 'unique_violation') return false;
        throw Object.assign(new Error(engineError.message), { engineError });
      }
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
