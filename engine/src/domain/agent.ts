import { err, ok, type Result } from '../runtime/result.ts';
import { preconditionError, validationError, type EngineError } from '../runtime/errors.ts';
import type { EngineId } from './proposal.ts';

/**
 * Experience Agent Framework — Phase 45, E12.
 *
 * An agent is a **governed actor in the existing authorization model, not a bypass around
 * it.** The framework's job is to make that structural rather than aspirational, and it
 * does so with one rule enforced in one place:
 *
 *   **An agent's only output is a proposal.**
 *
 * There is no `mutate`, no `apply`, no tool list containing a write. An agent analyses,
 * recommends and proposes; a person decides; the target engine's own command carries it
 * out and may refuse. That chain is the same one Phase 40's handoff uses, and reusing it
 * rather than inventing an agent-specific path is what keeps a single governed seam
 * instead of two.
 *
 * Each agent declares its domain up front — which engines it may read, which proposal
 * types it may produce, its confidence floor, and where it escalates. `authorise` then
 * refuses anything outside that declaration. The Phase 45 certification is a negative
 * asserted by *attempting the excess and being refused*, so the declaration has to be
 * checkable at runtime rather than a table in a document.
 */
export type AgentId =
  | 'intake'
  | 'classification'
  | 'matching'
  | 'trust'
  | 'trend'
  | 'resolution'
  | 'organization_response'
  | 'moderation'
  | 'intelligence';

export const AGENT_IDS: readonly AgentId[] = [
  'intake',
  'classification',
  'matching',
  'trust',
  'trend',
  'resolution',
  'organization_response',
  'moderation',
  'intelligence',
];

/**
 * What an agent is allowed to do. Deliberately a short list, and deliberately containing
 * no write: `read` gathers governed state, `propose` creates a proposal, `escalate` hands
 * it to a person. There is no fourth verb, which is the whole point.
 */
export type AgentAction = 'read' | 'propose' | 'escalate';

export const AGENT_ACTIONS: readonly AgentAction[] = ['read', 'propose', 'escalate'];

export interface AgentDeclaration {
  readonly id: AgentId;
  /** In plain words, for the audit trail and the reviewer surface. */
  readonly purpose: string;
  /** Engines whose state it may read. Anything else is refused. */
  readonly readsEngines: readonly EngineId[];
  /** Proposal types it may produce. Anything else is refused. */
  readonly proposalTypes: readonly string[];
  /** Below this it must escalate rather than propose. */
  readonly confidenceFloor: number;
  /** Who it escalates to when it is not confident enough, or is refused. */
  readonly escalatesTo: 'moderator' | 'organization' | 'admin';
  /**
   * Actions it may take. Every declaration in this system lists a subset of
   * `AGENT_ACTIONS`, and there is no way to widen it because no write verb exists.
   */
  readonly actions: readonly AgentAction[];
  /** Retry budget for a run. An agent that fails does not retry forever. */
  readonly maxAttempts: number;
}

export interface AgentRequest {
  readonly agentId: AgentId;
  readonly action: AgentAction;
  /** The engine whose state it wants to read, for a `read`. */
  readonly engine?: EngineId;
  /** The proposal type, for a `propose`. */
  readonly proposalType?: string;
  readonly confidence?: number;
}

export type AgentRefusal =
  | 'unknown_agent'
  | 'action_not_declared'
  | 'engine_not_declared'
  | 'proposal_type_not_declared'
  | 'below_confidence_floor'
  | 'mutation_not_possible';

/**
 * Authorise one agent request against its own declaration.
 *
 * Returns the refusal reason rather than a boolean, because the Phase 45 certification is
 * about *being told no for the right reason* — an agent refused as "unknown" when it
 * should have been refused as "outside your domain" would pass a boolean test while
 * hiding a real hole.
 */
export const authorise = (
  declaration: AgentDeclaration | undefined,
  request: AgentRequest,
): Result<true, EngineError> => {
  if (!declaration || declaration.id !== request.agentId) {
    return err(preconditionError('unknown_agent', 'that agent is not registered', { refusal: 'unknown_agent' }));
  }

  if (!declaration.actions.includes(request.action)) {
    return err(
      preconditionError('action_not_declared', `${request.agentId} may not ${request.action}`, {
        refusal: 'action_not_declared',
      }),
    );
  }

  if (request.action === 'read') {
    if (request.engine === undefined || !declaration.readsEngines.includes(request.engine)) {
      return err(
        preconditionError('engine_not_declared', `${request.agentId} may not read ${request.engine ?? 'nothing'}`, {
          refusal: 'engine_not_declared',
        }),
      );
    }
  }

  if (request.action === 'propose') {
    if (request.proposalType === undefined || !declaration.proposalTypes.includes(request.proposalType)) {
      return err(
        preconditionError(
          'proposal_type_not_declared',
          `${request.agentId} may not propose ${request.proposalType ?? 'nothing'}`,
          { refusal: 'proposal_type_not_declared' },
        ),
      );
    }
    // Below its floor an agent escalates instead of proposing. A low-confidence proposal
    // is worse than no proposal: it spends a reviewer's attention and teaches them to
    // skim.
    if (request.confidence === undefined || request.confidence < declaration.confidenceFloor) {
      return err(
        preconditionError(
          'below_confidence_floor',
          `${request.agentId} is not confident enough to propose; it must escalate to ${declaration.escalatesTo}`,
          { refusal: 'below_confidence_floor', floor: declaration.confidenceFloor },
        ),
      );
    }
  }

  return ok(true);
};

/**
 * The registry.
 *
 * Every agent in the roadmap's Phase 45 list, with a domain narrow enough to be
 * meaningful. The organization response agent (Phase 46) is the one with the most at
 * stake, and its declaration is where the three prohibitions become structural: it may
 * propose a *response* and it may escalate, and there is no proposal type in its list for
 * deletion, dispute or declaring a resolution.
 */
export const AGENTS: Readonly<Record<AgentId, AgentDeclaration>> = {
  intake: {
    id: 'intake',
    purpose: 'Read a new account and suggest the structure its author might confirm.',
    readsEngines: ['E1', 'E2'],
    proposalTypes: ['suggest_structure'],
    confidenceFloor: 0.6,
    escalatesTo: 'moderator',
    actions: ['read', 'propose', 'escalate'],
    maxAttempts: 3,
  },
  classification: {
    id: 'classification',
    purpose: 'Suggest a category or issue type for an account whose author has not confirmed one.',
    readsEngines: ['E1', 'E3'],
    proposalTypes: ['suggest_structure'],
    confidenceFloor: 0.6,
    escalatesTo: 'moderator',
    actions: ['read', 'propose', 'escalate'],
    maxAttempts: 3,
  },
  matching: {
    id: 'matching',
    purpose: 'Suggest that two accounts describe the same pattern.',
    readsEngines: ['E3', 'E7'],
    proposalTypes: ['suggest_cluster'],
    confidenceFloor: 0.7,
    escalatesTo: 'moderator',
    actions: ['read', 'propose', 'escalate'],
    maxAttempts: 3,
  },
  trust: {
    id: 'trust',
    purpose: 'Summarise a contribution pattern for a moderator. Never a score about a person.',
    readsEngines: ['E4'],
    proposalTypes: ['review_contribution_pattern'],
    confidenceFloor: 0.7,
    escalatesTo: 'moderator',
    actions: ['read', 'propose', 'escalate'],
    maxAttempts: 2,
  },
  trend: {
    id: 'trend',
    purpose: 'Notice that a pattern is accelerating and say what changed.',
    readsEngines: ['E7', 'E8'],
    proposalTypes: ['review_accelerating_pattern'],
    confidenceFloor: 0.6,
    escalatesTo: 'moderator',
    actions: ['read', 'propose', 'escalate'],
    maxAttempts: 3,
  },
  resolution: {
    id: 'resolution',
    purpose: 'Notice an outcome that has gone unconfirmed and ask a person to look.',
    readsEngines: ['E10'],
    proposalTypes: ['review_unresolved_critical', 'revisit_stale_escalation'],
    confidenceFloor: 0.5,
    escalatesTo: 'moderator',
    actions: ['read', 'propose', 'escalate'],
    maxAttempts: 3,
  },
  organization_response: {
    id: 'organization_response',
    // Phase 46. Its three prohibitions are structural rather than stated: there is no
    // proposal type here for deletion, for disputing a user's claim, or for declaring a
    // resolution — and `authorise` refuses a type that is not listed.
    purpose: 'Prepare a response an organization may send, and coordinate remediation.',
    readsEngines: ['E9', 'E10'],
    proposalTypes: ['draft_organization_response', 'suggest_remediation'],
    confidenceFloor: 0.6,
    escalatesTo: 'organization',
    actions: ['read', 'propose', 'escalate'],
    maxAttempts: 3,
  },
  moderation: {
    id: 'moderation',
    purpose: 'Prepare context for a moderator decision. It never makes the decision.',
    readsEngines: ['E4', 'E9'],
    proposalTypes: ['review_content'],
    confidenceFloor: 0.7,
    escalatesTo: 'moderator',
    actions: ['read', 'propose', 'escalate'],
    maxAttempts: 2,
  },
  intelligence: {
    id: 'intelligence',
    purpose: 'Summarise governed state for a reviewer.',
    readsEngines: ['E8', 'E11'],
    proposalTypes: ['summarise_state'],
    confidenceFloor: 0.5,
    escalatesTo: 'moderator',
    actions: ['read', 'propose', 'escalate'],
    maxAttempts: 2,
  },
};

export const declarationFor = (agentId: string): AgentDeclaration | undefined =>
  (AGENTS as Record<string, AgentDeclaration | undefined>)[agentId];

/**
 * The three prohibitions from Phase 46, as a checkable list.
 *
 * Stated here so a test can assert that **no agent anywhere** declares a proposal type
 * matching them — not just the organization agent. An agent acting for an organization
 * inherits the organization's prohibitions and cannot be granted more, and the way to
 * keep that true as agents are added is to check the whole registry.
 */
export const FORBIDDEN_PROPOSAL_PATTERNS: readonly RegExp[] = [
  /delete|remove_experience|purge/i,
  /dispute_claim|contest_user/i,
  /declare_resolv|mark_resolved|close_outcome/i,
];

export const forbiddenTypesIn = (declaration: AgentDeclaration): readonly string[] =>
  declaration.proposalTypes.filter((type) => FORBIDDEN_PROPOSAL_PATTERNS.some((pattern) => pattern.test(type)));

/**
 * Whether an agent could ever mutate governed state.
 *
 * `false`, by construction: `AgentAction` has no write verb, so there is no request an
 * agent could make that reaches an E1–E11 table. Asserted in a test rather than trusted
 * to review, because this is the property the whole band rests on.
 */
export const agentCanMutate = (): false => false;

export const validateDeclaration = (declaration: AgentDeclaration): Result<true, EngineError> => {
  if (declaration.confidenceFloor < 0 || declaration.confidenceFloor > 1) {
    return err(validationError('invalid_confidence_floor', 'a confidence floor is between 0 and 1'));
  }
  if (declaration.proposalTypes.length === 0 && declaration.actions.includes('propose')) {
    return err(validationError('propose_without_types', 'an agent that may propose must say what'));
  }
  const forbidden = forbiddenTypesIn(declaration);
  if (forbidden.length > 0) {
    return err(
      validationError('forbidden_proposal_type', `an agent may not propose ${forbidden.join(', ')}`, { forbidden }),
    );
  }
  return ok(true);
};
