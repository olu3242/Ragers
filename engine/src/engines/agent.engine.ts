import { err, ok } from '../runtime/result.ts';
import {
  authorise,
  declarationFor,
  type AgentAction,
  type AgentDeclaration,
  type AgentId,
} from '../domain/agent.ts';
import { preconditionError } from '../runtime/errors.ts';
import { eq } from '../ports/store.ts';
import type { EngineId } from '../domain/proposal.ts';
import type { AssistanceReference } from '../ports/providers.ts';
import type { AgentRunRow, OrganizationResponse, ResolutionReportRow } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * The agent runner — Phases 44–46, E12.
 *
 * One file, and its shape is the argument. A run does exactly three things it is allowed
 * to do: read declared state, ask the assistance provider for a suggestion over that
 * state, and dispatch `proposal.create`. There is **no other dispatch in this file** — no
 * `experience.*`, no `moderation.*`, no `resolution.*` — so an agent cannot mutate
 * governed state even by mistake, and a future edit that tries has to add a dispatch a
 * reviewer would see.
 *
 * The chain, stated once: analysis → proposal → a person decides → the target engine's own
 * command → effect → outcome. Approving still goes through `proposal.decide`, which
 * dispatches the target engine's command, which can refuse — so an approved agent proposal
 * is no more privileged than an approved human one.
 *
 * When no model provider is configured the deterministic provider answers with
 * `confidence: 0.5`, which is *below* most agents' floors. They therefore escalate rather
 * than propose, and that is the correct behaviour: it is the difference between "we have no
 * model" and "we have a model that is very sure about nothing".
 */
export interface AgentRunInput {
  readonly agentId: AgentId;
  readonly subjectId: string;
  readonly proposalType: string;
  /** The engine whose state the agent reads. Refused unless declared. */
  readonly engine: EngineId;
  /** The engine that would carry out the proposed action if a person approves it. */
  readonly targetEngine: EngineId;
}

export type AgentOutcome = 'proposed' | 'escalated' | 'refused' | 'provider_unavailable';

export interface AgentRunResult {
  readonly runId: string;
  readonly agentId: AgentId;
  readonly outcome: AgentOutcome;
  readonly proposalId?: string;
  /** Why it escalated or was refused, verbatim. Never summarised away. */
  readonly detail?: string;
}

export const agentRunKey = (agentId: string, subjectId: string, proposalType: string): string =>
  `agr:${agentId}:${proposalType}:${subjectId}`;

/**
 * Governed state an agent may reason over, gathered by the engine rather than the provider.
 *
 * A provider is handed text that has already been read and already been redacted. It never
 * gets a query, a table or a command — which is what makes a compromised or hallucinating
 * provider unable to reach anything.
 */
const contextFor = async (
  deps: EngineDeps,
  input: AgentRunInput,
): Promise<{ context: { label: string; text: string }[]; references: AssistanceReference[] }> => {
  const context: { label: string; text: string }[] = [];
  const references: AssistanceReference[] = [];

  const experience = await deps.store.experiences.get(input.subjectId);
  if (experience) {
    references.push({ kind: 'experience', id: experience.id });
    // Counts and states, never the body text: an agent summarising a pattern does not
    // need to be handed somebody's account verbatim to do it.
    context.push({ label: `kind ${experience.kind}`, text: experience.kind });
    context.push({
      label: `outcome ${experience.resolutionStatus ?? 'open'}`,
      text: experience.resolutionStatus ?? 'open',
    });
  }

  if (input.engine === 'E9') {
    const responses = await deps.store.organizationResponses.query([
      eq<OrganizationResponse>('experienceId', input.subjectId),
    ]);
    context.push({
      label: `${responses.length} organization ${responses.length === 1 ? 'response' : 'responses'}`,
      text: String(responses.length),
    });
  }

  if (input.engine === 'E10') {
    const reports = await deps.store.resolutionReports.query([
      eq<ResolutionReportRow>('experienceId', input.subjectId),
    ]);
    context.push({
      label: `${reports.length} ${reports.length === 1 ? 'report' : 'reports'} of the outcome`,
      text: String(reports.length),
    });
  }

  return { context, references };
};

/**
 * Run one agent.
 *
 * Idempotent on (agent, proposal type, subject): a sweep that runs hourly must not hand a
 * reviewer twenty-four copies of one suggestion, and the run ledger is the only thing
 * concurrent callers can collide on.
 */
export const runAgent = async (
  deps: EngineDeps,
  input: AgentRunInput,
  reviewer: { actorId: string; role: 'moderator' | 'admin' },
): Promise<AgentRunResult> => {
  const declaration = declarationFor(input.agentId);
  const runId = agentRunKey(input.agentId, input.subjectId, input.proposalType);

  const record = async (result: AgentRunResult): Promise<AgentRunResult> => {
    const row: AgentRunRow = {
      id: runId,
      agentId: input.agentId,
      subjectId: input.subjectId,
      proposalType: input.proposalType,
      outcome: result.outcome,
      ...(result.proposalId === undefined ? {} : { proposalId: result.proposalId }),
      ...(result.detail === undefined ? {} : { detail: result.detail }),
      createdAt: deps.clock.now(),
    };
    await deps.store.agentRuns.put(row);
    deps.metrics.increment('agent.run', { agent: input.agentId, outcome: result.outcome });
    return result;
  };

  // Read authorisation first, against the agent's own declaration. Refused for the right
  // reason, which the certification asserts by attempting the excess.
  const mayRead = authorise(declaration, { agentId: input.agentId, action: 'read', engine: input.engine });
  if (!mayRead.ok) {
    return record({ runId, agentId: input.agentId, outcome: 'refused', detail: mayRead.error.message });
  }

  const existing = await deps.store.agentRuns.get(runId);
  if (existing) {
    return {
      runId,
      agentId: input.agentId,
      outcome: existing.outcome as AgentOutcome,
      ...(existing.proposalId === undefined ? {} : { proposalId: existing.proposalId }),
      ...(existing.detail === undefined ? {} : { detail: existing.detail }),
    };
  }

  /**
   * Claim the run *before* doing any work.
   *
   * The read above cannot arbitrate a race: six concurrent sweeps all saw no row, all called
   * the provider, and all dispatched `proposal.create` under the same idempotency key —
   * where the losers got a successful replay carrying no proposal id, and recorded `proposed`
   * with nothing to point at. The database's coherence constraint caught it, which is what
   * it is for, but the defect was here.
   *
   * `compareAndSet` on the ledger row names one winner. The claim is recorded as `escalated`
   * with no proposal id, which is a coherent row on its own, and is overwritten by the real
   * outcome below — so a crash mid-run leaves a truthful "handed on, nothing proposed"
   * rather than a claim the proposal table cannot corroborate.
   */
  const claimed = await deps.store.agentRuns.compareAndSet(
    {
      id: runId,
      agentId: input.agentId,
      subjectId: input.subjectId,
      proposalType: input.proposalType,
      outcome: 'escalated',
      detail: 'claimed; the run has not finished',
      createdAt: deps.clock.now(),
    },
    'absent',
  );
  if (!claimed) {
    const winner = await deps.store.agentRuns.get(runId);
    return {
      runId,
      agentId: input.agentId,
      outcome: (winner?.outcome ?? 'escalated') as AgentOutcome,
      ...(winner?.proposalId === undefined ? {} : { proposalId: winner.proposalId }),
      ...(winner?.detail === undefined ? {} : { detail: winner.detail }),
    };
  }

  const { context, references } = await contextFor(deps, input);
  const suggestion = await deps.providers.assistance.assist({
    task: input.proposalType,
    context,
    references,
  });
  if (!suggestion.ok) {
    // Fail closed: no proposal at all rather than one with an empty rationale.
    return record({
      runId,
      agentId: input.agentId,
      outcome: 'provider_unavailable',
      detail: suggestion.error.message,
    });
  }

  const mayPropose = authorise(declaration, {
    agentId: input.agentId,
    action: 'propose',
    proposalType: input.proposalType,
    confidence: suggestion.value.confidence,
  });
  if (!mayPropose.ok) {
    // These are two different things and must not be recorded as one.
    //
    //   below its floor      → `escalated`. Caution. It hands the decision to a person,
    //                          which is what it is supposed to do when unsure.
    //   outside its domain   → `refused`. An agent asked for something its own declaration
    //                          does not permit, which is a signal worth being able to find
    //                          in the ledger later.
    //
    // Conflating them would mean a domain violation looked like ordinary caution, and the
    // one query somebody would run after an incident — "what did agents try to do that they
    // were not allowed to?" — would return nothing.
    const outcome = mayPropose.error.code === 'below_confidence_floor' ? 'escalated' : 'refused';
    return record({ runId, agentId: input.agentId, outcome, detail: mayPropose.error.message });
  }

  const created = await deps.bus.dispatch<unknown, { proposalId: string }>({
    name: 'proposal.create',
    input: {
      proposalType: input.proposalType,
      sourceEngine: 'E12',
      targetEngine: input.targetEngine,
      subjectId: input.subjectId,
      summary: suggestion.value.summary,
      rationale: suggestion.value.rationale,
      confidence: suggestion.value.confidence,
      evidenceRefs: suggestion.value.references,
      // Deliberately no `proposedCommand`: an agent hands a person a situation, and does
      // not pre-authorise an action against anybody.
    },
    actor: { actorId: reviewer.actorId, role: reviewer.role, authenticated: true },
    idempotencyKey: `agent:${runId}`,
    correlationId: `agent:${runId}`,
  });

  if (!created.ok) {
    return record({ runId, agentId: input.agentId, outcome: 'refused', detail: created.error.message });
  }
  // A successful dispatch that returns no id is not a proposal. It happens on an
  // idempotency replay whose original had not completed, and recording `proposed` for it
  // would claim something the proposal ledger cannot corroborate.
  if (!created.value?.proposalId) {
    return record({
      runId,
      agentId: input.agentId,
      outcome: 'escalated',
      detail: 'the proposal was already being created by another run; nothing new was proposed',
    });
  }
  return record({
    runId,
    agentId: input.agentId,
    outcome: 'proposed',
    proposalId: created.value.proposalId,
  });
};

/**
 * Phase 46 — the organization resolution agent, as a named entry point.
 *
 * It reads E9 and E10 and proposes a draft response or a remediation suggestion. Its three
 * prohibitions are structural rather than stated: there is no proposal type in its
 * declaration for deletion, for disputing a user's claim, or for declaring a resolution,
 * and `authorise` refuses a type that is not listed. An organization's own write path to
 * `experiences` does not exist either, so an approved proposal from this agent still cannot
 * do those things.
 */
export const runOrganizationResolutionAgent = async (
  deps: EngineDeps,
  experienceId: string,
  reviewer: { actorId: string; role: 'moderator' | 'admin' },
): Promise<AgentRunResult> =>
  runAgent(
    deps,
    {
      agentId: 'organization_response',
      subjectId: experienceId,
      proposalType: 'draft_organization_response',
      engine: 'E9',
      targetEngine: 'E9',
    },
    reviewer,
  );

/** Refuse anything that is not one of the three declared verbs. */
export const refuseAgentAction = (agentId: string, action: string) =>
  err(
    preconditionError('agent_action_unavailable', `${agentId} has no way to ${action}`, {
      // Named so the refusal reads as structural rather than as a missing feature.
      reason: 'an agent analyses, proposes and escalates; it has no write verb',
    }),
  );

export const agentRunsFor = async (deps: EngineDeps, subjectId: string): Promise<readonly AgentRunRow[]> =>
  deps.store.agentRuns.query([eq<AgentRunRow>('subjectId', subjectId)]);

export type { AgentAction, AgentDeclaration };
