import { err, ok, type Result } from '../runtime/result.ts';
import { validationError, type EngineError } from '../runtime/errors.ts';
import type { EvidenceRef } from './proposal.ts';
import type { SignalLifecycleState } from './signal-lifecycle.ts';

/**
 * Phase 57 — cross-experience intelligence.
 *
 * Every proposal in phases 1–50 is about one subject. This is the first thing in the
 * product that says something spanning several: *this failure is recurring*, *these
 * two clusters describe one thing*, *the way this organization responds has changed*.
 *
 * **Evidence-backed, or not drawn.** A conclusion carries references to the rows
 * behind it, and it needs at least two distinct experiences — a "pattern" over one
 * account is that account with a bigger word attached. Refused at creation rather
 * than filtered at display, because a conclusion that exists is a conclusion
 * somebody will eventually surface.
 *
 * **It reads lifecycle state, and says so.** A conclusion drawn over an expired
 * signal is a statement about last year in the present tense. `lifecycleState`
 * travels with the conclusion and an expired one is refused outright, since the
 * honest version of it is "this used to happen", which is not what any consumer of
 * this would do with it.
 *
 * **It concludes; it does not act.** The output is a proposal, and the proposal is
 * subject to every rule Phase 40 and Phase 45 already impose — E12 cannot write to
 * E1–E11, and approval dispatches the target engine's own command.
 */
export type ConclusionKind =
  | 'recurring_failure'
  | 'clusters_describe_one_thing'
  | 'response_pattern_changed'
  | 'pattern_recovered';

export const CONCLUSION_KINDS: readonly ConclusionKind[] = [
  'recurring_failure',
  'clusters_describe_one_thing',
  'response_pattern_changed',
  'pattern_recovered',
];

/** Distinct experiences a conclusion must span before it is a conclusion at all. */
export const MINIMUM_EXPERIENCES = 2;
/** And distinct people, so six accounts from one author are not a pattern. */
export const MINIMUM_PEOPLE = 2;

export interface DrawConclusionInput {
  readonly kind: unknown;
  readonly subjectId: unknown;
  readonly acrossExperienceIds: unknown;
  readonly distinctPeople: unknown;
  readonly basis: unknown;
  readonly lifecycleState: SignalLifecycleState;
  readonly summary: unknown;
  readonly rationale: unknown;
  readonly confidence: unknown;
}

export interface Conclusion {
  readonly kind: ConclusionKind;
  /** The cluster, organization or entity the conclusion is about. */
  readonly subjectId: string;
  readonly acrossExperienceIds: readonly string[];
  readonly distinctPeople: number;
  /** Rows a reviewer can open. Never empty. */
  readonly basis: readonly EvidenceRef[];
  readonly lifecycleState: SignalLifecycleState;
  readonly summary: string;
  readonly rationale: string;
  readonly confidence: number;
}

const asIdList = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))];
};

const asRefs = (value: unknown): readonly EvidenceRef[] => {
  if (!Array.isArray(value)) return [];
  const kinds: readonly EvidenceRef['kind'][] = [
    'experience',
    'corroboration',
    'evidence',
    'cluster',
    'signal_snapshot',
    'risk_event',
  ];
  const out: EvidenceRef[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const kind = entry['kind'];
    const id = entry['id'];
    if (typeof kind !== 'string' || typeof id !== 'string' || id.length === 0) continue;
    if (!kinds.includes(kind as EvidenceRef['kind'])) continue;
    out.push({ kind: kind as EvidenceRef['kind'], id });
  }
  return out;
};

export const SUMMARY_MAX = 500;
export const RATIONALE_MAX = 2_000;

export const drawConclusion = (input: DrawConclusionInput): Result<Conclusion, EngineError> => {
  if (typeof input.kind !== 'string' || !(CONCLUSION_KINDS as readonly string[]).includes(input.kind)) {
    return err(validationError('unknown_conclusion_kind', 'that is not a conclusion this engine draws'));
  }
  if (typeof input.subjectId !== 'string' || input.subjectId.length === 0) {
    return err(validationError('missing_subject', 'a conclusion must name what it is about'));
  }

  const across = asIdList(input.acrossExperienceIds);
  if (across.length < MINIMUM_EXPERIENCES) {
    return err(
      validationError(
        'not_enough_experiences',
        `a cross-experience conclusion spans at least ${MINIMUM_EXPERIENCES} experiences`,
      ),
    );
  }

  const people = typeof input.distinctPeople === 'number' ? Math.trunc(input.distinctPeople) : 0;
  if (people < MINIMUM_PEOPLE) {
    // Six accounts from one author is one person's account of something, however many
    // rows it occupies. The same rule impact estimation already holds.
    return err(
      validationError('not_enough_people', `a pattern needs at least ${MINIMUM_PEOPLE} different people`),
    );
  }

  const basis = asRefs(input.basis);
  if (basis.length === 0) {
    return err(
      validationError(
        'basis_required',
        'a conclusion must point at rows a reviewer can open — one that cannot be checked is not drawn',
      ),
    );
  }

  if (input.lifecycleState === 'expired') {
    return err(
      validationError(
        'signal_expired',
        'this pattern has had no contribution inside the expiry window, so a present-tense conclusion about it would be wrong',
      ),
    );
  }

  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (summary.length === 0 || summary.length > SUMMARY_MAX) {
    return err(validationError('invalid_summary', `a summary is 1–${SUMMARY_MAX} characters`));
  }
  const rationale = typeof input.rationale === 'string' ? input.rationale.trim() : '';
  if (rationale.length === 0 || rationale.length > RATIONALE_MAX) {
    return err(validationError('invalid_rationale', `a rationale is 1–${RATIONALE_MAX} characters — say why`));
  }

  if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence)) {
    return err(validationError('invalid_confidence', 'confidence must be a number between 0 and 1'));
  }
  if (input.confidence < 0 || input.confidence > 1) {
    return err(validationError('confidence_out_of_range', 'confidence must be between 0 and 1'));
  }

  return ok({
    kind: input.kind as ConclusionKind,
    subjectId: input.subjectId,
    acrossExperienceIds: across,
    distinctPeople: people,
    basis,
    lifecycleState: input.lifecycleState,
    summary,
    rationale,
    confidence: input.confidence,
  });
};

/**
 * The deduplication key for a conclusion, and therefore for the recommendation it
 * becomes — Phase 58.
 *
 * Keyed on what the conclusion *is about*, not on when it was drawn: the kind, the
 * subject, and the set of experiences it spans. Sorted before joining so the same
 * conclusion reached by two different walks produces one key. The same finding
 * recommended twice teaches reviewers to dismiss recommendations, which is worse than
 * silence.
 */
export const conclusionKeyOf = (conclusion: Conclusion): string =>
  [conclusion.kind, conclusion.subjectId, [...conclusion.acrossExperienceIds].sort().join(',')].join('|');

/**
 * Deliberately absent: a conclusion that acts.
 *
 * There is no `apply`, no `enact`, no write of any kind here. A conclusion becomes a
 * proposal and a proposal is decided by a person; `undefined` so the absence is
 * assertable.
 */
export const enactConclusion = (): undefined => undefined;
