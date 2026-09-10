import { err, ok } from '../runtime/result.ts';
import { notFoundError, preconditionError } from '../runtime/errors.ts';
import {
  createProposal,
  decideProposal,
  expireProposal,
  isProposalOpen,
  type EngineId,
  type ProposalStatus,
} from '../domain/proposal.ts';
import { eq } from '../ports/store.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { ProposalRow } from '../ports/store.ts';
import { writeAudit } from './support.ts';
import type { EngineDeps } from './deps.ts';

/**
 * Intelligence Engine — E12, governed.
 *
 * The boundary, stated once and enforced structurally: **approving a proposal does
 * not write to any E1–E11 table.** It dispatches the target engine's own command
 * through the same bus, so the approved action is subject to every authorization
 * check, precondition and outbox guarantee a human doing the same thing would face.
 *
 * That means an approval can *fail*, and the failure is recorded on the proposal
 * (`dispatchError`) rather than swallowed. A proposal marked approved whose command
 * was refused downstream is visibly different from one that took effect —
 * conflating those two is precisely how an advisory layer becomes an unaccountable
 * one.
 *
 * There are no autonomous agents here. Nothing creates a proposal without a
 * caller, and nothing approves one without a reviewer.
 */
export interface CreateProposalCommandInput {
  readonly proposalType: string;
  readonly sourceEngine: EngineId;
  readonly targetEngine: EngineId;
  readonly subjectId: string;
  readonly summary: string;
  readonly rationale: string;
  readonly confidence: number;
  readonly evidenceRefs: readonly { kind: string; id: string }[];
  readonly proposedCommand?: string;
  readonly proposedInput?: Record<string, unknown>;
  readonly expiresAt?: number;
}

export interface DecideProposalCommandInput {
  readonly proposalId: string;
  readonly outcome: ProposalStatus;
  readonly note?: string;
}

export interface DecideProposalResult {
  readonly status: ProposalStatus;
  /** Whether the target engine's command actually ran, and what it said. */
  readonly dispatched: boolean;
  readonly dispatchError?: string;
}

export const registerProposalEngine = (deps: EngineDeps): void => {
  const create: CommandHandler<CreateProposalCommandInput, { proposalId: string; status: ProposalStatus }> = {
    name: 'proposal.create',
    action: 'proposal.create',
    resolveResource: async () => ok({ type: 'proposal' }),
    handle: async (input, ctx) => {
      const created = createProposal(
        { ...input },
        { id: deps.ids.next('prp'), correlationId: ctx.correlationId, now: ctx.clock.now() },
      );
      if (!created.ok) return created;
      await deps.store.proposals.put(created.value);
      deps.metrics.increment('proposal.created', { type: created.value.proposalType });

      return ok({
        value: { proposalId: created.value.id, status: created.value.status },
        events: [
          {
            aggregateType: 'proposal',
            aggregateId: created.value.id,
            eventName: 'IntelligenceProposalCreated',
            payload: {
              proposalId: created.value.id,
              proposalType: created.value.proposalType,
              sourceEngine: created.value.sourceEngine,
              targetEngine: created.value.targetEngine,
              subjectId: created.value.subjectId,
              confidence: created.value.confidence,
              evidenceCount: created.value.evidenceRefs.length,
            },
          },
        ],
      });
    },
  };

  const decide: CommandHandler<DecideProposalCommandInput, DecideProposalResult> = {
    name: 'proposal.decide',
    action: 'proposal.decide',
    resolveResource: async (input) => {
      const row = await deps.store.proposals.get(input.proposalId);
      if (!row) return err(notFoundError('proposal_not_found', 'no such proposal'));
      return ok({ type: 'proposal', id: row.id });
    },
    handle: async (input, ctx) => {
      const row = await deps.store.proposals.get(input.proposalId);
      if (!row) return err(notFoundError('proposal_not_found', 'no such proposal'));

      const decided = decideProposal(
        row,
        {
          to: input.outcome,
          reviewerId: ctx.actor.actorId,
          ...(input.note === undefined ? {} : { note: input.note }),
        },
        ctx.clock.now(),
      );
      if (!decided.ok) return decided;

      let dispatched = false;
      let dispatchError: string | undefined;

      if (decided.value.status === 'approved' && decided.value.proposedCommand) {
        // Through the bus, as the reviewer, with a fresh idempotency key derived
        // from the proposal so a replayed approval cannot run the action twice.
        const outcome = await deps.bus.dispatch({
          name: decided.value.proposedCommand,
          input: decided.value.proposedInput,
          actor: ctx.actor,
          idempotencyKey: `proposal:${decided.value.id}`,
          correlationId: ctx.correlationId,
        });
        dispatched = outcome.ok;
        if (!outcome.ok) {
          // The refusal is the target engine's, kept verbatim: an approval the
          // governed engine declined is not an approval that happened.
          dispatchError = `${outcome.error.code}: ${outcome.error.message}`;
        }
      }

      await deps.store.proposals.put({
        ...decided.value,
        ...(dispatched ? { dispatchedAt: ctx.clock.now() } : {}),
        ...(dispatchError === undefined ? {} : { dispatchError }),
      });

      // Phase 68, clause 1: a person decided whether a machine's suggestion about somebody
      // would be acted on. `dispatched` is recorded because approval and effect are
      // different things — a proposal can be approved and still refused by the engine that
      // owns the action, and the trail has to distinguish them.
      await writeAudit(deps, ctx, {
        action: 'proposal.decide',
        resourceType: 'proposal',
        resourceId: decided.value.id,
        before: { status: row.status },
        after: { status: decided.value.status, dispatched },
      });

      const eventName =
        decided.value.status === 'approved'
          ? 'IntelligenceProposalApproved'
          : decided.value.status === 'rejected'
            ? 'IntelligenceProposalRejected'
            : 'IntelligenceProposalEscalated';

      return ok({
        value: {
          status: decided.value.status,
          dispatched,
          ...(dispatchError === undefined ? {} : { dispatchError }),
        },
        events: [
          {
            aggregateType: 'proposal',
            aggregateId: decided.value.id,
            eventName,
            payload: {
              proposalId: decided.value.id,
              targetEngine: decided.value.targetEngine,
              subjectId: decided.value.subjectId,
              // Whether the governed action actually ran, which is the part that
              // matters and is not implied by the status.
              dispatched,
              ...(dispatchError === undefined ? {} : { dispatchError }),
            },
          },
        ],
      });
    },
  };

  const expire: CommandHandler<{ proposalId: string }, { status: ProposalStatus }> = {
    name: 'proposal.expire',
    action: 'proposal.decide',
    resolveResource: async (input) => {
      const row = await deps.store.proposals.get(input.proposalId);
      if (!row) return err(notFoundError('proposal_not_found', 'no such proposal'));
      return ok({ type: 'proposal', id: row.id });
    },
    handle: async (input, ctx) => {
      const row = await deps.store.proposals.get(input.proposalId);
      if (!row) return err(notFoundError('proposal_not_found', 'no such proposal'));
      const expired = expireProposal(row, ctx.clock.now());
      if (!expired.ok) return expired;
      await deps.store.proposals.put(expired.value);
      return ok({
        value: { status: expired.value.status },
        events: [
          {
            aggregateType: 'proposal',
            aggregateId: row.id,
            eventName: 'IntelligenceProposalExpired',
            payload: { proposalId: row.id },
          },
        ],
      });
    },
  };

  deps.bus.register(create);
  deps.bus.register(decide);
  deps.bus.register(expire);
};

/** Open proposals awaiting a decision. Internal: moderator-only by policy. */
export const openProposals = async (deps: EngineDeps): Promise<readonly ProposalRow[]> => {
  const proposed = await deps.store.proposals.query([eq<ProposalRow>('status', 'proposed')], {
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: 100,
  });
  const escalated = await deps.store.proposals.query([eq<ProposalRow>('status', 'escalated')], {
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: 100,
  });
  return [...proposed, ...escalated].filter((row) => isProposalOpen(row.status));
};

/**
 * Guard for anything that would let a proposal write directly.
 *
 * Exists so the boundary is expressible in a test: any code path that reaches an
 * E1–E11 store from proposal handling should be going through the bus instead, and
 * this is the error it gets if it does not.
 */
export const refuseDirectMutation = (targetEngine: EngineId) =>
  err(
    preconditionError(
      'proposal_cannot_mutate_directly',
      `a proposal must reach ${targetEngine} through its own command, not by writing its state`,
      { targetEngine },
    ),
  );
