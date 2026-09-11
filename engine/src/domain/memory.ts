/**
 * Phase 52 — Rager context memory.
 *
 * What has happened to *this experience*, in order. Assembled on read from rows and
 * event logs that already exist and are already append-only; there is no memory
 * table, because a second store of the same facts is a second version of the truth
 * and the one that goes stale is always the copy.
 *
 * Two constraints decide the shape, and both are about what a memory must *not* be:
 *
 * **No profiling.** The memory is keyed on the experience and carries no actor
 * identifier anywhere — not the author's, not a corroborator's, not a reviewer's.
 * Only the *role* that acted, and counts. This is not a display convention; it is
 * what makes person-level inference inexpressible from this read, and
 * `FORBIDDEN_MEMORY_KEYS` asserts it. A memory that carried ids would be a profiling
 * primitive whatever the intent of whoever first read it, because anyone could scan
 * every experience and join on the id.
 *
 * **No free text.** No body, no narrative, no dispute detail, no response text. The
 * memory says *that* something happened and its named attributes. This is what makes
 * it safe to hand to E12: a copilot summarising a memory cannot quote a person,
 * because it was never given anything to quote.
 */

/** What happened. Named, closed, and each one a durable fact rather than an inference. */
export type MemoryEntryKind =
  | 'published'
  | 'structure_confirmed'
  | 'cost_asserted'
  | 'corroborated'
  | 'corroboration_retracted'
  | 'evidence_attached'
  | 'organization_responded'
  | 'outcome_reported'
  | 'outcome_changed'
  | 'disputed'
  | 'dispute_reviewed'
  | 'escalated';

export const MEMORY_ENTRY_KINDS: readonly MemoryEntryKind[] = [
  'published',
  'structure_confirmed',
  'cost_asserted',
  'corroborated',
  'corroboration_retracted',
  'evidence_attached',
  'organization_responded',
  'outcome_reported',
  'outcome_changed',
  'disputed',
  'dispute_reviewed',
  'escalated',
];

/** Who acted, as a role. Never as a person. */
export type MemoryActorRole = 'experiencer' | 'corroborator' | 'organization' | 'operator' | 'system';

export type MemoryDetailValue = string | number | boolean;

export interface MemoryEntry {
  readonly at: number;
  readonly kind: MemoryEntryKind;
  readonly by: MemoryActorRole;
  /**
   * Named attributes only — an enum value, a count, a flag, a dimension name. Never
   * anything a person wrote and never an identifier of a person.
   */
  readonly detail: Readonly<Record<string, MemoryDetailValue>>;
}

export interface ExperienceMemory {
  readonly experienceId: string;
  readonly entries: readonly MemoryEntry[];
  readonly firstAt?: number;
  readonly lastAt?: number;
  /** How many distinct people have contributed a claim. A count, never a list. */
  readonly contributorCount: number;
}

/**
 * Keys that must never appear anywhere in a serialised memory.
 *
 * The person keys are the point of the phase. The text keys are there because a
 * memory is handed to E12, and a body that reached a summary would be a quotation
 * nobody consented to.
 */
export const FORBIDDEN_MEMORY_KEYS: readonly string[] = [
  'actorId',
  'actor_id',
  'assertedBy',
  'asserted_by',
  'corroboratorId',
  'corroborator_id',
  'reporterActorId',
  'reviewedBy',
  'raisedBy',
  'authorId',
  'aliasId',
  'email',
  'bodyText',
  'body',
  'narrative',
  'note',
  'statement',
  'rawText',
  'raw_text',
  'originalKey',
  'original_key',
];

/** Assemble the entries into a memory, oldest first. Ties break on kind, deterministically. */
export const assembleMemory = (
  experienceId: string,
  entries: readonly MemoryEntry[],
  contributorCount: number,
): ExperienceMemory => {
  const ordered = [...entries].sort(
    (left, right) => left.at - right.at || left.kind.localeCompare(right.kind),
  );
  const first = ordered[0];
  const last = ordered.at(-1);
  return {
    experienceId,
    entries: ordered,
    ...(first === undefined ? {} : { firstAt: first.at }),
    ...(last === undefined ? {} : { lastAt: last.at }),
    contributorCount,
  };
};

/**
 * Deliberately absent: a memory of a person.
 *
 * Returning `undefined` rather than not existing at all, so the absence is something
 * a test can assert rather than something a reader has to notice. Context that
 * accumulates against a person is profiling; there is no version of this the band
 * builds later.
 */
export const actorMemory = (): undefined => undefined;

/** Recursively collect every key in a value, so the guarantee above is swept, not assumed. */
export const collectMemoryKeys = (value: unknown, into: Set<string> = new Set()): Set<string> => {
  if (value === null || typeof value !== 'object') return into;
  if (Array.isArray(value)) {
    for (const item of value) collectMemoryKeys(item, into);
    return into;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    into.add(key);
    collectMemoryKeys(item, into);
  }
  return into;
};

export const forbiddenMemoryKeysIn = (value: unknown): readonly string[] => {
  const keys = collectMemoryKeys(value);
  return FORBIDDEN_MEMORY_KEYS.filter((forbidden) => keys.has(forbidden));
};
