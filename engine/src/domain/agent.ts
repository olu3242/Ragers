import { err, ok, type Result } from '../runtime/result.ts';
import { preconditionError, validationError, type EngineError } from '../runtime/errors.ts';
import { hasAtLeast, ROLE_RANK, type Role } from '../runtime/authz.ts';
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

  // ── Phase 91: the rest of the authority, stated ────────────────────────

  /**
   * Engines a proposal from this agent may be *aimed at*, which is not what it reads.
   *
   * The distinction matters because reading and targeting fail differently. An agent reading
   * an engine it should not see is a disclosure; an agent proposing *into* an engine it has no
   * business in is an attempt to act. `intake` reads E1 and E2 and targets E1 — it suggests
   * structure for the author to confirm. Nothing targets E12, because E12 is where proposals
   * come from and a proposal aimed at the proposal engine is a loop.
   */
  readonly targetEngines: readonly EngineId[];

  /**
   * Commands this agent may never appear in the lineage of, whatever anybody approves.
   *
   * Not the same as `FORBIDDEN_PROPOSAL_PATTERNS`, which filters proposal *types* by name. This
   * names actual registered commands, so a proposal whose type reads innocently cannot become a
   * plan step that deletes something. Checked against `bus.registeredCommands()` by a discovery
   * guard, so an entry naming a command that no longer exists fails rather than reading as
   * protection.
   */
  readonly forbiddenCommands: readonly string[];

  /**
   * The minimum **platform role** a person must hold to act on this agent's proposals.
   *
   * **Agent authority is not actor authority**, and this field is where the two meet without
   * merging. It states the minimum; the policy matrix still evaluates that reviewer against the
   * actual command at execution time, and can still refuse. Neither substitutes for the other:
   * this cannot grant what the matrix withholds, and the matrix cannot widen what this requires.
   *
   * ## A correction, kept because the mistake is the instructive one
   *
   * The first version of this field read `'moderator' | 'organization' | 'admin'`, and
   * `organization` is **not a role.** `Role` is `guest | member | moderator | admin`; acting for
   * an organization is a *membership*, checked separately by `organizationFor` against
   * `organization_memberships`, and it is orthogonal to the ladder — an organization's admin is
   * not a kind of platform moderator.
   *
   * So `requiredAuthority: 'organization'` was a value nothing could ever satisfy, and the
   * `organization_response` agent was unactionable the moment the check went in. That is exactly
   * the conflation this phase exists to prevent, committed in the field written to prevent it:
   * two authority models merged into one enum because both had a word that sounded like a rank.
   *
   * The vocabulary is the role ladder and nothing else. Whether the acting party is the right
   * *organization* is `organization.respond`'s own question, and it already asks it.
   */
  readonly requiredAuthority: 'moderator' | 'admin';

  /**
   * How many openable rows a proposal from this agent must point at.
   *
   * Separate from `confidenceFloor` because **a model can be confident about nothing.**
   * Confidence is the agent's own report of its certainty and is not evidence; this floor is
   * about whether a reviewer has anything to check. An agent that cannot cite rows escalates
   * rather than proposing, however sure it says it is.
   *
   * The number reflects what the agent's subject *is*. One for an agent looking at a single
   * experience — the experience is the thing to open. **Two for an agent claiming a pattern**
   * (`matching`, `trend`), because a pattern over one row is not a pattern, and that is where
   * this floor does work beyond "cites something".
   */
  readonly evidenceFloor: number;

  /**
   * What it does when a dependency it needs is unavailable.
   *
   * `escalate` hands the situation to a person; `skip` produces nothing and says so. Never
   * `proceed`: an agent continuing on a degraded dependency is an agent proposing from partial
   * state without saying which part is missing, and the reviewer cannot tell.
   */
  readonly degradedBehaviour: 'escalate' | 'skip';
}

export interface AgentRequest {
  readonly agentId: AgentId;
  readonly action: AgentAction;
  /** The engine whose state it wants to read, for a `read`. */
  readonly engine?: EngineId;
  /** The proposal type, for a `propose`. */
  readonly proposalType?: string;
  readonly confidence?: number;

  // ── Phase 91 ──
  /** The engine the proposal is aimed at, for a `propose`. */
  readonly targetEngine?: EngineId;
  /** How many openable rows the proposal cites. Not the agent's opinion of itself. */
  readonly evidenceCount?: number;
  /** A command the resulting plan would run, when one is already known. */
  readonly command?: string;
  /** The role of the person who would act on it. */
  readonly actorRole?: string;
  /** Whether an operator has paused this agent. Phase 94 supplies it; default is not paused. */
  readonly paused?: boolean;
}

export type AgentRefusal =
  | 'unknown_agent'
  | 'action_not_declared'
  | 'engine_not_declared'
  | 'proposal_type_not_declared'
  | 'below_confidence_floor'
  | 'mutation_not_possible'
  // ── Phase 91 ──
  | 'target_engine_not_declared'
  | 'command_forbidden'
  | 'below_evidence_floor'
  | 'authority_insufficient'
  | 'agent_paused';

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

  // Phase 94's control, checked before anything else an agent might be allowed to do. A paused
  // agent is refused at the engine rather than hidden in a surface: a kill switch enforced by
  // not rendering a button is not a kill switch.
  if (request.paused === true) {
    return err(
      preconditionError('agent_paused', `${request.agentId} is paused by an operator`, {
        refusal: 'agent_paused',
      }),
    );
  }

  // Phase 91: the command allowlist, checked for every action rather than only for `propose`.
  // A forbidden command must be refused however the request is dressed — and it is checked
  // *before* the action-specific branches so that a read carrying a command is refused too.
  if (request.command !== undefined && declaration.forbiddenCommands.includes(request.command)) {
    return err(
      preconditionError(
        'command_forbidden',
        `${request.agentId} may never be in the lineage of ${request.command}`,
        { refusal: 'command_forbidden', command: request.command },
      ),
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

    // Phase 91: the target engine, which is not what it reads. An agent proposing *into* an
    // engine it has no business in is an attempt to act, and fails differently from reading
    // one it should not see.
    if (request.targetEngine === undefined || !declaration.targetEngines.includes(request.targetEngine)) {
      return err(
        preconditionError(
          'target_engine_not_declared',
          `${request.agentId} may not aim a proposal at ${request.targetEngine ?? 'nothing'}`,
          { refusal: 'target_engine_not_declared' },
        ),
      );
    }

    // Phase 91: evidence, separately from confidence, because **a model can be confident
    // about nothing.** This floor asks whether the reviewer has anything to open.
    const evidence = request.evidenceCount ?? 0;
    if (evidence < declaration.evidenceFloor) {
      return err(
        preconditionError(
          'below_evidence_floor',
          `${request.agentId} cites ${evidence} row(s) and needs ${declaration.evidenceFloor}; it must escalate to ${declaration.escalatesTo}`,
          { refusal: 'below_evidence_floor', floor: declaration.evidenceFloor },
        ),
      );
    }

    // Phase 91: the authority pairing. This is the *minimum* the acting person must hold, and
    // it narrows only — the policy matrix still evaluates that person against the real command
    // at execution time and can still refuse. When no actor is named the check is deferred
    // rather than waived: `authoriseWithActor` is what pairs them, and a bare `authorise` has
    // no actor to pair with.
    if (request.actorRole !== undefined && !satisfiesAuthority(request.actorRole, declaration.requiredAuthority)) {
      return err(
        preconditionError(
          'authority_insufficient',
          `acting on a ${request.agentId} proposal requires ${declaration.requiredAuthority}`,
          { refusal: 'authority_insufficient', required: declaration.requiredAuthority },
        ),
      );
    }
  }

  return ok(true);
};

/**
 * Whether a role meets a declaration's required authority.
 *
 * The role ladder, and only the ladder: `admin` satisfies `moderator`, and nothing below
 * `moderator` satisfies anything. `ROLE_RANK` is the single place that ordering is decided, so
 * this composes it rather than restating it — a second comparison would be a second ladder, and
 * the two would disagree the first time a role is added.
 *
 * Organization membership deliberately does not appear here. It is not a rank; it is a fact about
 * which organization somebody may act for, and `organization.respond` already asks it.
 */
export const satisfiesAuthority = (
  role: string,
  required: AgentDeclaration['requiredAuthority'],
): boolean => {
  if (!(role in ROLE_RANK)) return false;
  return hasAtLeast(role as Role, required);
};

/**
 * Authorise an agent request *and* the person who would act on it — Phase 91.
 *
 * The two are checked together and neither is allowed to stand in for the other. This is the
 * function a caller should reach for when an actor is known, and the reason it exists as its own
 * name is that `authorise(declaration, request)` with the actor omitted is a legitimate call —
 * an agent authorising its own read has no actor — and a caller must not be able to get the
 * weaker check by forgetting a field.
 */
export const authoriseWithActor = (
  declaration: AgentDeclaration | undefined,
  request: AgentRequest,
  actor: { readonly role: string },
): Result<true, EngineError> => authorise(declaration, { ...request, actorRole: actor.role });

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
    targetEngines: ['E1'],
    forbiddenCommands: ['experience.delete', 'creator.requestExport', 'identity.revokeSession', 'governance.grantRole'],
    requiredAuthority: 'moderator',
    evidenceFloor: 1,
    degradedBehaviour: 'escalate',
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
    targetEngines: ['E1', 'E3'],
    forbiddenCommands: ['experience.delete', 'creator.requestExport', 'identity.revokeSession', 'governance.grantRole'],
    requiredAuthority: 'moderator',
    evidenceFloor: 1,
    degradedBehaviour: 'escalate',
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
    targetEngines: ['E7'],
    forbiddenCommands: ['experience.delete', 'creator.requestExport', 'identity.revokeSession', 'governance.grantRole'],
    requiredAuthority: 'moderator',
    evidenceFloor: 2,
    degradedBehaviour: 'escalate',
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
    targetEngines: ['E9'],
    forbiddenCommands: ['experience.delete', 'creator.requestExport', 'identity.revokeSession', 'governance.grantRole'],
    requiredAuthority: 'moderator',
    evidenceFloor: 1,
    degradedBehaviour: 'escalate',
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
    targetEngines: ['E8'],
    forbiddenCommands: ['experience.delete', 'creator.requestExport', 'identity.revokeSession', 'governance.grantRole'],
    requiredAuthority: 'moderator',
    evidenceFloor: 2,
    degradedBehaviour: 'escalate',
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
    targetEngines: ['E10'],
    forbiddenCommands: [...['experience.delete', 'creator.requestExport', 'identity.revokeSession', 'governance.grantRole'], ...['resolution.report', 'dispute.review']],
    requiredAuthority: 'moderator',
    evidenceFloor: 1,
    degradedBehaviour: 'escalate',
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
    targetEngines: ['E9'],
    forbiddenCommands: [...['experience.delete', 'creator.requestExport', 'identity.revokeSession', 'governance.grantRole'], ...['resolution.report', 'dispute.review']],
    requiredAuthority: 'moderator',
    evidenceFloor: 1,
    degradedBehaviour: 'escalate',
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
    targetEngines: ['E9'],
    forbiddenCommands: [...['experience.delete', 'creator.requestExport', 'identity.revokeSession', 'governance.grantRole'], 'safety.applyModerationAction', 'dispute.review'],
    requiredAuthority: 'moderator',
    evidenceFloor: 1,
    degradedBehaviour: 'escalate',
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
    targetEngines: ['E11'],
    forbiddenCommands: ['experience.delete', 'creator.requestExport', 'identity.revokeSession', 'governance.grantRole'],
    requiredAuthority: 'moderator',
    evidenceFloor: 1,
    degradedBehaviour: 'skip',
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

  // ── Phase 91 ──
  if (declaration.actions.includes('propose') && declaration.targetEngines.length === 0) {
    return err(validationError('propose_without_target', 'an agent that may propose must say into what'));
  }
  // **Nothing may target E12.** Proposals come *from* E12; one aimed at it is a loop, and a
  // loop through the proposal engine is how an agent reaches its own output as if it were
  // governed state somebody approved.
  if (declaration.targetEngines.includes('E12')) {
    return err(
      validationError('cannot_target_e12', 'a proposal aimed at the proposal engine is a loop'),
    );
  }
  if (declaration.evidenceFloor < 0) {
    return err(validationError('invalid_evidence_floor', 'an evidence floor is a count of rows'));
  }
  // An agent that may propose must cite something. A zero floor would let a proposal reach a
  // reviewer with nothing to open, which is the shape `basis_required` already refuses one
  // level down — stated here too so the declaration cannot promise less than the domain.
  if (declaration.actions.includes('propose') && declaration.evidenceFloor < 1) {
    return err(
      validationError('evidence_floor_too_low', 'a proposal a reviewer cannot check is not a proposal'),
    );
  }
  if (declaration.forbiddenCommands.length === 0) {
    return err(
      validationError(
        'no_forbidden_commands',
        'default deny: a declaration that forbids nothing has not been thought about',
      ),
    );
  }
  return ok(true);
};
