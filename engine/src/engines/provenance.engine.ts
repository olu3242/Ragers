import { eq } from '../ports/store.ts';
import type {
  ActionPlanRow,
  ActionPlanStepRow,
  AuditEvent,
  ProposalRow,
  RecommendationRow,
} from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * Decision provenance — Phase 93.
 *
 * The chain this reads out is:
 *
 * ```
 * proposal → reviewer → decision → authority → command → target engine → effect or refusal
 * ```
 *
 * **Every link already existed and nothing joined them.** `intelligence_proposals` holds
 * `reviewed_by`, `dispatched_at` and `dispatch_error`; `action_plans` and `action_plan_steps` hold
 * the commands and what each one did; `audit_events` holds the decision under the reviewer's name.
 * Four tables, four correct records, and no way to ask the one question anybody actually asks
 * after an incident: **what did we decide, and did it happen?**
 *
 * That question is not cosmetic. `decision != effect` is one of this codebase's stated invariants,
 * and an invariant that cannot be *observed* is indistinguishable from one that is false. A
 * proposal approved by a named person whose every step was then refused is the exact shape the
 * invariant describes, and until this read existed it was spread across three tables in a form
 * nobody would assemble under pressure.
 *
 * ## Why this is a read and not a table
 *
 * A `decision_provenance` table would be a fifth copy of facts that are already append-only
 * somewhere else, and a copy is a second version of the truth that drifts the first time a write
 * lands in one place and not the other. Phases 51–55 made the same call for the same reason: the
 * inputs are append-only, so the chain is derivable, and a derived chain cannot disagree with its
 * own sources.
 *
 * The one thing a read cannot give is a guarantee that the chain is *complete* — a step that never
 * wrote a row is invisible. That is why `provenanceGaps` exists below and says so out loud rather
 * than presenting a partial chain as a whole one.
 */

/** What happened at one link. */
export interface ProvenanceLink {
  readonly stage:
    | 'proposed'
    | 'decided'
    | 'planned'
    | 'dispatched'
    | 'refused'
    | 'effect_recorded';
  readonly at: number;
  /** Who, when a person was involved. Absent for an agent or the engine's own identity. */
  readonly actorId?: string;
  /** The role they held at the time of the decision, which is the authority that was used. */
  readonly authority?: string;
  readonly command?: string;
  readonly targetEngine?: string;
  /** Why it did not take effect. Present exactly on `refused`. */
  readonly refusal?: string;
  readonly detail: string;
}

export interface Provenance {
  readonly proposalId: string;
  readonly links: readonly ProvenanceLink[];
  /**
   * Whether the decision produced the effect it authorised.
   *
   * Three values rather than a boolean, because "not yet" and "no" are different facts and a
   * boolean would make a plan nobody has executed look like a refusal.
   */
  readonly outcome: 'no_decision_yet' | 'approved_and_applied' | 'approved_and_refused' | 'rejected';
  /** Set when the chain cannot be read end to end, naming what is missing. */
  readonly gaps: readonly string[];
}

/**
 * Read the chain for one proposal.
 *
 * Ordered by time, and each link carries the *authority* that was used rather than the actor's
 * current role — an admin demoted next month must not make last month's decision read as though a
 * member took it. The role comes from the audit row, which recorded it at the time.
 */
export const provenanceFor = async (
  deps: EngineDeps,
  proposalId: string,
): Promise<Provenance | undefined> => {
  const proposal = await deps.store.proposals.get(proposalId);
  if (!proposal) return undefined;

  const links: ProvenanceLink[] = [
    {
      stage: 'proposed',
      at: proposal.createdAt,
      targetEngine: proposal.targetEngine,
      detail: `${proposal.sourceEngine} proposed ${proposal.proposalType} for ${proposal.targetEngine}, citing ${proposal.evidenceRefs.length} row(s).`,
    },
  ];

  // The decision, from the audit trail rather than from the proposal row. The row holds the
  // current reading; the trail holds who and when, and a second decision would overwrite the row
  // while leaving both events in the trail.
  const decisions = (
    await deps.store.auditEvents.query([eq<AuditEvent>('resourceId', proposalId)])
  )
    .filter((event) => event.action === 'proposal.decide')
    .sort((left, right) => left.createdAt - right.createdAt);

  for (const event of decisions) {
    const outcome = String((event.after as Record<string, unknown> | undefined)?.['status'] ?? proposal.status);
    links.push({
      stage: 'decided',
      at: event.createdAt,
      actorId: event.actorId,
      ...(typeof (event.after as Record<string, unknown> | undefined)?.['role'] === 'string'
        ? { authority: String((event.after as Record<string, unknown>)['role']) }
        : {}),
      detail: `${event.actorId} ${outcome} it.`,
    });
  }

  // The plan, and every step's own fate. This is where `decision != effect` becomes readable.
  const plan = await deps.store.actionPlans.queryOne([eq<ActionPlanRow>('proposalId', proposalId)]);
  if (plan) {
    links.push({
      stage: 'planned',
      at: plan.createdAt,
      ...(plan.approvedBy === undefined ? {} : { actorId: plan.approvedBy }),
      detail: `A plan of ${plan.stepCount} step(s) was drawn and approved.`,
    });

    const steps = [
      ...(await deps.store.actionPlanSteps.query([eq<ActionPlanStepRow>('planId', plan.id)])),
    ].sort((left, right) => left.stepOrder - right.stepOrder);

    for (const step of steps) {
      links.push(
        step.dispatched
          ? {
              stage: 'dispatched',
              at: step.executedAt ?? plan.createdAt,
              command: step.command,
              targetEngine: step.targetEngine,
              detail: `Step ${step.stepOrder} ran ${step.command} against ${step.targetEngine}.`,
            }
          : {
              stage: 'refused',
              at: step.executedAt ?? plan.createdAt,
              command: step.command,
              targetEngine: step.targetEngine,
              // **The link the whole phase exists for.** A refused step stays in the chain with
              // its reason. Dropping it would leave an approval with no visible consequence,
              // which reads as an effect nobody can find rather than as a refusal.
              refusal: step.dispatchError ?? 'refused with no reason recorded',
              detail: `Step ${step.stepOrder} was refused: ${step.dispatchError ?? 'no reason recorded'}.`,
            },
      );
    }
  }

  links.sort((left, right) => left.at - right.at);

  return {
    proposalId,
    links,
    outcome: outcomeOf(proposal, plan),
    gaps: provenanceGaps(proposal, plan, decisions.length),
  };
};

const outcomeOf = (
  proposal: ProposalRow,
  plan: ActionPlanRow | undefined,
): Provenance['outcome'] => {
  if (proposal.status === 'rejected') return 'rejected';
  if (proposal.status !== 'approved') return 'no_decision_yet';
  if (!plan || plan.status === 'pending') return 'no_decision_yet';
  // `failed` means every step was refused; `partial` means some were. Both are an approval whose
  // effect did not follow, and collapsing them into "applied" is the lie this read prevents.
  return plan.dispatchedCount === 0 ? 'approved_and_refused' : 'approved_and_applied';
};

/**
 * What the chain cannot account for.
 *
 * Said out loud rather than papered over. A derived chain is only as complete as the rows it
 * reads, and an operator looking at one during an incident needs to know the difference between
 * "this did not happen" and "nothing recorded whether it happened".
 */
export const provenanceGaps = (
  proposal: ProposalRow,
  plan: ActionPlanRow | undefined,
  decisionEvents: number,
): readonly string[] => {
  const gaps: string[] = [];
  if (proposal.status !== 'proposed' && decisionEvents === 0) {
    gaps.push(
      `the proposal is ${proposal.status} and no audit event records the decision, so who decided it cannot be read`,
    );
  }
  if (proposal.status === 'approved' && plan === undefined) {
    gaps.push('approved, and no plan was drawn — the approval authorised nothing');
  }
  if (plan !== undefined && plan.status !== 'pending' && plan.executedAt === undefined) {
    gaps.push('the plan reports a terminal status with no execution time recorded');
  }
  return gaps;
};

/**
 * Every approval whose effect did not follow.
 *
 * The query an incident review actually runs, and the reason `decision != effect` is observable
 * rather than merely asserted. Bounded, because a review reads the recent ones and an unbounded
 * scan of the proposal table is a way to make this read unusable exactly when it is needed.
 */
export const PROVENANCE_SCAN_LIMIT = 500;

export const approvedButRefused = async (
  deps: EngineDeps,
): Promise<readonly Provenance[]> => {
  const approved = (
    await deps.store.proposals.query([eq<ProposalRow>('status', 'approved')])
  ).slice(0, PROVENANCE_SCAN_LIMIT);

  const found: Provenance[] = [];
  for (const proposal of approved) {
    const chain = await provenanceFor(deps, proposal.id);
    if (chain?.outcome === 'approved_and_refused') found.push(chain);
  }
  return found;
};

/** The chain for a recommendation, through the proposal it produced. */
export const provenanceForRecommendation = async (
  deps: EngineDeps,
  recommendationId: string,
): Promise<Provenance | undefined> => {
  const recommendation = await deps.store.recommendations.get(recommendationId);
  if (!recommendation?.proposalId) return undefined;
  return provenanceFor(deps, recommendation.proposalId);
};

/** Recommendations that produced no proposal at all: noticed, and nothing actionable followed. */
export const noticedButNotProposed = async (deps: EngineDeps): Promise<readonly RecommendationRow[]> =>
  (await deps.store.recommendations.query([])).filter((row) => row.proposalId === undefined);

/**
 * The absences, as code.
 *
 * `provenanceIsWritable` — false. Every source is append-only and this is a read over them, so
 * there is no row here anybody could edit to make a decision look different afterwards.
 *
 * `provenanceHidesARefusal` — false, and it is the one that matters. A chain that dropped refused
 * steps would make every approval look effective, which is worse than having no chain: it would
 * be an authoritative-looking answer to the question `decision != effect` exists to ask.
 */
export const provenanceIsWritable = (): false => false;
export const provenanceHidesARefusal = (): false => false;
