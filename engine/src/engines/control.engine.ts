import { eq } from '../ports/store.ts';
import { err, ok } from '../runtime/result.ts';
import { notFoundError, preconditionError } from '../runtime/errors.ts';
import {
  CONTROL_CONSEQUENCES,
  controlKeyOf,
  validateControl,
  type ControlKind,
  type OperatorControl,
} from '../domain/operator-control.ts';
import { writeAudit } from './support.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { EngineDeps } from './deps.ts';

/**
 * The operator controls — Phase 94.
 *
 * Six commands, one per control plus `resume`. The argument for their shape is in
 * `src/domain/operator-control.ts`; this module is the governed surface and the reads that
 * enforce them.
 *
 * **The reads are the point.** A control that nothing consults is a row, not a switch. Each
 * predicate below is called on the path it governs — `isAgentPaused` inside `runAgent`,
 * `isProposalTypeDisabled` inside `proposal.create`, `isActionHeld` inside `proposal.decide` and
 * `executePlan`, `isIntegrationSuspended` at the transport, `degradedModeForced` in the health
 * reading — and each of those call sites is asserted by a test, because the failure mode here is
 * a switch that flips and changes nothing.
 */

export interface ControlResult {
  readonly controlId: string;
  readonly active: boolean;
  /** What this control refuses, so the operator sees it in the response they just caused. */
  readonly consequence: string;
}

const applyControl = (
  deps: EngineDeps,
  kind: ControlKind,
  name: string,
): CommandHandler<{ target: string; reason: string }, ControlResult> => ({
  name,
  // Every control is an admin action. An override is outside the normal path by definition, and
  // the normal path already has moderator-level actions for moderator work.
  action: 'control.apply',
  resolveResource: async (input) => {
    const valid = validateControl({ kind, target: String(input?.target ?? '') }, String(input?.reason ?? ''));
    if (!valid.ok) return valid;
    return ok({ type: 'operator_control' });
  },
  handle: async (input, ctx) => {
    const id = controlKeyOf({ kind, target: input.target });
    const existing = await deps.store.operatorControls.get(id);
    if (existing?.active === true) {
      // Already in force. Not an error worth failing a page over, and not a silent success
      // either: re-applying must not overwrite who applied it first or when, because that is
      // the record somebody will read to find out how long this has been the case.
      return ok({
        value: { controlId: id, active: true, consequence: CONTROL_CONSEQUENCES[kind] },
        events: [],
      });
    }

    const row: OperatorControl = {
      id,
      kind,
      target: input.target,
      active: true,
      reason: input.reason,
      createdBy: ctx.actor.actorId,
      createdAt: ctx.clock.now(),
    };
    await deps.store.operatorControls.put(row);
    // Audited, in both directions. The Phase 68 rule classifies all six as
    // `changes_what_another_may_do`, and its source sweep checks that this call exists with
    // this action string rather than merely that the module mentions `writeAudit` somewhere.
    await writeAudit(deps, ctx, {
      action: 'control.apply',
      resourceType: 'operator_control',
      resourceId: id,
      after: { kind, target: input.target, reason: input.reason },
    });
    deps.metrics.increment('control.applied', { kind });

    return ok({
      value: { controlId: id, active: true, consequence: CONTROL_CONSEQUENCES[kind] },
      events: [
        {
          aggregateType: 'operator_control',
          aggregateId: id,
          eventName: 'OperatorControlApplied',
          // The target and the kind, never the reason: the event travels to consumers and a
          // reason is an operator's words for other operators, not payload for a projection.
          payload: { controlId: id, kind, target: input.target },
        },
      ],
    });
  },
});

export const registerControlEngine = (deps: EngineDeps): void => {
  deps.bus.register(applyControl(deps, 'pause_agent', 'control.pauseAgent'));
  deps.bus.register(applyControl(deps, 'disable_proposal_type', 'control.disableProposalType'));
  deps.bus.register(applyControl(deps, 'refuse_pending_action', 'control.refusePendingAction'));
  deps.bus.register(applyControl(deps, 'suspend_integration', 'control.suspendIntegration'));
  deps.bus.register(applyControl(deps, 'force_degraded_mode', 'control.enterDegradedMode'));

  /**
   * Release a control.
   *
   * Sets `active` false and records who and when, rather than deleting the row. The history of
   * what was paused and for how long is the thing an incident review needs, and a delete would
   * make the system look as though it had never been touched.
   */
  const resume: CommandHandler<{ controlId: string }, ControlResult> = {
    name: 'control.resume',
    action: 'control.apply',
    resolveResource: async () => ok({ type: 'operator_control' }),
    handle: async (input, ctx) => {
      const control = await deps.store.operatorControls.get(String(input?.controlId ?? ''));
      if (!control) return err(notFoundError('control_not_found', 'no such control'));
      if (!control.active) {
        return err(preconditionError('control_not_active', 'that control has already been released'));
      }

      const released: OperatorControl = {
        ...control,
        active: false,
        releasedBy: ctx.actor.actorId,
        releasedAt: ctx.clock.now(),
      };
      // Pinned to `active`, so two operators resuming at once do not both record a release.
      const won = await deps.store.operatorControls.compareAndSet(released, [
        eq<OperatorControl>('active', true),
      ]);
      if (!won) {
        return err(preconditionError('control_not_active', 'somebody else released it first'));
      }
      await writeAudit(deps, ctx, {
        action: 'control.release',
        resourceType: 'operator_control',
        resourceId: control.id,
        // Both states, so the review can see how long it was in force without joining anything.
        before: { active: true, appliedBy: control.createdBy, appliedAt: control.createdAt },
        after: { active: false },
      });
      deps.metrics.increment('control.released', { kind: control.kind });

      return ok({
        value: {
          controlId: control.id,
          active: false,
          consequence: 'Released. Whatever this control refused is permitted again.',
        },
        events: [
          {
            aggregateType: 'operator_control',
            aggregateId: control.id,
            eventName: 'OperatorControlReleased',
            payload: { controlId: control.id, kind: control.kind, target: control.target },
          },
        ],
      });
    },
  };
  deps.bus.register(resume);
};

// ── the reads that enforce them ──────────────────────────────────────────

/** Whether a control is in force. The one predicate every other read below composes. */
export const controlActive = async (
  deps: EngineDeps,
  kind: ControlKind,
  target: string,
): Promise<boolean> => {
  const control = await deps.store.operatorControls.get(controlKeyOf({ kind, target }));
  return control?.active === true;
};

export const isAgentPaused = (deps: EngineDeps, agentId: string): Promise<boolean> =>
  controlActive(deps, 'pause_agent', agentId);

export const isProposalTypeDisabled = (deps: EngineDeps, proposalType: string): Promise<boolean> =>
  controlActive(deps, 'disable_proposal_type', proposalType);

/**
 * Whether a pending proposal or plan is held.
 *
 * Held, not rejected: `controlDecidesAProposal()` is false, and the reason is that rejecting on
 * an operator's behalf would put a decision in the ledger the reviewer did not make.
 */
export const isActionHeld = (deps: EngineDeps, actionId: string): Promise<boolean> =>
  controlActive(deps, 'refuse_pending_action', actionId);

export const isIntegrationSuspended = (deps: EngineDeps, integration: string): Promise<boolean> =>
  controlActive(deps, 'suspend_integration', integration);

/** The scope `force_degraded_mode` uses. Named rather than a wildcard — see the domain module. */
export const RUNTIME_SCOPE = 'runtime';

export const degradedModeForced = (deps: EngineDeps): Promise<boolean> =>
  controlActive(deps, 'force_degraded_mode', RUNTIME_SCOPE);

/** Every control currently in force, for the operator surface. */
export const activeControls = async (deps: EngineDeps): Promise<readonly OperatorControl[]> =>
  deps.store.operatorControls.query([eq<OperatorControl>('active', true)]);

/** The whole history, released ones included, for an incident review. */
export const controlHistory = async (deps: EngineDeps): Promise<readonly OperatorControl[]> =>
  [...(await deps.store.operatorControls.query([]))].sort((left, right) => left.createdAt - right.createdAt);
