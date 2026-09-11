import { err, ok, type Result } from '../runtime/result.ts';
import { preconditionError, validationError, type EngineError } from '../runtime/errors.ts';
import { checkNote, REVIEW_NOTE_MAX_LENGTH } from './types.ts';

/**
 * Organization case management — Phase 35, E9.
 *
 * A case is the organization's **own workspace** over an experience. It exists so
 * staff can work a queue instead of re-reading a list, and it confers no authority
 * whatsoever over the experience it refers to.
 *
 * That boundary is the reason this is a separate table with a separate state machine
 * rather than columns on `experiences`. Closing a case resolves nothing. Its states
 * are about the organization's work — *have we looked at this, who has it, are we
 * done with our part* — and the experience's outcome remains where the people it
 * happened to put it.
 *
 * The failure this prevents is a real one and easy to reach by accident: an
 * organization marking its case `closed` and a surface reading that as "resolved". So
 * the vocabulary is deliberately different from resolution's — `closed`, never
 * `resolved` — and `closureIsNotResolution` exists to be asserted in a test.
 */
export type CaseState = 'new' | 'triaged' | 'in_progress' | 'awaiting_customer' | 'closed';

export const CASE_STATES: readonly CaseState[] = [
  'new',
  'triaged',
  'in_progress',
  'awaiting_customer',
  'closed',
];

const TRANSITIONS: Readonly<Record<CaseState, readonly CaseState[]>> = {
  new: ['triaged', 'in_progress', 'closed'],
  triaged: ['in_progress', 'awaiting_customer', 'closed'],
  in_progress: ['awaiting_customer', 'triaged', 'closed'],
  awaiting_customer: ['in_progress', 'closed'],
  // A closed case reopens: the experience can be reopened or disputed at any time,
  // and the organization's workspace has to be able to follow it back.
  closed: ['in_progress'],
};

export const canTransitionCase = (from: CaseState, to: CaseState): boolean =>
  (TRANSITIONS[from] ?? []).includes(to);

export interface OrganizationCase {
  readonly id: string;
  readonly organizationId: string;
  readonly experienceId: string;
  readonly state: CaseState;
  /** An organization member. Unassigned is a legitimate, common state. */
  readonly assigneeId?: string;
  readonly openedAt: number;
  readonly updatedAt: number;
  readonly closedAt?: number;
  /** Why it was closed, in the organization's own words. Required to close. */
  readonly closureNote?: string;
  readonly correlationId: string;
}

export const createCase = (
  input: { organizationId: string; experienceId: string },
  meta: { id: string; correlationId: string; now: number },
): Result<OrganizationCase, EngineError> => {
  if (input.organizationId.length === 0 || input.experienceId.length === 0) {
    return err(validationError('missing_reference', 'a case needs an organization and an experience'));
  }
  return ok({
    id: meta.id,
    organizationId: input.organizationId,
    experienceId: input.experienceId,
    state: 'new',
    openedAt: meta.now,
    updatedAt: meta.now,
    correlationId: meta.correlationId,
  });
};

export interface TransitionCaseInput {
  readonly to: CaseState;
  readonly note?: string;
}

export const transitionCase = (
  current: OrganizationCase,
  input: TransitionCaseInput,
  now: number,
): Result<OrganizationCase, EngineError> => {
  if (!(CASE_STATES as readonly string[]).includes(input.to)) {
    return err(validationError('unknown_case_state', 'that is not a case state'));
  }
  if (current.state === input.to) {
    // Idempotent rather than an error: two staff clicking the same button is not a
    // conflict worth surfacing to either of them.
    return ok(current);
  }
  if (!canTransitionCase(current.state, input.to)) {
    return err(
      preconditionError('case_transition_invalid', `a ${current.state} case cannot become ${input.to}`, {
        from: current.state,
        to: input.to,
      }),
    );
  }
  // Closing requires saying why. A case closed with no account of what was done
  // leaves the person it happened to nothing to read.
  const note = checkNote(input.note);
  if (!note.ok) {
    return err(
      note.code === 'note_not_text'
        ? validationError('note_not_text', 'a closure note is text')
        : validationError('note_too_long', `a closure note is at most ${REVIEW_NOTE_MAX_LENGTH} characters`),
    );
  }
  if (input.to === 'closed' && note.note.length === 0) {
    return err(validationError('closure_note_required', 'say what was done before closing the case'));
  }

  // Reopening drops the closure fields rather than setting them to undefined:
  // `exactOptionalPropertyTypes` treats an explicitly-undefined key as present, and a
  // row carrying `closedAt: undefined` reads differently through the store than one
  // that never had the column set.
  const { closedAt: _closedAt, closureNote: _closureNote, ...withoutClosure } = current;
  return ok({
    ...withoutClosure,
    state: input.to,
    updatedAt: now,
    ...(input.to === 'closed' ? { closedAt: now, closureNote: note.note } : {}),
  });
};

export const assignCase = (
  current: OrganizationCase,
  assigneeId: string | undefined,
  now: number,
): Result<OrganizationCase, EngineError> => {
  if (assigneeId !== undefined && assigneeId.length === 0) {
    return err(validationError('invalid_assignee', 'that is not a member'));
  }
  // Unassigning removes the key, for the same reason as above.
  const { assigneeId: _current, ...withoutAssignee } = current;
  return ok({
    ...withoutAssignee,
    ...(assigneeId === undefined ? {} : { assigneeId }),
    updatedAt: now,
  });
};

/**
 * The boundary, as an assertable fact.
 *
 * A case state never maps to a resolution status. This function is the only place
 * that could reasonably have provided such a mapping, and it refuses — so a test can
 * pin the rule instead of a comment hoping to be read.
 */
export const closureIsNotResolution = (): undefined => undefined;

export const CASE_STATE_LABELS: Readonly<Record<CaseState, string>> = {
  new: 'New',
  triaged: 'Triaged',
  in_progress: 'Being worked on',
  awaiting_customer: 'Waiting on the customer',
  closed: 'Closed by the organization',
};
