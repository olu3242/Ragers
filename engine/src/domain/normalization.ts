import { err, ok, type Result } from '../runtime/result.ts';
import { validationError, type EngineError } from '../runtime/errors.ts';

/**
 * Normalization — structure without substitution.
 *
 * Extraction proposes; the person confirms; both are kept. The rule that governs
 * every line here: **an unconfirmed suggestion is never a fact.** Matching,
 * clustering and signal aggregation read confirmed fields only, and treat an
 * unconfirmed field as *unknown* rather than as the suggested value — which is
 * why `identifierAgreement` distinguishes unknown (0.5) from disagreement (0).
 *
 * The alternative — using extraction directly when nobody objected — would mean
 * a misread entity name silently reassigning someone's experience to a company
 * they never mentioned, and doing it most often to the people least likely to
 * check.
 */

/** A field extraction can propose. Deliberately small: each one is checkable. */
export type NormalizableField = 'title' | 'entity' | 'category' | 'issueType' | 'location' | 'occurredAt';

export const NORMALIZABLE_FIELDS: readonly NormalizableField[] = [
  'title',
  'entity',
  'category',
  'issueType',
  'location',
  'occurredAt',
];

/**
 * One proposal. `value` is what extraction read, `evidence` is the span of the
 * person's own words it came from — so the confirmation UI can show them why it
 * is asking, rather than presenting a value from nowhere.
 */
export interface Suggestion {
  readonly field: NormalizableField;
  readonly value: string;
  readonly confidence: number;
  /** The person's own words this was read from. Never paraphrased. */
  readonly evidence?: string;
}

export interface ExtractionOutcome {
  readonly source: 'none' | 'text' | 'voice';
  readonly suggestions: readonly Suggestion[];
}

/** A confirmed field: the value publication and matching are allowed to read. */
export interface ConfirmedField {
  readonly field: NormalizableField;
  readonly value: string;
  /** True when the person changed the suggestion rather than accepting it. */
  readonly edited: boolean;
}

export const CONFIDENCE_FLOOR = 0.35;
export const TITLE_MAX_LENGTH = 120;

/**
 * Terms for the semantic factor, from redacted text only.
 *
 * Short tokens and stopwords are dropped because they inflate Jaccard similarity
 * between unrelated experiences — "the refund" and "the delay" would look alike
 * on `the` alone.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'was', 'were', 'with', 'that', 'this', 'they', 'them',
  'have', 'has', 'had', 'been', 'from', 'about', 'into', 'than', 'then', 'when',
  'what', 'who', 'why', 'how', 'not', 'but', 'all', 'any', 'are', 'you', 'your',
  'their', 'there', 'here', 'just', 'only', 'very', 'too', 'get', 'got',
]);

export const extractTerms = (text: string): readonly string[] => {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));
  // Deduplicated: repeating a word does not make an experience more similar.
  return [...new Set(tokens)].sort();
};

export interface ExtractionInput {
  /** Redacted text only — never the raw body, never a raw transcript. */
  readonly text: string;
  readonly source: 'text' | 'voice';
  /** Known entity aliases, lowercased, mapped to their entity id. */
  readonly aliases: ReadonlyMap<string, string>;
  /** Known category slugs by lowercased name. */
  readonly categories: ReadonlyMap<string, string>;
  readonly now: number;
}

/** How much a voice transcript's readings are discounted. */
const VOICE_CONFIDENCE_FACTOR = 0.8;

const round = (value: number): number => Number(value.toFixed(3));

/**
 * Deterministic extraction.
 *
 * Deliberately rule-based rather than model-based at this layer: the engine's job
 * is to produce a *checkable* proposal with the person's own words attached, and
 * a deterministic reading is testable and reproducible. A model provider can
 * later supply additional suggestions through the same shape — it does not get a
 * different privilege, because confirmation is what confers fact either way.
 */
export const extractFacts = (input: ExtractionInput): ExtractionOutcome => {
  const suggestions: Suggestion[] = [];
  const haystack = input.text.toLowerCase();
  // A transcript is a reading of speech, so every proposal from one is less
  // certain than the same proposal from typed text.
  const discount = input.source === 'voice' ? VOICE_CONFIDENCE_FACTOR : 1;

  // Entity, by alias. Longest alias first, so "Air Canada" wins over "Air".
  const aliases = [...input.aliases.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [alias, entityId] of aliases) {
    const index = haystack.indexOf(alias.toLowerCase());
    if (index === -1) continue;
    suggestions.push({
      field: 'entity',
      value: entityId,
      // An alias match is strong but not proof: the words may be incidental.
      confidence: round(0.75 * discount),
      evidence: input.text.slice(index, index + alias.length),
    });
    break;
  }

  for (const [name, categoryId] of input.categories.entries()) {
    if (!haystack.includes(name.toLowerCase())) continue;
    suggestions.push({ field: 'category', value: categoryId, confidence: round(0.6 * discount) });
    break;
  }

  // A first sentence is a reasonable title *proposal* and nothing more.
  const sentence = input.text.split(/(?<=[.!?])\s/)[0]?.trim() ?? '';
  if (sentence.length > 0 && sentence.length <= TITLE_MAX_LENGTH) {
    suggestions.push({
      field: 'title',
      value: sentence,
      confidence: round(0.5 * discount),
      evidence: sentence,
    });
  }

  return { source: input.source, suggestions };
};

/** Suggestions worth showing. Below the floor, a guess is noise. */
export const worthConfirming = (outcome: ExtractionOutcome): readonly Suggestion[] =>
  outcome.suggestions.filter((suggestion) => suggestion.confidence >= CONFIDENCE_FLOOR);

export interface ConfirmationInput {
  /** What the person affirmed, field by field. Absent means not confirmed. */
  readonly fields: Readonly<Partial<Record<NormalizableField, string>>>;
  readonly extracted: ExtractionOutcome;
}

export interface Confirmation {
  readonly fields: readonly ConfirmedField[];
  readonly confirmedAt: number;
  readonly confirmedBy: string;
}

/**
 * Confirm. Only what the person actually affirmed becomes a confirmed field —
 * there is no path here by which an unconfirmed suggestion is promoted.
 */
export const confirmFacts = (
  input: ConfirmationInput,
  meta: { actorId: string; now: number },
): Result<Confirmation, EngineError> => {
  // Validated rather than assumed. A caller sending the wrong shape — `confirmations`
  // instead of `fields`, say — used to reach `Object.entries(undefined)` and throw, which the
  // bus caught and reported as `command_threw`: an internal, non-retryable error for what is
  // plainly a bad request. A domain boundary should refuse malformed input in its own words.
  if (typeof input.fields !== 'object' || input.fields === null || Array.isArray(input.fields)) {
    return err(
      validationError('fields_required', 'confirmation takes a `fields` object of field names to values'),
    );
  }
  const entries = Object.entries(input.fields) as [NormalizableField, string][];
  if (entries.length === 0) {
    return err(validationError('nothing_to_confirm', 'confirmation must name at least one field'));
  }
  const fields: ConfirmedField[] = [];

  for (const [field, value] of entries) {
    if (!NORMALIZABLE_FIELDS.includes(field)) {
      return err(validationError('unknown_field', `${field} is not a normalizable field`));
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      return err(validationError('empty_confirmation', `${field} cannot be confirmed as empty`));
    }
    if (field === 'title' && value.length > TITLE_MAX_LENGTH) {
      return err(validationError('title_too_long', `a title must be at most ${TITLE_MAX_LENGTH} characters`));
    }
    if (field === 'occurredAt') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return err(validationError('invalid_occurred_at', 'occurredAt must be a timestamp'));
      }
      if (parsed > meta.now) {
        return err(validationError('occurred_in_future', 'an experience cannot have happened in the future'));
      }
    }

    const suggested = input.extracted.suggestions.find((suggestion) => suggestion.field === field);
    fields.push({ field, value: value.trim(), edited: suggested?.value !== value.trim() });
  }

  return ok({ fields, confirmedAt: meta.now, confirmedBy: meta.actorId });
};

/**
 * The confirmed value of a field, or undefined.
 *
 * The only accessor matching and clustering are allowed to use. Reading
 * `extracted` for a fact is the bug this function exists to make obvious.
 */
export const confirmedValue = (
  confirmed: Readonly<Record<string, unknown>>,
  field: NormalizableField,
): string | undefined => {
  const raw = (confirmed as Record<string, unknown>)[field];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
};

/** Serialise a confirmation for the `confirmed` jsonb column. */
export const confirmationToRecord = (confirmation: Confirmation): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const field of confirmation.fields) out[field.field] = field.value;
  // Which values the person changed is retained: it is the record that they were
  // shown a suggestion and disagreed with it.
  out['_edited'] = confirmation.fields.filter((field) => field.edited).map((field) => field.field);
  return out;
};

export const extractionToRecord = (outcome: ExtractionOutcome): Record<string, unknown> => ({
  source: outcome.source,
  suggestions: outcome.suggestions.map((suggestion) => ({
    field: suggestion.field,
    value: suggestion.value,
    confidence: suggestion.confidence,
    ...(suggestion.evidence === undefined ? {} : { evidence: suggestion.evidence }),
  })),
});

export const recordToExtraction = (record: Readonly<Record<string, unknown>>): ExtractionOutcome => {
  const source = record['source'];
  const raw = Array.isArray(record['suggestions']) ? (record['suggestions'] as unknown[]) : [];
  const suggestions: Suggestion[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const field = entry['field'];
    const value = entry['value'];
    if (typeof field !== 'string' || typeof value !== 'string') continue;
    if (!NORMALIZABLE_FIELDS.includes(field as NormalizableField)) continue;
    const evidence = entry['evidence'];
    suggestions.push({
      field: field as NormalizableField,
      value,
      confidence: typeof entry['confidence'] === 'number' ? entry['confidence'] : 0,
      ...(typeof evidence === 'string' ? { evidence } : {}),
    });
  }
  return {
    source: source === 'text' || source === 'voice' ? source : 'none',
    suggestions,
  };
};
