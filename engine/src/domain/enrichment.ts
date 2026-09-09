import { createHash } from 'node:crypto';
import { err, ok, type Result } from '../runtime/result.ts';
import { validationError, type EngineError } from '../runtime/errors.ts';

/**
 * Structured experience enrichment — Phase 31, E1.
 *
 * The whole point of this module is the difference between a *measurement* and an
 * *assertion*. Nothing here is measured. Every dimension is what the person it
 * happened to said, stored with that provenance attached so no reader downstream can
 * quietly promote it.
 *
 * That is why there is no `estimatedLoss`, no inferred severity, and no field the
 * engine fills in from wording. Phase 32 classifies severity *from these
 * assertions*, which is only defensible because the assertions are the person's own.
 */
export type EnrichmentDimension =
  | 'money_lost'
  | 'time_lost_minutes'
  | 'service_interrupted'
  | 'safety_involved'
  | 'recurrence'
  | 'people_affected';

export const ENRICHMENT_DIMENSIONS: readonly EnrichmentDimension[] = [
  'money_lost',
  'time_lost_minutes',
  'service_interrupted',
  'safety_involved',
  'recurrence',
  'people_affected',
];

/**
 * Where a value came from. `experiencer` is the only provenance that counts as an
 * assertion; the others exist so a reader can tell that it does not.
 *
 * `extracted` is deliberately representable and deliberately inert: extraction may
 * suggest "£240" from the text, and until the person confirms it, every consumer of
 * this row must treat the dimension as *unknown* — the same rule normalization
 * already holds for entity and issue type.
 */
export type EnrichmentProvenance = 'experiencer' | 'extracted' | 'corroborator';

export interface EnrichmentValue {
  readonly dimension: EnrichmentDimension;
  /** Set for amounts and durations. */
  readonly amount?: number;
  /** Set for the yes/no dimensions. */
  readonly flag?: boolean;
  readonly currency?: string;
  readonly provenance: EnrichmentProvenance;
  readonly assertedBy: string;
  readonly assertedAt: number;
}

export interface ExperienceEnrichment {
  readonly id: string;
  readonly experienceId: string;
  readonly values: readonly EnrichmentValue[];
  /** Content fingerprint, for near-duplicate detection. See `fingerprintOf`. */
  readonly fingerprint: string;
  readonly correlationId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const NUMERIC_DIMENSIONS: readonly EnrichmentDimension[] = [
  'money_lost',
  'time_lost_minutes',
  'people_affected',
];

const FLAG_DIMENSIONS: readonly EnrichmentDimension[] = [
  'service_interrupted',
  'safety_involved',
  'recurrence',
];

/** Ceilings that reject a typo rather than let it drive a severity band. */
const CEILINGS: Readonly<Record<string, number>> = {
  money_lost: 10_000_000,
  time_lost_minutes: 60 * 24 * 365,
  people_affected: 1_000_000,
};

export interface AssertDimensionInput {
  readonly dimension: unknown;
  readonly amount?: unknown;
  readonly flag?: unknown;
  readonly currency?: unknown;
}

/**
 * Validate one asserted dimension.
 *
 * Refuses rather than coerces. A dimension arriving with the wrong shape is a caller
 * bug, and silently reading `flag: true` as `amount: 1` would put a number into a
 * severity band that nobody asserted.
 */
export const assertDimension = (
  input: AssertDimensionInput,
  meta: { assertedBy: string; now: number; provenance?: EnrichmentProvenance },
): Result<EnrichmentValue, EngineError> => {
  const dimension = input.dimension;
  if (typeof dimension !== 'string' || !(ENRICHMENT_DIMENSIONS as readonly string[]).includes(dimension)) {
    return err(validationError('unknown_dimension', 'that is not an enrichment dimension'));
  }
  const named = dimension as EnrichmentDimension;
  const provenance = meta.provenance ?? 'experiencer';

  if (NUMERIC_DIMENSIONS.includes(named)) {
    if (typeof input.amount !== 'number' || !Number.isFinite(input.amount)) {
      return err(validationError('amount_required', `${named.replaceAll('_', ' ')} needs a number`));
    }
    if (input.amount < 0) {
      return err(validationError('amount_negative', 'an asserted amount cannot be negative'));
    }
    const ceiling = CEILINGS[named] ?? Number.MAX_SAFE_INTEGER;
    if (input.amount > ceiling) {
      return err(
        validationError('amount_implausible', `that ${named.replaceAll('_', ' ')} is outside the accepted range`),
      );
    }
    if (named === 'money_lost' && (typeof input.currency !== 'string' || input.currency.length !== 3)) {
      // An amount without a currency is not comparable, and must not be compared.
      return err(validationError('currency_required', 'an amount of money needs a three-letter currency'));
    }
    return ok({
      dimension: named,
      amount: named === 'money_lost' ? Number(input.amount.toFixed(2)) : Math.round(input.amount),
      ...(named === 'money_lost' ? { currency: (input.currency as string).toUpperCase() } : {}),
      provenance,
      assertedBy: meta.assertedBy,
      assertedAt: meta.now,
    });
  }

  if (FLAG_DIMENSIONS.includes(named)) {
    if (typeof input.flag !== 'boolean') {
      return err(validationError('flag_required', `${named.replaceAll('_', ' ')} is a yes or no`));
    }
    return ok({
      dimension: named,
      flag: input.flag,
      provenance,
      assertedBy: meta.assertedBy,
      assertedAt: meta.now,
    });
  }

  return err(validationError('unknown_dimension', 'that is not an enrichment dimension'));
};

/**
 * The dimensions a reader may treat as asserted.
 *
 * One line, and the load-bearing one in this file: anything not asserted by a person
 * is filtered out before it reaches a classifier. Extraction is kept for the person
 * to confirm, and is invisible to everything else.
 */
export const assertedValues = (
  enrichment: Pick<ExperienceEnrichment, 'values'>,
): readonly EnrichmentValue[] => enrichment.values.filter((value) => value.provenance === 'experiencer');

/** Replace one dimension, keeping the rest. Re-asserting is normal, not an error. */
export const withDimension = (
  values: readonly EnrichmentValue[],
  next: EnrichmentValue,
): readonly EnrichmentValue[] => [...values.filter((value) => value.dimension !== next.dimension), next];

/**
 * Text normalization for the fingerprint only.
 *
 * Deliberately separate from `extractTerms`, which drops stopwords and short tokens
 * to make *similarity* meaningful. A fingerprint wants the opposite: the whole text,
 * flattened just enough that re-typed punctuation or casing does not hide a
 * duplicate. Sharing one helper between the two would make each worse.
 */
const normalizeForFingerprint = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export interface FingerprintInput {
  readonly kind: string;
  /** Confirmed structure only — see the note below. */
  readonly entityId?: string | undefined;
  readonly issueTypeId?: string | undefined;
  readonly city?: string | undefined;
  readonly text: string;
}

/**
 * Content fingerprint — ported from the plain-JS runtime on PR #6, which had the one
 * capability the authoritative engine lacked: a way to notice the *same account
 * posted twice*.
 *
 * Two changes from the original, both deliberate:
 *
 *   1. It takes **confirmed** structure, never extracted. The original fingerprinted
 *      whatever `entityId` sat on the row. Feeding it an unconfirmed entity here
 *      would create a second path by which extraction acts as agreement — precisely
 *      the rule normalization exists to hold. An unconfirmed field arrives as
 *      `undefined` and contributes an empty segment.
 *   2. A match is an **input to review**, never an action. Nothing in this engine
 *      deletes, hides or suppresses on a fingerprint match: a person legitimately
 *      re-posting a corrected account would otherwise vanish.
 */
export const fingerprintOf = (input: FingerprintInput): string => {
  const material = [
    input.kind,
    input.entityId ?? '',
    input.issueTypeId ?? '',
    (input.city ?? '').trim().toLowerCase(),
    normalizeForFingerprint(input.text),
  ].join('|');
  return createHash('sha256').update(material).digest('hex');
};

/** Whether two fingerprints denote the same content. Named so call sites read plainly. */
export const isSameContent = (left: string, right: string): boolean =>
  left.length > 0 && left === right;
