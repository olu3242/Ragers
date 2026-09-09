import { err, ok } from '../runtime/result.ts';
import { notFoundError, preconditionError } from '../runtime/errors.ts';
import {
  assignCase,
  createCase,
  transitionCase,
  type CaseState,
  type OrganizationCase,
} from '../domain/case.ts';
import { eq, ne } from '../ports/store.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { OrganizationCaseRow, OrganizationMembership } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { organizationFor } from './organization.engine.ts';

/**
 * Organization Case Management — Phase 35, E9.
 *
 * A case is the organization's workspace over an experience. Everything it can do is
 * about the organization's own work — *have we looked at this, who has it, are we done
 * with our part* — and nothing it can do touches the experience.
 *
 * The rule enforced structurally rather than by review: this file writes to
 * `organization_cases` and nowhere else. There is no `deps.store.experiences.put` in
 * it, so no case transition can move a resolution status, and closing a case resolves
 * nothing. `closureIsNotResolution` in the domain module exists so a test can pin that.
 *
 * Membership is re-checked on every command against a live, unrevoked row. A pending
 * or revoked membership confers no authority, and the policy matrix cannot express
 * that — which is why `organizationFor` is called in the handler rather than trusted
 * from the resource ref.
 */
export const caseKey = (organizationId: string, experienceId: string): string =>
  `case:${organizationId}:${experienceId}`;

export interface OpenCaseInput {
  readonly organizationId: string;
  readonly experienceId: string;
}

export interface CaseResult {
  readonly caseId: string;
  readonly state: CaseState;
  readonly assigneeId?: string;
}

const requireMembership = async (
  deps: EngineDeps,
  actorId: string,
  organizationId: string,
): Promise<'ok' | 'refused'> => {
  const membership = await organizationFor(deps, actorId, organizationId);
  return membership ? 'ok' : 'refused';
};

export const registerCaseEngine = (deps: EngineDeps): void => {
  const open: CommandHandler<OpenCaseInput, CaseResult> = {
    name: 'case.open',
    action: 'case.manage',
    resolveResource: async (input) => ok({ type: 'organization_case', id: caseKey(input.organizationId, input.experienceId) }),
    handle: async (input, ctx) => {
      if ((await requireMembership(deps, ctx.actor.actorId, input.organizationId)) === 'refused') {
        return err(preconditionError('not_a_member', 'you do not act for that organization'));
      }
      const experience = await deps.store.experiences.get(input.experienceId);
      if (!experience) return err(notFoundError('experience_not_found', 'no such experience'));

      const id = caseKey(input.organizationId, input.experienceId);
      const existing = await deps.store.organizationCases.get(id);
      if (existing) {
        // Opening an open case is idempotent. Two staff clicking the same button must
        // land on one workspace, not two divergent ones.
        return ok({
          value: {
            caseId: existing.id,
            state: existing.state,
            ...(existing.assigneeId === undefined ? {} : { assigneeId: existing.assigneeId }),
          },
          events: [],
        });
      }

      const created = createCase(input, { id, correlationId: ctx.correlationId, now: ctx.clock.now() });
      if (!created.ok) return created;
      const won = await deps.store.organizationCases.compareAndSet(created.value, 'absent');
      if (!won) {
        const now = await deps.store.organizationCases.get(id);
        if (!now) return err(preconditionError('case_race', 'try that again'));
        return ok({ value: { caseId: now.id, state: now.state }, events: [] });
      }

      return ok({
        value: { caseId: created.value.id, state: created.value.state },
        events: [
          {
            aggregateType: 'organization',
            aggregateId: input.organizationId,
            eventName: 'CaseOpened',
            payload: {
              caseId: created.value.id,
              organizationId: input.organizationId,
              experienceId: input.experienceId,
            },
          },
        ],
      });
    },
  };

  const advance: CommandHandler<{ caseId: string; to: CaseState; note?: string }, CaseResult> = {
    name: 'case.transition',
    action: 'case.manage',
    resolveResource: async (input) => {
      const row = await deps.store.organizationCases.get(input.caseId);
      if (!row) return err(notFoundError('case_not_found', 'no such case'));
      return ok({ type: 'organization_case', id: row.id });
    },
    handle: async (input, ctx) => {
      const row = await deps.store.organizationCases.get(input.caseId);
      if (!row) return err(notFoundError('case_not_found', 'no such case'));
      if ((await requireMembership(deps, ctx.actor.actorId, row.organizationId)) === 'refused') {
        return err(preconditionError('not_a_member', 'you do not act for that organization'));
      }

      const moved = transitionCase(
        row,
        { to: input.to, ...(input.note === undefined ? {} : { note: input.note }) },
        ctx.clock.now(),
      );
      if (!moved.ok) return moved;
      await deps.store.organizationCases.put(moved.value);

      return ok({
        value: {
          caseId: moved.value.id,
          state: moved.value.state,
          ...(moved.value.assigneeId === undefined ? {} : { assigneeId: moved.value.assigneeId }),
        },
        events: [
          {
            aggregateType: 'organization',
            aggregateId: row.organizationId,
            eventName: 'CaseStateChanged',
            payload: {
              caseId: row.id,
              experienceId: row.experienceId,
              from: row.state,
              to: moved.value.state,
              // Said explicitly in the payload so no consumer has to infer it, and so
              // a future consumer cannot mistake a closure for an outcome.
              resolvesExperience: false,
            },
          },
        ],
      });
    },
  };

  const assign: CommandHandler<{ caseId: string; assigneeId?: string }, CaseResult> = {
    name: 'case.assign',
    action: 'case.manage',
    resolveResource: async (input) => {
      const row = await deps.store.organizationCases.get(input.caseId);
      if (!row) return err(notFoundError('case_not_found', 'no such case'));
      return ok({ type: 'organization_case', id: row.id });
    },
    handle: async (input, ctx) => {
      const row = await deps.store.organizationCases.get(input.caseId);
      if (!row) return err(notFoundError('case_not_found', 'no such case'));
      if ((await requireMembership(deps, ctx.actor.actorId, row.organizationId)) === 'refused') {
        return err(preconditionError('not_a_member', 'you do not act for that organization'));
      }
      // An assignee must themselves be a live member: assigning work to somebody whose
      // access was revoked would park the case with nobody able to open it.
      if (input.assigneeId !== undefined) {
        const target = await deps.store.organizationMemberships.queryOne([
          eq<OrganizationMembership>('organizationId', row.organizationId),
          eq<OrganizationMembership>('actorId', input.assigneeId),
        ]);
        if (!target || target.revokedAt !== undefined) {
          return err(preconditionError('assignee_not_a_member', 'that person does not act for this organization'));
        }
      }

      const assigned = assignCase(row, input.assigneeId, ctx.clock.now());
      if (!assigned.ok) return assigned;
      await deps.store.organizationCases.put(assigned.value);

      return ok({
        value: {
          caseId: assigned.value.id,
          state: assigned.value.state,
          ...(assigned.value.assigneeId === undefined ? {} : { assigneeId: assigned.value.assigneeId }),
        },
        events: [
          {
            aggregateType: 'organization',
            aggregateId: row.organizationId,
            eventName: 'CaseAssigned',
            payload: {
              caseId: row.id,
              experienceId: row.experienceId,
              assigned: assigned.value.assigneeId !== undefined,
            },
          },
        ],
      });
    },
  };

  deps.bus.register(open);
  deps.bus.register(advance);
  deps.bus.register(assign);
};

/** The open cases for an organization, most recently touched first. */
export const openCasesFor = async (
  deps: EngineDeps,
  organizationId: string,
): Promise<readonly OrganizationCaseRow[]> =>
  deps.store.organizationCases.query(
    [eq<OrganizationCaseRow>('organizationId', organizationId), ne<OrganizationCaseRow>('state', 'closed')],
    { orderBy: { field: 'updatedAt', direction: 'desc' }, limit: 100 },
  );

export const caseFor = async (
  deps: EngineDeps,
  organizationId: string,
  experienceId: string,
): Promise<OrganizationCase | undefined> =>
  deps.store.organizationCases.get(caseKey(organizationId, experienceId));
