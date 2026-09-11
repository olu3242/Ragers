import { err, ok, type Result } from '../runtime/result.ts';
import { validationError, type EngineError } from '../runtime/errors.ts';
import { FORBIDDEN_PROPOSAL_PATTERNS } from './agent.ts';

/**
 * Phase 59 — governed action plans.
 *
 * The first thing in this product that runs more than one governed action from one
 * approval, which makes it the first thing that could quietly become an autonomous
 * actor. Everything below is shaped by refusing that.
 *
 * **A plan has no write of its own.** A step names a command and an input; the
 * command is dispatched on the bus like any other, so it passes through
 * `idempotency → resolve → authorize → transition → persist+outbox`. There is no
 * privileged path, and E12 still cannot touch an E1–E11 table.
 *
 * **Authorization is per step, at execution time.** Approving the plan is not
 * approving its effects: an actor who may approve a plan and may not perform its
 * third step gets the third step refused. Checking once at approval would let a plan
 * launder privilege across a boundary the policy matrix draws deliberately.
 *
 * **Partial failure is the normal case.** A step being refused by the engine that
 * owns it is the system working, not an error to retry into submission. So the plan
 * records per step whether the dispatch happened and what refused it, and
 * `completed` is only reachable when every step dispatched — a plan reported complete
 * because it was approved is the failure this phase exists to prevent.
 *
 * **The three prohibitions still hold.** No step may delete, dispute a person's
 * claim, or declare a resolution — the same patterns `validateDeclaration` refuses
 * for agents, checked here too, because a plan is another way to ask.
 */
export type PlanStatus = 'pending' | 'completed' | 'partially_completed' | 'failed';

export const PLAN_STATUSES: readonly PlanStatus[] = [
  'pending',
  'completed',
  'partially_completed',
  'failed',
];

/** A plan longer than this is a workflow, and a workflow needs a person watching it. */
export const MAX_PLAN_STEPS = 8;

export interface PlanStepInput {
  readonly command: unknown;
  readonly input?: unknown;
  readonly targetEngine: unknown;
}

export interface PlanStep {
  readonly order: number;
  readonly command: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly targetEngine: string;
}

export interface DraftPlanInput {
  readonly proposalId: unknown;
  readonly subjectId: unknown;
  readonly steps: unknown;
}

export interface DraftPlan {
  readonly proposalId: string;
  readonly subjectId: string;
  readonly steps: readonly PlanStep[];
}

/** What a step reports after the bus has had it. Never "succeeded" — *dispatched*. */
export interface StepOutcome {
  readonly order: number;
  readonly dispatched: boolean;
  /** The owning engine's refusal, verbatim. Present only when it refused. */
  readonly error?: string;
}

/** A step naming a command E12 must never reach through any route. */
export const forbiddenCommandsIn = (steps: readonly PlanStep[]): readonly string[] =>
  steps.filter((step) => FORBIDDEN_PROPOSAL_PATTERNS.some((pattern) => pattern.test(step.command))).map(
    (step) => step.command,
  );

export const draftPlan = (input: DraftPlanInput): Result<DraftPlan, EngineError> => {
  if (typeof input.proposalId !== 'string' || input.proposalId.length === 0) {
    // A plan cannot exist without an approved proposal: approval is the only thing
    // that turns a recommendation into steps.
    return err(validationError('proposal_required', 'a plan is drawn from an approved proposal'));
  }
  if (typeof input.subjectId !== 'string' || input.subjectId.length === 0) {
    return err(validationError('missing_subject', 'a plan must name what it is about'));
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    return err(validationError('steps_required', 'a plan is at least one step'));
  }
  if (input.steps.length > MAX_PLAN_STEPS) {
    return err(validationError('too_many_steps', `a plan is at most ${MAX_PLAN_STEPS} steps`));
  }

  const steps: PlanStep[] = [];
  for (const [index, raw] of input.steps.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return err(validationError('invalid_step', 'each step is an object naming a command'));
    }
    const entry = raw as PlanStepInput;
    if (typeof entry.command !== 'string' || entry.command.length === 0) {
      return err(validationError('step_command_required', 'each step names the command it would run'));
    }
    if (typeof entry.targetEngine !== 'string' || entry.targetEngine.length === 0) {
      return err(validationError('step_engine_required', 'each step names the engine that owns it'));
    }
    if (entry.targetEngine === 'E12') {
      // A step targeting the proposer is a closed loop with no governed engine in it —
      // the same refusal `createProposal` already makes.
      return err(
        validationError('step_cannot_target_intelligence', 'a step must target a governed engine, not the proposer'),
      );
    }
    if (entry.input !== undefined && (typeof entry.input !== 'object' || entry.input === null || Array.isArray(entry.input))) {
      return err(validationError('step_input_invalid', "a step's input is an object of named fields"));
    }
    steps.push({
      order: index + 1,
      command: entry.command,
      input: (entry.input ?? {}) as Readonly<Record<string, unknown>>,
      targetEngine: entry.targetEngine,
    });
  }

  const forbidden = forbiddenCommandsIn(steps);
  if (forbidden.length > 0) {
    return err(
      validationError(
        'step_forbidden',
        'no plan may delete an experience, dispute a claim, or declare a resolution',
        { commands: forbidden },
      ),
    );
  }

  const commands = new Set(steps.map((step) => `${step.command}|${JSON.stringify(step.input)}`));
  if (commands.size !== steps.length) {
    // The same command with the same input twice in one plan is either a mistake or
    // an attempt to double an effect past an idempotency key.
    return err(validationError('duplicate_step', 'a plan must not repeat the same step'));
  }

  return ok({ proposalId: input.proposalId, subjectId: input.subjectId, steps });
};

/**
 * The plan's status from what actually happened.
 *
 * `completed` requires every step. `failed` means none dispatched — the plan achieved
 * nothing, and saying "partially" would be generous about it. Everything between is
 * `partially_completed`, which is a normal outcome and not a broken one.
 */
export const planStatusFrom = (steps: readonly PlanStep[], outcomes: readonly StepOutcome[]): PlanStatus => {
  const dispatched = outcomes.filter((outcome) => outcome.dispatched).length;
  if (outcomes.length === 0) return 'pending';
  if (dispatched === steps.length) return 'completed';
  if (dispatched === 0) return 'failed';
  return 'partially_completed';
};

/**
 * Deliberately absent: a plan that runs itself.
 *
 * No schedule, no trigger, no retry loop. A plan executes when a person executes it,
 * and `undefined` so the absence is assertable rather than merely true today.
 */
export const schedulePlan = (): undefined => undefined;

/**
 * And absent: any path from a plan to a row.
 *
 * `false` by construction — a step carries a command name and an input, and the only
 * thing that can turn those into a change is the bus. Asserted in a test, in the same
 * shape as `agentCanMutate`.
 */
export const planCanMutateDirectly = (): false => false;
