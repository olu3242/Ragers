import { err, ok, type Result } from '../runtime/result.ts';
import { preconditionError, validationError, type EngineError } from '../runtime/errors.ts';

/**
 * Formal dispute — E10.
 *
 * A dispute is its own object, and the reason it has to be is the set of things
 * `resolution_status = 'disputed'` cannot express: who raised it, on what grounds,
 * with what evidence, whether it was withdrawn — and, decisively, that the party
 * being disputed cannot close it.
 *
 * Three distinctions this module exists to keep apart:
 *
 *   * **rejecting a proposed fix** is a resolution report (`still_unresolved`): a
 *     statement that the problem persists.
 *   * **disputing** is a claim that an *account* is untrue.
 *   * neither is `unresolved`, and neither is `resolved`.
 *
 * Both directions are legitimate. A consumer disputes an organization's account of
 * events; an organization disputes an experience. They are different acts with
 * different reasons, and the type records which.
 */
export type DisputeStatus = 'open' | 'under_review' | 'upheld' | 'declined' | 'withdrawn';

export const DISPUTE_STATUSES: readonly DisputeStatus[] = [
  'open',
  'under_review',
  'upheld',
  'declined',
  'withdrawn',
];

export type DisputeOrigin = 'experiencer' | 'organization';

export type DisputeReason =
  | 'account_inaccurate'
  | 'not_our_organization'
  | 'already_resolved'
  | 'fix_not_delivered'
  | 'response_misleading'
  | 'wrong_entity'
  | 'other';

export const DISPUTE_REASONS: readonly DisputeReason[] = [
  'account_inaccurate',
  'not_our_organization',
  'already_resolved',
  'fix_not_delivered',
  'response_misleading',
  'wrong_entity',
  'other',
];

/**
 * Reasons only one side can legitimately raise.
 *
 * An organization cannot claim a fix was not delivered to it, and a consumer
 * cannot claim an experience is about the wrong entity *as the entity*. Enforcing
 * this keeps the reason field meaningful rather than a free-form label.
 */
const REASONS_BY_ORIGIN: Readonly<Record<DisputeOrigin, readonly DisputeReason[]>> = {
  experiencer: ['account_inaccurate', 'fix_not_delivered', 'response_misleading', 'other'],
  organization: ['account_inaccurate', 'not_our_organization', 'already_resolved', 'wrong_entity', 'other'],
};

export const DETAIL_MAX_LENGTH = 2_000;

export interface Dispute {
  readonly id: string;
  readonly experienceId: string;
  readonly responseId?: string;
  readonly origin: DisputeOrigin;
  readonly raisedBy: string;
  readonly organizationId?: string;
  readonly reason: DisputeReason;
  readonly detail?: string;
  readonly status: DisputeStatus;
  readonly reviewedBy?: string;
  readonly reviewedAt?: number;
  readonly reviewNote?: string;
  readonly withdrawnAt?: number | undefined;
  readonly resolutionEventId?: string;
  readonly correlationId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Transitions.
 *
 * `open → withdrawn` is the raiser's own right. `open|under_review →
 * upheld|declined` is an operator decision. Nothing transitions out of a settled
 * state: a new grievance is a new dispute, so the history of what was contested
 * and how it went stays intact.
 */
const TRANSITIONS: Readonly<Record<DisputeStatus, readonly DisputeStatus[]>> = {
  open: ['under_review', 'upheld', 'declined', 'withdrawn'],
  under_review: ['upheld', 'declined', 'withdrawn'],
  upheld: [],
  declined: [],
  withdrawn: [],
};

export const canTransitionDispute = (from: DisputeStatus, to: DisputeStatus): boolean =>
  (TRANSITIONS[from] ?? []).includes(to);

export const isDisputeSettled = (status: DisputeStatus): boolean =>
  status === 'upheld' || status === 'declined' || status === 'withdrawn';

export interface OpenDisputeInput {
  readonly experienceId: string;
  readonly responseId?: string;
  readonly origin: DisputeOrigin;
  readonly raisedBy: string;
  readonly organizationId?: string;
  readonly reason: unknown;
  readonly detail?: unknown;
}

export const openDispute = (
  input: OpenDisputeInput,
  meta: { id: string; correlationId: string; now: number },
): Result<Dispute, EngineError> => {
  if (typeof input.reason !== 'string' || !DISPUTE_REASONS.includes(input.reason as DisputeReason)) {
    return err(validationError('invalid_dispute_reason', 'that is not a supported dispute reason'));
  }
  const reason = input.reason as DisputeReason;

  if (!REASONS_BY_ORIGIN[input.origin].includes(reason)) {
    return err(
      validationError('reason_not_available_to_origin', `a ${input.origin} cannot raise "${reason}"`, {
        origin: input.origin,
        reason,
        available: REASONS_BY_ORIGIN[input.origin],
      }),
    );
  }

  if (input.origin === 'organization' && !input.organizationId) {
    return err(validationError('organization_required', 'an organization dispute must name the organization'));
  }
  if (input.origin === 'experiencer' && input.organizationId) {
    return err(validationError('organization_not_permitted', 'an experiencer disputes as themselves'));
  }

  const detail = typeof input.detail === 'string' ? input.detail.trim() : '';
  if (detail.length > DETAIL_MAX_LENGTH) {
    return err(validationError('detail_too_long', `detail must be at most ${DETAIL_MAX_LENGTH} characters`));
  }
  // `other` without an explanation is unreviewable, so it is refused rather than
  // accepted and left for a moderator to guess at.
  if (reason === 'other' && detail.length === 0) {
    return err(validationError('detail_required', 'say what is disputed when the reason is "other"'));
  }

  return ok({
    id: meta.id,
    experienceId: input.experienceId,
    ...(input.responseId === undefined ? {} : { responseId: input.responseId }),
    origin: input.origin,
    raisedBy: input.raisedBy,
    ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
    reason,
    ...(detail.length === 0 ? {} : { detail }),
    status: 'open',
    withdrawnAt: undefined,
    correlationId: meta.correlationId,
    createdAt: meta.now,
    updatedAt: meta.now,
  });
};

/** Withdrawal, by the raiser and nobody else. Idempotent. */
export const withdrawDispute = (
  dispute: Dispute,
  actorId: string,
  now: number,
): Result<Dispute, EngineError> => {
  if (dispute.raisedBy !== actorId) {
    return err(preconditionError('not_your_dispute', 'only the person who raised a dispute can withdraw it'));
  }
  if (dispute.status === 'withdrawn') return ok(dispute);
  if (!canTransitionDispute(dispute.status, 'withdrawn')) {
    return err(
      preconditionError('dispute_already_settled', 'that dispute has already been decided', {
        status: dispute.status,
      }),
    );
  }
  return ok({ ...dispute, status: 'withdrawn', withdrawnAt: now, updatedAt: now });
};

export interface ReviewDisputeInput {
  readonly to: DisputeStatus;
  readonly reviewerId: string;
  readonly note?: string;
}

/**
 * Operator review.
 *
 * The absolute rule: **the disputed party cannot decide it.** An organization
 * being disputed has no path here, and neither does the raiser — upholding your
 * own dispute would make the mechanism worthless. Only an operator, and the
 * decision is attributed.
 */
export const reviewDispute = (
  dispute: Dispute,
  input: ReviewDisputeInput,
  now: number,
): Result<Dispute, EngineError> => {
  if (input.to !== 'upheld' && input.to !== 'declined' && input.to !== 'under_review') {
    return err(validationError('invalid_review_outcome', 'a review upholds, declines, or takes it under review'));
  }
  if (input.reviewerId === dispute.raisedBy) {
    return err(
      preconditionError('cannot_review_own_dispute', 'you cannot decide a dispute you raised'),
    );
  }
  if (!canTransitionDispute(dispute.status, input.to)) {
    return err(
      preconditionError('illegal_dispute_transition', `cannot move a ${dispute.status} dispute to ${input.to}`, {
        from: dispute.status,
        to: input.to,
      }),
    );
  }

  // `under_review` is a holding state, so it is not a reviewed decision and must
  // not be dated as one.
  if (input.to === 'under_review') {
    return ok({ ...dispute, status: 'under_review', updatedAt: now });
  }

  return ok({
    ...dispute,
    status: input.to,
    reviewedBy: input.reviewerId,
    reviewedAt: now,
    ...(input.note === undefined || input.note.trim().length === 0 ? {} : { reviewNote: input.note.trim() }),
    updatedAt: now,
  });
};

/**
 * Whether an experience is contested right now.
 *
 * Only live disputes count. A withdrawn or declined one is history, and showing an
 * experience as contested forever because somebody once objected would let a
 * single filing permanently shade an account.
 */
export const isContested = (disputes: readonly Dispute[]): boolean =>
  disputes.some((dispute) => dispute.status === 'open' || dispute.status === 'under_review');
