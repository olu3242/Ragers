import { err, ok, type Result } from '../runtime/result.ts';
import { preconditionError, validationError, type EngineError } from '../runtime/errors.ts';

/**
 * Relate — E6.
 *
 * ## Why this is not the existing `same` reaction, and not corroboration
 *
 * The canonical Relate contract is *an assertion that two experiences are the same
 * or related occurrence*. Checked against what already exists:
 *
 *   * **`same` reaction** — "I recognise this". One actor, one experience, no
 *     second experience anywhere in the row. It cannot express a link, so it
 *     cannot satisfy Relate.
 *   * **corroboration** — "this happened to me too". One actor, one experience,
 *     and it is a claim about the *actor's own* experience. Relate can be asserted
 *     by somebody who experienced neither, so the semantics are not equivalent and
 *     reusing corroboration would inflate a count of people by people who never
 *     claimed anything.
 *
 * So Relate is the smallest genuinely missing thing: an actor-asserted edge
 * between two experiences.
 *
 * ## The rule that shapes it
 *
 * Relating cannot manufacture trust or confidence. It carries no weight in
 * corroboration counts, unique-experiencer counts, or any trust confidence — it is
 * a discovery and clustering input only. Anyone can relate anything; that is
 * exactly why it must never be worth anything on its own.
 */
export type RelationAssertion = 'same_occurrence' | 'same_pattern' | 'related_context';

export const RELATION_ASSERTIONS: readonly RelationAssertion[] = [
  'same_occurrence',
  'same_pattern',
  'related_context',
];

export type RelationStatus = 'active' | 'retracted' | 'removed';

export const NOTE_MAX_LENGTH = 500;

export interface ExperienceRelation {
  readonly id: string;
  readonly fromExperienceId: string;
  readonly toExperienceId: string;
  readonly assertedBy: string;
  readonly assertion: RelationAssertion;
  readonly note?: string;
  readonly status: RelationStatus;
  readonly retractedAt?: number | undefined;
  readonly correlationId: string;
  readonly createdAt: number;
}

/**
 * Canonical ordering for the pair.
 *
 * Relating A to B and B to A is one assertion. Without canonicalising, the same
 * person could assert both directions and the pair would look twice as connected
 * as one person thinks it is.
 */
export const canonicalPair = (left: string, right: string): { from: string; to: string } =>
  left <= right ? { from: left, to: right } : { from: right, to: left };

/** The natural key, so the store arbitrates uniqueness rather than a read. */
export const relationKey = (left: string, right: string, actorId: string): string => {
  const pair = canonicalPair(left, right);
  return `${pair.from}:${pair.to}:${actorId}`;
};

export interface CreateRelationInput {
  readonly fromExperienceId: string;
  readonly toExperienceId: string;
  readonly assertedBy: string;
  readonly assertion?: unknown;
  readonly note?: unknown;
  /** Publication state of both experiences, checked by the caller. */
  readonly bothPublished: boolean;
}

export const createRelation = (
  input: CreateRelationInput,
  meta: { id: string; correlationId: string; now: number },
): Result<ExperienceRelation, EngineError> => {
  if (input.fromExperienceId === input.toExperienceId) {
    return err(validationError('cannot_relate_to_itself', 'an experience cannot be related to itself'));
  }
  if (!input.bothPublished) {
    return err(
      preconditionError('experience_not_published', 'both experiences must be published to be related'),
    );
  }

  const assertion = input.assertion ?? 'same_pattern';
  if (typeof assertion !== 'string' || !RELATION_ASSERTIONS.includes(assertion as RelationAssertion)) {
    return err(validationError('invalid_assertion', 'a relation is the same occurrence, the same pattern, or related context'));
  }

  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > NOTE_MAX_LENGTH) {
    return err(validationError('note_too_long', `a note must be at most ${NOTE_MAX_LENGTH} characters`));
  }

  const pair = canonicalPair(input.fromExperienceId, input.toExperienceId);
  return ok({
    id: meta.id,
    fromExperienceId: pair.from,
    toExperienceId: pair.to,
    assertedBy: input.assertedBy,
    assertion: assertion as RelationAssertion,
    ...(note.length === 0 ? {} : { note }),
    status: 'active',
    retractedAt: undefined,
    correlationId: meta.correlationId,
    createdAt: meta.now,
  });
};

/** Retraction keeps the row, exactly as a corroboration retraction does. */
export const retractRelation = (
  relation: ExperienceRelation,
  actorId: string,
  now: number,
): Result<ExperienceRelation, EngineError> => {
  if (relation.assertedBy !== actorId) {
    return err(preconditionError('not_your_relation', 'only the person who asserted a relation can retract it'));
  }
  if (relation.status === 'retracted') return ok(relation);
  if (relation.status === 'removed') {
    return err(preconditionError('already_removed', 'a removed relation cannot be retracted'));
  }
  return ok({ ...relation, status: 'retracted', retractedAt: now });
};

/**
 * How much weight a set of relations carries in trust or confidence.
 *
 * Zero. Stated as a function so the rule is executable and a test can hold it:
 * if this ever returns anything else, relating becomes a way to buy credibility.
 */
export const trustWeightOfRelations = (_relations: readonly ExperienceRelation[]): 0 => 0;

/**
 * Distinct people asserting a pair, which is a discovery signal and nothing more.
 * Reported separately from any count of people who experienced something.
 */
export const distinctAsserters = (relations: readonly ExperienceRelation[]): number =>
  new Set(relations.filter((relation) => relation.status === 'active').map((relation) => relation.assertedBy)).size;
