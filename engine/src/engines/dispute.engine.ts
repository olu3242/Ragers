import { err, ok } from '../runtime/result.ts';
import { conflictError, notFoundError, preconditionError } from '../runtime/errors.ts';
import {
  isContested,
  openDispute,
  reviewDispute,
  withdrawDispute,
  type DisputeOrigin,
  type DisputeStatus,
} from '../domain/dispute.ts';
import { eq } from '../ports/store.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { CorroborationRow, DisputeRow } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { experienceResource, loadExperience } from './support.ts';
import { organizationFor } from './organization.engine.ts';

/**
 * Dispute Engine — E10.
 *
 * Standing is resolved here because the policy matrix cannot express it: an
 * experiencer is the author or an active corroborator, and an organization party is
 * a member of the organization the experience is about. Both are legitimate
 * disputers of different things, and somebody who is neither has no standing at
 * all.
 *
 * The rule that makes a dispute worth having: **the disputed party cannot close
 * it.** There is no command here that lets an organization settle a consumer's
 * dispute, and `dispute.review` is moderator-only.
 */

export const standingFor = async (
  deps: EngineDeps,
  experienceId: string,
  actorId: string,
  organizationId?: string,
): Promise<DisputeOrigin | undefined> => {
  const experience = await deps.store.experiences.get(experienceId);
  if (!experience) return undefined;

  if (organizationId !== undefined) {
    const scope = await organizationFor(deps, actorId, organizationId);
    // Only about their own entity: disputing somebody else's case would be
    // speaking for an organization the experience is not about.
    if (scope && scope.profile.entityId === experience.entityId) return 'organization';
    return undefined;
  }

  if (experience.actorId === actorId) return 'experiencer';
  const claim = await deps.store.corroborations.queryOne([
    eq<CorroborationRow>('experienceId', experienceId),
    eq<CorroborationRow>('corroboratorId', actorId),
    eq<CorroborationRow>('status', 'active'),
  ]);
  return claim ? 'experiencer' : undefined;
};

export interface OpenDisputeCommandInput {
  readonly experienceId: string;
  readonly responseId?: string;
  readonly organizationId?: string;
  readonly reason: string;
  readonly detail?: string;
}

export interface OpenDisputeResult {
  readonly disputeId: string;
  readonly origin: DisputeOrigin;
  readonly status: DisputeStatus;
  /** True while any dispute on this experience is live. */
  readonly contested: boolean;
}

export const registerDisputeEngine = (deps: EngineDeps): void => {
  const open: CommandHandler<OpenDisputeCommandInput, OpenDisputeResult> = {
    name: 'dispute.open',
    action: 'dispute.open',
    resolveResource: async (input) => experienceResource(deps.store, input.experienceId),
    handle: async (input, ctx) => {
      const loaded = await loadExperience(deps.store, input.experienceId);
      if (!loaded.ok) return loaded;
      if (loaded.value.status !== 'published') {
        return err(preconditionError('experience_not_published', 'only a published experience can be disputed'));
      }

      const origin = await standingFor(
        deps,
        input.experienceId,
        ctx.actor.actorId,
        input.organizationId,
      );
      if (!origin) {
        return err(
          preconditionError(
            'no_standing_to_dispute',
            'only the people this happened to, or the organization it is about, can dispute it',
          ),
        );
      }

      // One live dispute per person per experience. Without this, the same
      // grievance filed repeatedly would make one objection look like many.
      const existing = await deps.store.disputes.queryOne([
        eq<DisputeRow>('experienceId', input.experienceId),
        eq<DisputeRow>('raisedBy', ctx.actor.actorId),
        eq<DisputeRow>('status', 'open'),
      ]);
      const alsoUnderReview = existing
        ? undefined
        : await deps.store.disputes.queryOne([
            eq<DisputeRow>('experienceId', input.experienceId),
            eq<DisputeRow>('raisedBy', ctx.actor.actorId),
            eq<DisputeRow>('status', 'under_review'),
          ]);
      const live = existing ?? alsoUnderReview;
      if (live) {
        return err(
          conflictError('dispute_already_open', 'you already have a dispute open on this', {
            disputeId: live.id,
          }),
        );
      }

      if (input.responseId !== undefined) {
        const response = await deps.store.organizationResponses.get(input.responseId);
        if (!response || response.experienceId !== input.experienceId) {
          return err(notFoundError('response_not_found', 'no such response on that experience'));
        }
      }

      const created = openDispute(
        {
          experienceId: input.experienceId,
          ...(input.responseId === undefined ? {} : { responseId: input.responseId }),
          origin,
          raisedBy: ctx.actor.actorId,
          ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
          reason: input.reason,
          ...(input.detail === undefined ? {} : { detail: input.detail }),
        },
        { id: deps.ids.next('dsp'), correlationId: ctx.correlationId, now: ctx.clock.now() },
      );
      if (!created.ok) return created;

      await deps.store.disputes.put(created.value);
      const all = await deps.store.disputes.query([eq<DisputeRow>('experienceId', input.experienceId)]);

      return ok({
        value: {
          disputeId: created.value.id,
          origin,
          status: created.value.status,
          contested: isContested(all),
        },
        events: [
          {
            aggregateType: 'experience',
            aggregateId: input.experienceId,
            eventName: 'DisputeOpened',
            payload: {
              experienceId: input.experienceId,
              disputeId: created.value.id,
              origin,
              reason: created.value.reason,
              // Never the detail: it can quote either party at length.
              hasDetail: created.value.detail !== undefined,
            },
          },
        ],
      });
    },
  };

  const withdraw: CommandHandler<{ disputeId: string }, { withdrawn: true; contested: boolean }> = {
    name: 'dispute.withdraw',
    action: 'dispute.withdraw',
    resolveResource: async (input) => {
      const row = await deps.store.disputes.get(input.disputeId);
      if (!row) return err(notFoundError('dispute_not_found', 'no such dispute'));
      return ok({ type: 'dispute', id: row.id, ownerActorId: row.raisedBy });
    },
    handle: async (input, ctx) => {
      const row = await deps.store.disputes.get(input.disputeId);
      if (!row) return err(notFoundError('dispute_not_found', 'no such dispute'));

      const withdrawn = withdrawDispute(row, ctx.actor.actorId, ctx.clock.now());
      if (!withdrawn.ok) return withdrawn;
      await deps.store.disputes.put(withdrawn.value);

      const all = await deps.store.disputes.query([eq<DisputeRow>('experienceId', row.experienceId)]);
      return ok({
        value: { withdrawn: true as const, contested: isContested(all) },
        events: [
          {
            aggregateType: 'experience',
            aggregateId: row.experienceId,
            eventName: 'DisputeWithdrawn',
            payload: { experienceId: row.experienceId, disputeId: row.id },
          },
        ],
      });
    },
  };

  const review: CommandHandler<
    { disputeId: string; outcome: DisputeStatus; note?: string },
    { status: DisputeStatus; contested: boolean }
  > = {
    name: 'dispute.review',
    action: 'dispute.review',
    resolveResource: async (input) => {
      const row = await deps.store.disputes.get(input.disputeId);
      if (!row) return err(notFoundError('dispute_not_found', 'no such dispute'));
      // Deliberately not the raiser: `ownership: 'required'` would let somebody
      // decide their own dispute. Standing to review is a role, not ownership.
      return ok({ type: 'dispute', id: row.id });
    },
    handle: async (input, ctx) => {
      const row = await deps.store.disputes.get(input.disputeId);
      if (!row) return err(notFoundError('dispute_not_found', 'no such dispute'));

      const reviewed = reviewDispute(
        row,
        {
          to: input.outcome,
          reviewerId: ctx.actor.actorId,
          ...(input.note === undefined ? {} : { note: input.note }),
        },
        ctx.clock.now(),
      );
      if (!reviewed.ok) return reviewed;
      await deps.store.disputes.put(reviewed.value);

      const all = await deps.store.disputes.query([eq<DisputeRow>('experienceId', row.experienceId)]);
      return ok({
        value: { status: reviewed.value.status, contested: isContested(all) },
        events: [
          {
            aggregateType: 'experience',
            aggregateId: row.experienceId,
            eventName: 'DisputeReviewed',
            payload: {
              experienceId: row.experienceId,
              disputeId: row.id,
              outcome: reviewed.value.status,
            },
          },
        ],
      });
    },
  };

  deps.bus.register(open);
  deps.bus.register(withdraw);
  deps.bus.register(review);
};

/**
 * The public view of disputes on an experience.
 *
 * Says *that* it is contested, by which side, and on what grounds. Never the
 * detail, which can quote either party at length, and never a verdict the platform
 * has not reached.
 */
export interface PublicDispute {
  readonly disputeId: string;
  readonly origin: DisputeOrigin;
  readonly reason: string;
  readonly status: DisputeStatus;
  readonly raisedAt: number;
}

export const disputesFor = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<{ contested: boolean; disputes: readonly PublicDispute[] }> => {
  const rows = await deps.store.disputes.query([eq<DisputeRow>('experienceId', experienceId)], {
    orderBy: { field: 'createdAt', direction: 'asc' },
  });
  return {
    contested: isContested(rows),
    disputes: rows
      .filter((row) => row.status !== 'withdrawn')
      .map((row) => ({
        disputeId: row.id,
        origin: row.origin,
        reason: row.reason,
        status: row.status,
        raisedAt: row.createdAt,
      })),
  };
};
