import { err, ok, type Result } from '../runtime/result.ts';
import { preconditionError, validationError, type EngineError } from '../runtime/errors.ts';

/**
 * Intelligence proposals — E12.
 *
 * The boundary this module exists to hold: **a proposal carries no authority.**
 *
 * Approving one does not write to any E1–E11 table. It dispatches the *target
 * engine's own command*, through the same command bus, the same policy matrix and
 * the same transactional outbox as any other write — so an approved proposal is
 * subject to every check that a human doing the same thing would face, and fails
 * the same way. There is deliberately no column anywhere that a proposal can set
 * directly.
 *
 * The practical consequence, which is the point: a proposal to remove content
 * still has to satisfy `moderation.action`, including its rule that a moderator
 * cannot act on their own content. Approval is not a bypass.
 */
export type ProposalStatus = 'proposed' | 'approved' | 'rejected' | 'escalated' | 'expired';

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  'proposed',
  'approved',
  'rejected',
  'escalated',
  'expired',
];

/** The twelve engines, as the only permitted source and target. */
export type EngineId =
  | 'E1'
  | 'E2'
  | 'E3'
  | 'E4'
  | 'E5'
  | 'E6'
  | 'E7'
  | 'E8'
  | 'E9'
  | 'E10'
  | 'E11'
  | 'E12';

export const ENGINE_IDS: readonly EngineId[] = [
  'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11', 'E12',
];

export const SUMMARY_MAX_LENGTH = 500;
export const RATIONALE_MAX_LENGTH = 2_000;

export interface EvidenceRef {
  /** The kind of durable row a reviewer can open. Never inline content. */
  readonly kind: 'experience' | 'corroboration' | 'evidence' | 'cluster' | 'signal_snapshot' | 'risk_event';
  readonly id: string;
}

export interface IntelligenceProposal {
  readonly id: string;
  readonly proposalType: string;
  readonly sourceEngine: EngineId;
  readonly targetEngine: EngineId;
  readonly subjectId: string;
  readonly summary: string;
  readonly rationale: string;
  readonly confidence: number;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly status: ProposalStatus;
  /** The command the target engine would run. Recorded up front. */
  readonly proposedCommand?: string;
  readonly proposedInput: Readonly<Record<string, unknown>>;
  readonly reviewedAt?: number;
  readonly reviewedBy?: string;
  readonly reviewNote?: string;
  readonly dispatchedAt?: number;
  readonly dispatchError?: string;
  readonly expiresAt?: number;
  readonly correlationId: string;
  readonly createdAt: number;
}

const TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  // Escalation is not a decision: an escalated proposal is still awaiting one, so
  // it can still be approved or rejected afterwards.
  proposed: ['approved', 'rejected', 'escalated', 'expired'],
  escalated: ['approved', 'rejected', 'expired'],
  approved: [],
  rejected: [],
  expired: [],
};

export const canTransitionProposal = (from: ProposalStatus, to: ProposalStatus): boolean =>
  (TRANSITIONS[from] ?? []).includes(to);

/**
 * A proposal must be *checkable*: it needs a rationale and at least one reference
 * to a durable row. A recommendation with no traceable basis is a assertion
 * dressed as analysis, and it is refused at creation rather than shown.
 */
export interface CreateProposalInput {
  readonly proposalType: unknown;
  readonly sourceEngine: unknown;
  readonly targetEngine: unknown;
  readonly subjectId: unknown;
  readonly summary: unknown;
  readonly rationale: unknown;
  readonly confidence: unknown;
  readonly evidenceRefs?: unknown;
  readonly proposedCommand?: unknown;
  readonly proposedInput?: unknown;
  readonly expiresAt?: unknown;
}

const isEngine = (value: unknown): value is EngineId =>
  typeof value === 'string' && (ENGINE_IDS as readonly string[]).includes(value);

const parseRefs = (value: unknown): readonly EvidenceRef[] => {
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

export const createProposal = (
  input: CreateProposalInput,
  meta: { id: string; correlationId: string; now: number },
): Result<IntelligenceProposal, EngineError> => {
  if (typeof input.proposalType !== 'string' || input.proposalType.trim().length === 0) {
    return err(validationError('missing_proposal_type', 'a proposal must say what it is proposing'));
  }
  if (!isEngine(input.sourceEngine) || !isEngine(input.targetEngine)) {
    return err(validationError('invalid_engine', 'source and target must be one of E1–E12'));
  }
  // E12 proposing to itself would be a closed loop with no governed engine in it.
  if (input.targetEngine === 'E12') {
    return err(
      validationError('target_cannot_be_intelligence', 'a proposal must target a governed engine, not the proposer'),
    );
  }
  if (typeof input.subjectId !== 'string' || input.subjectId.length === 0) {
    return err(validationError('missing_subject', 'a proposal must name what it is about'));
  }

  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (summary.length === 0 || summary.length > SUMMARY_MAX_LENGTH) {
    return err(validationError('invalid_summary', `a summary is 1–${SUMMARY_MAX_LENGTH} characters`));
  }

  const rationale = typeof input.rationale === 'string' ? input.rationale.trim() : '';
  if (rationale.length === 0 || rationale.length > RATIONALE_MAX_LENGTH) {
    return err(
      validationError('invalid_rationale', `a rationale is 1–${RATIONALE_MAX_LENGTH} characters — say why`),
    );
  }

  if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence)) {
    return err(validationError('invalid_confidence', 'confidence must be a number between 0 and 1'));
  }
  if (input.confidence < 0 || input.confidence > 1) {
    return err(validationError('confidence_out_of_range', 'confidence must be between 0 and 1'));
  }

  const evidenceRefs = parseRefs(input.evidenceRefs);
  if (evidenceRefs.length === 0) {
    return err(
      validationError(
        'evidence_required',
        'a recommendation must point at rows a reviewer can open — an untraceable proposal is not shown',
      ),
    );
  }

  const proposedInput =
    typeof input.proposedInput === 'object' && input.proposedInput !== null
      ? (input.proposedInput as Record<string, unknown>)
      : {};

  return ok({
    id: meta.id,
    proposalType: input.proposalType.trim(),
    sourceEngine: input.sourceEngine,
    targetEngine: input.targetEngine,
    subjectId: input.subjectId,
    summary,
    rationale,
    confidence: Number(input.confidence.toFixed(3)),
    evidenceRefs,
    status: 'proposed',
    ...(typeof input.proposedCommand === 'string' && input.proposedCommand.length > 0
      ? { proposedCommand: input.proposedCommand }
      : {}),
    proposedInput,
    ...(typeof input.expiresAt === 'number' ? { expiresAt: input.expiresAt } : {}),
    correlationId: meta.correlationId,
    createdAt: meta.now,
  });
};

export interface DecideProposalInput {
  readonly to: ProposalStatus;
  readonly reviewerId: string;
  readonly note?: string;
}

/**
 * Record a decision on a proposal.
 *
 * This changes the proposal and nothing else. Whether the approved action actually
 * happens is decided by the target engine afterwards, and `dispatchedAt` /
 * `dispatchError` record which — so an approval whose command was refused
 * downstream is visibly distinct from one that took effect. Marking it approved and
 * assuming the effect followed is exactly the conflation this separation prevents.
 */
export const decideProposal = (
  proposal: IntelligenceProposal,
  input: DecideProposalInput,
  now: number,
): Result<IntelligenceProposal, EngineError> => {
  if (input.to !== 'approved' && input.to !== 'rejected' && input.to !== 'escalated') {
    return err(validationError('invalid_decision', 'a decision approves, rejects, or escalates'));
  }
  if (!canTransitionProposal(proposal.status, input.to)) {
    return err(
      preconditionError('proposal_already_decided', `a ${proposal.status} proposal cannot be ${input.to}`, {
        from: proposal.status,
        to: input.to,
      }),
    );
  }
  // Rejecting requires saying why. An unexplained rejection teaches the proposing
  // engine nothing and leaves the subject with no account of what happened.
  if (input.to === 'rejected' && (input.note === undefined || input.note.trim().length === 0)) {
    return err(validationError('note_required', 'say why the proposal was rejected'));
  }

  return ok({
    ...proposal,
    status: input.to,
    reviewedBy: input.reviewerId,
    reviewedAt: now,
    ...(input.note === undefined || input.note.trim().length === 0 ? {} : { reviewNote: input.note.trim() }),
  });
};

/** Expiry is time passing, not a decision, so it is unattributed. */
export const expireProposal = (
  proposal: IntelligenceProposal,
  now: number,
): Result<IntelligenceProposal, EngineError> => {
  if (proposal.status === 'expired') return ok(proposal);
  if (!canTransitionProposal(proposal.status, 'expired')) {
    return err(preconditionError('proposal_already_decided', 'a decided proposal does not expire'));
  }
  if (proposal.expiresAt === undefined || proposal.expiresAt > now) {
    return err(preconditionError('not_yet_expired', 'that proposal has not expired'));
  }
  return ok({ ...proposal, status: 'expired' });
};

export const isProposalOpen = (status: ProposalStatus): boolean =>
  status === 'proposed' || status === 'escalated';
