import { err, ok, type Result } from '../runtime/result.ts';
import { conflictError, notFoundError, preconditionError, type EngineError } from '../runtime/errors.ts';
import { eq } from '../ports/store.ts';
import { draftPlan, planStatusFrom, type PlanStep, type StepOutcome } from '../domain/plan.ts';
import type { ActorContext } from '../runtime/authz.ts';
import type { ActionPlanRow, ActionPlanStepRow } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * Governed Action Plans — E12. Phase 59.
 *
 * The engine does three things and no others: it records a plan drawn from an approved
 * proposal, it dispatches each step through the bus, and it records what the owning
 * engine said. It writes to `action_plans` and `action_plan_steps` and to nothing else.
 *
 * The order of operations matters and is the same lesson the agent runner already
 * taught: **claim the row before doing the work.** Two callers executing the same plan
 * must not both dispatch its steps, so the plan is moved out of `pending` with a
 * `compareAndSet` first, and the loser does nothing at all.
 *
 * Each step is dispatched as the *reviewer*, not as the engine. That is the whole
 * mechanism by which authorization stays per step: the bus authorizes the reviewer
 * against the step's own resource, so a step they may not perform is refused with
 * their name on the refusal. Dispatching as a service actor would give a plan
 * privileges the person who approved it does not have, which is precisely the
 * laundering this phase must not permit.
 */

/** Deterministic, so two callers creating a plan for one proposal collide on it. */
export const planKeyOf = (proposalId: string): string => `plan:${proposalId}`;
export const planStepKeyOf = (planId: string, order: number): string => `${planId}:${order}`;

export interface CreatePlanInput {
  readonly proposalId: string;
  readonly steps: readonly { readonly command: string; readonly input?: Record<string, unknown>; readonly targetEngine: string }[];
}

/**
 * Record a plan against an approved proposal.
 *
 * Refuses unless the proposal exists *and* has been approved. A plan against a
 * proposed, rejected or expired recommendation would be a plan nobody agreed to.
 */
export const createPlan = async (
  deps: EngineDeps,
  input: CreatePlanInput,
  reviewer: ActorContext,
): Promise<Result<ActionPlanRow, EngineError>> => {
  const proposal = await deps.store.proposals.get(input.proposalId);
  if (!proposal) return err(notFoundError('proposal_not_found', 'no such proposal'));
  if (proposal.status !== 'approved') {
    return err(
      preconditionError('proposal_not_approved', `a plan needs an approved proposal, and this one is ${proposal.status}`),
    );
  }

  const drafted = draftPlan({
    proposalId: input.proposalId,
    subjectId: proposal.subjectId,
    steps: input.steps,
  });
  if (!drafted.ok) return drafted;

  const id = planKeyOf(input.proposalId);
  const row: ActionPlanRow = {
    id,
    proposalId: drafted.value.proposalId,
    subjectId: drafted.value.subjectId,
    approvedBy: reviewer.actorId,
    status: 'pending',
    stepCount: drafted.value.steps.length,
    dispatchedCount: 0,
    createdAt: deps.clock.now(),
  };

  const won = await deps.store.actionPlans.compareAndSet(row, 'absent');
  if (!won) {
    return err(conflictError('plan_exists', 'a plan already exists for that proposal', { planId: id }));
  }

  for (const step of drafted.value.steps) {
    await deps.store.actionPlanSteps.put({
      id: planStepKeyOf(id, step.order),
      planId: id,
      stepOrder: step.order,
      command: step.command,
      input: step.input,
      targetEngine: step.targetEngine,
      dispatched: false,
    });
  }

  deps.metrics.increment('plan.created', { steps: String(drafted.value.steps.length) });
  return ok(row);
};

export interface PlanExecution {
  readonly plan: ActionPlanRow;
  readonly outcomes: readonly StepOutcome[];
}

/**
 * Execute a plan, step by step, in order.
 *
 * Every step is attempted. A refused step does not stop the ones after it, because the
 * steps are separate governed actions and stopping would make the plan's outcome
 * depend on the order a reviewer happened to write it in — and because "we did not
 * try the rest" is a worse report than "the third one was refused, here is why".
 */
export const executePlan = async (
  deps: EngineDeps,
  planId: string,
  reviewer: ActorContext,
): Promise<Result<PlanExecution, EngineError>> => {
  const plan = await deps.store.actionPlans.get(planId);
  if (!plan) return err(notFoundError('plan_not_found', 'no such plan'));
  if (plan.status !== 'pending') {
    return err(preconditionError('plan_already_executed', `this plan is already ${plan.status}`));
  }

  const rows = await deps.store.actionPlanSteps.query([eq<ActionPlanStepRow>('planId', planId)], {
    orderBy: { field: 'stepOrder', direction: 'asc' },
  });
  // Phase 89 — **approval is not a standing authorization.**
  //
  // `createPlan` records `stepCount` at approval, and until this check existed nothing
  // compared it to what was in the table at execution time. A row inserted into
  // `action_plan_steps` afterwards was simply executed.
  //
  // Not privilege escalation: each step below dispatches as the reviewer, so an appended step
  // faces exactly the authorization the reviewer would. It is **scope** escalation — a step the
  // reviewer never saw, run under their name, inside their existing rights — and it is the
  // failure the sentence "approval is not a standing authorization" is about.
  //
  // Refused **whole**, before any dispatch, and the plan is left `pending`. Running the steps
  // that match and refusing the rest would let the appended row decide that the earlier steps
  // happened, which is the tampering having an effect. A count catches both directions:
  // removal would otherwise execute a subset and report `succeeded`, which is a plan reporting
  // that it did something it did not do.
  if (rows.length !== plan.stepCount) {
    return err(
      preconditionError(
        'plan_steps_changed',
        `this plan was approved with ${plan.stepCount} step(s) and now has ${rows.length}; approval does not extend to steps added since`,
      ),
    );
  }

  const steps: readonly PlanStep[] = rows.map((row) => ({
    order: row.stepOrder,
    command: row.command,
    input: row.input,
    targetEngine: row.targetEngine,
  }));

  // Claimed before any dispatch. Two callers arriving together must not both run the
  // steps: the loser of this compare-and-set does nothing, rather than doing the work
  // and finding out afterwards that it was not theirs to do.
  const claimed = await deps.store.actionPlans.compareAndSet(
    { ...plan, status: 'failed', dispatchedCount: 0, executedAt: deps.clock.now() },
    [eq<ActionPlanRow>('status', 'pending')],
  );
  if (!claimed) {
    return err(preconditionError('plan_already_executed', 'another caller is executing this plan'));
  }

  const outcomes: StepOutcome[] = [];
  for (const step of steps) {
    // As the reviewer, on the bus. Authorization is therefore evaluated now, against
    // this step's own resource — a step this person may not perform is refused with
    // their name on the refusal rather than run under borrowed privilege.
    const result = await deps.bus.dispatch({
      name: step.command,
      input: step.input,
      actor: reviewer,
      // Derived from the plan and the step, so re-executing cannot double an effect.
      idempotencyKey: `${planStepKeyOf(planId, step.order)}`,
      correlationId: planId,
    });

    const outcome: StepOutcome = result.ok
      ? { order: step.order, dispatched: true }
      : { order: step.order, dispatched: false, error: `${result.error.code}: ${result.error.message}` };
    outcomes.push(outcome);

    await deps.store.actionPlanSteps.put({
      id: planStepKeyOf(planId, step.order),
      planId,
      stepOrder: step.order,
      command: step.command,
      input: step.input,
      targetEngine: step.targetEngine,
      dispatched: outcome.dispatched,
      ...(outcome.error === undefined ? {} : { dispatchError: outcome.error }),
      executedAt: deps.clock.now(),
    });
    deps.metrics.increment('plan.step', { dispatched: String(outcome.dispatched) });
  }

  const status = planStatusFrom(steps, outcomes);
  const executed: ActionPlanRow = {
    ...plan,
    status,
    dispatchedCount: outcomes.filter((outcome) => outcome.dispatched).length,
    executedAt: deps.clock.now(),
  };
  await deps.store.actionPlans.put(executed);
  deps.metrics.increment('plan.executed', { status });

  return ok({ plan: executed, outcomes });
};

/** A plan and its steps, for the operator surface that has to explain what happened. */
export const planWithSteps = async (
  deps: EngineDeps,
  planId: string,
): Promise<{ readonly plan: ActionPlanRow; readonly steps: readonly ActionPlanStepRow[] } | undefined> => {
  const plan = await deps.store.actionPlans.get(planId);
  if (!plan) return undefined;
  return {
    plan,
    steps: await deps.store.actionPlanSteps.query([eq<ActionPlanStepRow>('planId', planId)], {
      orderBy: { field: 'stepOrder', direction: 'asc' },
    }),
  };
};

export const plansFor = async (deps: EngineDeps, subjectId: string): Promise<readonly ActionPlanRow[]> =>
  deps.store.actionPlans.query([eq<ActionPlanRow>('subjectId', subjectId)]);

/**
 * The guarantee, as code: this engine writes to no E1–E11 table.
 *
 * A step's effect is the owning engine's, produced by a command on the bus. Asserted
 * in a test, in the same shape as `handoffMutatesGovernedState` and `agentCanMutate`.
 */
export const planMutatesGovernedState = (): false => false;
