import type { EngineId, ProposalStatus } from '../src/domain/proposal.ts';

/**
 * Presentation of governed recommendations — the reviewer's side of E12.
 *
 * Pure, and in a `.ts` file rather than inside the component, for two reasons:
 * Node's type stripping does not run JSX, so this is the part a unit test can
 * reach; and the sentences here are the governance boundary in its user-visible
 * form. If a reviewer cannot tell "approved" from "approved and carried out", the
 * separation the engine enforces buys nothing.
 *
 * The two distinctions this module exists to keep visible:
 *
 *   1. **A decision is not an effect.** Approving records a decision; the target
 *      engine then runs its own command and may refuse. Both outcomes are said
 *      out loud, including the refusal, verbatim.
 *   2. **Confidence is the proposer's estimate, not a measure of truth.** It is
 *      never presented as a verdict, a score for a person, or a threshold that
 *      decides anything on its own.
 */
export type DecisionOutcome = 'approved' | 'rejected' | 'escalated';

export const DECISION_OUTCOMES: readonly DecisionOutcome[] = ['approved', 'rejected', 'escalated'];

/**
 * Engines named in plain words. A reviewer approving an action needs to know
 * which part of the system will carry it out, and "E4" tells them nothing.
 */
export const ENGINE_LABELS: Readonly<Record<EngineId, string>> = {
  E1: 'experiences',
  E2: 'structure',
  E3: 'matching',
  E4: 'signals',
  E5: 'evidence',
  E6: 'relations',
  E7: 'organizations',
  E8: 'resolution',
  E9: 'safety',
  E10: 'disputes',
  E11: 'responsiveness',
  E12: 'review',
};

export const engineLabel = (engine: EngineId): string => ENGINE_LABELS[engine];

/** Rejecting requires a reason; the domain refuses one without. Said up front. */
export const decisionNeedsNote = (outcome: DecisionOutcome): boolean => outcome === 'rejected';

export const DECISION_LABELS: Readonly<Record<DecisionOutcome, string>> = {
  approved: 'Approve',
  rejected: 'Reject',
  escalated: 'Escalate',
};

export interface EffectInputs {
  readonly status: ProposalStatus;
  readonly targetEngine: EngineId;
  /** Absent when the recommendation is advice with no action attached. */
  readonly proposedCommand?: string | undefined;
  readonly dispatched?: boolean | undefined;
  readonly dispatchError?: string | undefined;
}

/**
 * What actually happened, in one sentence a reviewer can act on.
 *
 * The case that matters most is the fourth: approved, dispatched, refused. A
 * surface that showed only "Approved" there would tell a reviewer the action is
 * done when the governed engine declined it — the exact conflation the engine
 * takes care to record separately.
 */
export const describeEffect = (inputs: EffectInputs): string => {
  const target = engineLabel(inputs.targetEngine);

  switch (inputs.status) {
    case 'proposed':
      return 'Awaiting a decision. Nothing has been applied.';
    case 'escalated':
      return 'Escalated for another reviewer. Still awaiting a decision — nothing has been applied.';
    case 'rejected':
      return 'Rejected. Nothing was applied.';
    case 'expired':
      return 'Expired without a decision. Nothing was applied.';
    case 'approved':
      if (inputs.proposedCommand === undefined || inputs.proposedCommand.length === 0) {
        return 'Approved as advice. It named no action, so nothing was applied.';
      }
      if (inputs.dispatchError !== undefined && inputs.dispatchError.length > 0) {
        return `Approved, but ${target} refused it: ${inputs.dispatchError}. Nothing was applied.`;
      }
      if (inputs.dispatched === true) {
        return `Approved, and ${target} carried it out.`;
      }
      return `Approved. ${target} has not carried it out.`;
  }
};

/** Whether a reviewer can still decide this one. */
export const isDecidable = (status: ProposalStatus): boolean =>
  status === 'proposed' || status === 'escalated';

/**
 * Confidence as a sentence rather than a bare number, because a bare number in a
 * decision surface reads as authority. It is the proposer's own estimate of its
 * own suggestion and it decides nothing.
 */
export const describeConfidence = (confidence: number): string => {
  const clamped = Math.min(1, Math.max(0, confidence));
  return `${Math.round(clamped * 100)}% — the proposer's own estimate, not a finding`;
};
