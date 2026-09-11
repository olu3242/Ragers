import { err, ok, type Result } from '../runtime/result.ts';
import { validationError, type EngineError } from '../runtime/errors.ts';

/**
 * Human override — Phase 94.
 *
 * Every fail-closed path in this codebase refuses correctly, and until now **none of them could
 * be made to refuse on purpose.** That is the gap this phase closes, and it is an operator-safety
 * gap rather than a correctness one: when something is going wrong at three in the morning, the
 * question is not whether the system is correct. It is whether a person can stop it.
 *
 * ## Five properties, and each one is a way this could be built wrong
 *
 * **Server-side.** A control enforced by not rendering a button is not a control. Each of these
 * is a row, read by the engine on the path it governs, so a direct API call is refused the same
 * way the UI is.
 *
 * **Governed.** Each is a command through the bus, so it faces the policy matrix and writes an
 * audit row like everything else. A kill switch outside the governance model would be the one
 * unaudited action in a codebase whose Phase 68 rule exists precisely to prevent that.
 *
 * **Scoped.** A control names what it applies to. "Pause the agents" is not a thing anybody
 * should be able to do in one keystroke without naming which, because the blast radius of a
 * mistake at that moment is the whole intelligence layer.
 *
 * **Reversible.** `resume` releases a control and restores exactly what it removed. Nothing here
 * deletes or rewrites anything, so resuming cannot fail to undo.
 *
 * **Audited.** Both directions. Who paused it and who resumed it are both decisions taken under
 * authority about somebody else's work, which is clause one of the Phase 68 rule.
 *
 * ## Why all six require `admin`
 *
 * An override is by definition outside the normal path, and the normal path already has
 * moderator-level actions for the things a moderator should do. A moderator who needs an agent
 * paused is describing an incident, and an incident should reach the person who can also see the
 * audit trail. This is a deliberate narrowing rather than an oversight — noted because
 * `refuse_pending_action` in particular reads like moderation work.
 */

/** What can be controlled. Each names a real mechanism rather than a category. */
export type ControlKind =
  /** Refuse everything one agent tries, at the engine. */
  | 'pause_agent'
  /** Refuse one proposal type from every agent that can produce it. */
  | 'disable_proposal_type'
  /** Refuse one pending proposal or plan, by id, without deciding it. */
  | 'refuse_pending_action'
  /** Stop calling one outbound provider or webhook. */
  | 'suspend_integration'
  /** Report degraded regardless of what the health registry says. */
  | 'force_degraded_mode';

export const CONTROL_KINDS: readonly ControlKind[] = [
  'pause_agent',
  'disable_proposal_type',
  'refuse_pending_action',
  'suspend_integration',
  'force_degraded_mode',
];

/**
 * What each control refuses, in words, for the operator surface and for the audit row.
 *
 * Stated per kind rather than generated, because the point of an override is that the person
 * using it knows what it does before they use it — and a generic "this control is active" tells
 * them nothing at the moment they most need to be sure.
 */
export const CONTROL_CONSEQUENCES: Readonly<Record<ControlKind, string>> = {
  pause_agent:
    'Every proposal from this agent is refused at the engine. Its existing proposals stand and can still be decided.',
  disable_proposal_type:
    'No agent may produce this proposal type. Proposals of this type already created stand and can still be decided.',
  refuse_pending_action:
    'This proposal or plan cannot be approved or executed. It is not decided, rejected or deleted — it is held.',
  suspend_integration:
    'Nothing is sent to this provider. Outbound work queues rather than failing, and the dependency reports unavailable.',
  force_degraded_mode:
    'The operational state reads degraded whatever the dependencies say. No refusal changes; the reading does.',
};

/**
 * A control's scope: what it applies to.
 *
 * Always a specific thing. There is no `'all'` and no wildcard — see the class comment. The one
 * kind with a naturally global scope is `force_degraded_mode`, and it names the reason rather
 * than a target, so the row still says what it is about.
 */
export interface ControlScope {
  readonly kind: ControlKind;
  /**
   * The agent id, proposal type, proposal or plan id, or integration name. For
   * `force_degraded_mode` this is the literal `'runtime'` — a placeholder that keeps the column
   * non-null rather than a wildcard, because a nullable scope is the shape a wildcard sneaks in
   * as later.
   */
  readonly target: string;
}

export interface OperatorControl extends ControlScope {
  readonly id: string;
  readonly active: boolean;
  /**
   * Why, in the operator's own words.
   *
   * Unlike Phase 87's recommendation memory, free text belongs here: this is a record of an
   * operator's decision about a *system component*, not a judgement about a person. The next
   * operator's first question is "why is this paused", and a control with no reason is a control
   * nobody dares release.
   */
  readonly reason: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly releasedBy?: string;
  readonly releasedAt?: number;
}

/** The deterministic id, so the same control cannot be applied twice concurrently. */
export const controlKeyOf = (scope: ControlScope): string => `${scope.kind}:${scope.target}`;

export const MAX_REASON_LENGTH = 500;

export const validateControl = (
  scope: ControlScope,
  reason: string,
): Result<true, EngineError> => {
  if (!(CONTROL_KINDS as readonly string[]).includes(scope.kind)) {
    return err(validationError('unknown_control_kind', 'that is not a control this system offers'));
  }
  if (typeof scope.target !== 'string' || scope.target.trim().length === 0) {
    return err(
      validationError('control_needs_a_target', 'a control names what it applies to; there is no wildcard'),
    );
  }
  // A wildcard by another name. Refused explicitly so that somebody reaching for one gets told
  // why rather than discovering the control silently applies to nothing.
  if (['*', 'all', 'any', 'everything'].includes(scope.target.trim().toLowerCase())) {
    return err(
      validationError(
        'control_needs_a_target',
        'there is no wildcard scope: name the agent, type, id or integration',
      ),
    );
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return err(
      validationError('control_needs_a_reason', 'a control with no reason is a control nobody dares release'),
    );
  }
  if (reason.length > MAX_REASON_LENGTH) {
    return err(validationError('reason_too_long', `a reason is at most ${MAX_REASON_LENGTH} characters`));
  }
  return ok(true);
};

/**
 * The absences, as code.
 *
 * `controlCanDeleteData` — no control removes anything. Every one of them refuses a *future*
 * action, so releasing it restores the prior state exactly. A control that deleted would be
 * irreversible, and an irreversible kill switch is one nobody uses in time.
 *
 * `controlAppliesWithoutAnAudit` — false, because all six go through the bus and the Phase 68
 * rule classifies each of them as audited. There is no back door.
 *
 * `controlDecidesAProposal` — `refuse_pending_action` **holds** rather than rejects. Rejecting on
 * an operator's behalf would put a decision in the ledger that the reviewer did not make, and
 * `decision != effect` cuts both ways: an effect prevented is not a decision taken.
 */
export const controlCanDeleteData = (): false => false;
export const controlAppliesWithoutAnAudit = (): false => false;
export const controlDecidesAProposal = (): false => false;
