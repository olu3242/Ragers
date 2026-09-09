import { err, ok } from '../runtime/result.ts';
import { notFoundError, preconditionError, validationError } from '../runtime/errors.ts';
import { eq } from '../ports/store.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type {
  OrganizationMembership,
  OrganizationProfile,
  OrganizationResponse,
} from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { recordResolution } from './resolution.engine.ts';

/**
 * Organization Response Engine.
 *
 * An organization gets a real voice and no editorial power. It can acknowledge,
 * answer, ask for information privately, describe a fix, dispute an account, or
 * publish remediation instructions — and that is the whole list. Structurally it
 * cannot:
 *
 *   * delete, hide or edit an experience — responses live in their own table and
 *     RLS grants organizations no write path to `experiences` at all;
 *   * mark anything resolved — `applyResolution` refuses an organization-sourced
 *     move to a resolved state, so even `publish_resolution` records the
 *     organization's account of a fix without changing the outcome;
 *   * outrank or suppress the accounts it is answering.
 *
 * `dispute` deserves its own note. An organization saying "this is not what
 * happened" is legitimate and is recorded as such — as *their* claim, beside the
 * experiencer's, not replacing it. It moves the experience to `disputed`, which is
 * a statement that the two accounts differ, not a finding about who is right.
 */

export const RESPONSE_KINDS: readonly string[] = [
  'acknowledge',
  'respond',
  'request_information',
  'publish_resolution',
  'service_update',
  'dispute',
  'known_incident',
  'remediation_instructions',
];

/** Response kinds that are private to the experiencer, not published. */
const PRIVATE_KINDS: readonly string[] = ['request_information'];

export const RESPONSE_MAX_LENGTH = 4_000;

/** The organization an actor may act for, if any. */
export const organizationFor = async (
  deps: EngineDeps,
  actorId: string,
  organizationId: string,
): Promise<{ profile: OrganizationProfile; membership: OrganizationMembership } | undefined> => {
  const profile = await deps.store.organizationProfiles.get(organizationId);
  if (!profile || profile.status !== 'claimed') return undefined;
  const membership = await deps.store.organizationMemberships.queryOne([
    eq<OrganizationMembership>('organizationId', organizationId),
    eq<OrganizationMembership>('actorId', actorId),
  ]);
  if (!membership || membership.revokedAt !== undefined) return undefined;
  return { profile, membership };
};

export interface RespondInput {
  readonly organizationId: string;
  readonly experienceId?: string;
  readonly clusterId?: string;
  readonly kind: string;
  readonly body: string;
}

export interface RespondResult {
  readonly responseId: string;
  readonly kind: string;
  readonly isPublic: boolean;
  /**
   * The experience's outcome status after the response. Present so a caller can
   * see for itself that responding did not resolve anything.
   */
  readonly resolutionStatus?: string;
}

export const registerOrganizationEngine = (deps: EngineDeps): void => {
  const respond: CommandHandler<RespondInput, RespondResult> = {
    name: 'organization.respond',
    action: 'organization.respond',
    resolveResource: async (input) => {
      const profile = await deps.store.organizationProfiles.get(input.organizationId);
      if (!profile) return err(notFoundError('organization_not_found', 'no such organization'));
      // Ownership is membership, checked in the handler: the policy matrix cannot
      // express "is a member of this organization".
      return ok({ type: 'organization', id: profile.id });
    },
    handle: async (input, ctx) => {
      const scope = await organizationFor(deps, ctx.actor.actorId, input.organizationId);
      if (!scope) {
        return err(
          preconditionError('not_an_organization_member', 'you cannot respond on behalf of that organization'),
        );
      }

      if (!RESPONSE_KINDS.includes(input.kind)) {
        return err(validationError('invalid_response_kind', 'that is not a supported response kind'));
      }
      const body = typeof input.body === 'string' ? input.body.trim() : '';
      if (body.length === 0) return err(validationError('empty_response', 'a response cannot be empty'));
      if (body.length > RESPONSE_MAX_LENGTH) {
        return err(validationError('response_too_long', `a response must be at most ${RESPONSE_MAX_LENGTH} characters`));
      }

      const hasExperience = typeof input.experienceId === 'string' && input.experienceId.length > 0;
      const hasCluster = typeof input.clusterId === 'string' && input.clusterId.length > 0;
      if (hasExperience === hasCluster) {
        return err(
          validationError('response_needs_one_target', 'a response addresses one experience or one cluster'),
        );
      }

      // The target must be about this organization's entity. Responding to
      // somebody else's experience would be impersonation.
      if (hasExperience) {
        const experience = await deps.store.experiences.get(input.experienceId as string);
        if (!experience) return err(notFoundError('experience_not_found', 'no such experience'));
        if (experience.status !== 'published') {
          return err(preconditionError('experience_not_published', 'only a published experience can be answered'));
        }
        if (experience.entityId !== scope.profile.entityId) {
          return err(
            preconditionError('not_your_entity', 'that experience is not about your organization'),
          );
        }
      } else {
        const cluster = await deps.store.clusters.get(input.clusterId as string);
        if (!cluster) return err(notFoundError('cluster_not_found', 'no such cluster'));
        if (cluster.entityId !== scope.profile.entityId) {
          return err(preconditionError('not_your_entity', 'that cluster is not about your organization'));
        }
      }

      const response: OrganizationResponse = {
        id: deps.ids.next('orr'),
        organizationId: input.organizationId,
        ...(hasExperience ? { experienceId: input.experienceId as string } : {}),
        ...(hasCluster ? { clusterId: input.clusterId as string } : {}),
        authorId: ctx.actor.actorId,
        kind: input.kind,
        body,
        // A request for information is between the organization and the person.
        isPublic: !PRIVATE_KINDS.includes(input.kind),
        correlationId: ctx.correlationId,
        createdAt: ctx.clock.now(),
      };
      await deps.store.organizationResponses.put(response);

      // What a response *may* do to the outcome axis: acknowledge it, put it
      // under review, or dispute it. Never resolve it — `applyResolution` refuses
      // that for an organization source, so the attempt is a no-op rather than a
      // silent success.
      let resolutionStatus: string | undefined;
      if (hasExperience) {
        const intended =
          input.kind === 'dispute'
            ? 'disputed'
            : input.kind === 'acknowledge' || input.kind === 'known_incident'
              ? 'acknowledged'
              : input.kind === 'request_information'
                ? 'under_review'
                : undefined;
        if (intended) {
          const applied = await recordResolution(deps, {
            experienceId: input.experienceId as string,
            to: intended,
            source: 'organization',
            actorId: ctx.actor.actorId,
            detail: input.kind,
            correlationId: ctx.correlationId,
          });
          resolutionStatus = applied?.status;
        } else {
          resolutionStatus =
            (await deps.store.experiences.get(input.experienceId as string))?.resolutionStatus ?? 'open';
        }
      }

      deps.metrics.increment('organization.responded', { kind: input.kind });

      return ok({
        value: {
          responseId: response.id,
          kind: response.kind,
          isPublic: response.isPublic,
          ...(resolutionStatus === undefined ? {} : { resolutionStatus }),
        },
        events: [
          {
            aggregateType: hasCluster ? 'cluster' : 'experience',
            aggregateId: (input.clusterId ?? input.experienceId) as string,
            eventName: 'OrganizationResponded',
            payload: {
              responseId: response.id,
              organizationId: input.organizationId,
              kind: response.kind,
              isPublic: response.isPublic,
              ...(hasExperience ? { experienceId: input.experienceId } : {}),
              ...(hasCluster ? { clusterId: input.clusterId } : {}),
            },
          },
        ],
      });
    },
  };

  const claim: CommandHandler<{ entityId: string; displayName: string }, { organizationId: string; status: string }> = {
    name: 'organization.claim',
    action: 'entity.claim',
    resolveResource: async (input) => ok({ type: 'entity', id: input.entityId }),
    handle: async (input, ctx) => {
      const entity = await deps.store.entities.get(input.entityId);
      if (!entity) return err(notFoundError('entity_not_found', 'no such entity'));

      const existing = await deps.store.organizationProfiles.queryOne([
        eq<OrganizationProfile>('entityId', input.entityId),
      ]);
      if (existing && existing.status === 'claimed') {
        return err(preconditionError('already_claimed', 'that organization has already been claimed'));
      }

      // A claim is a request, not a grant. Verifying that someone speaks for an
      // organization is not something this engine can decide, so the profile
      // stays `pending` until a human acts on it — and a pending profile has no
      // response rights at all.
      const profile: OrganizationProfile = {
        id: existing?.id ?? deps.ids.next('org'),
        entityId: input.entityId,
        displayName: input.displayName.trim() || entity.name,
        claimedBy: ctx.actor.actorId,
        claimedAt: ctx.clock.now(),
        status: 'pending',
      };
      await deps.store.organizationProfiles.put(profile);

      return ok({
        value: { organizationId: profile.id, status: profile.status },
        events: [
          {
            aggregateType: 'organization',
            aggregateId: profile.id,
            eventName: 'OrganizationClaimRequested',
            payload: { organizationId: profile.id, entityId: input.entityId, requestedBy: ctx.actor.actorId },
          },
        ],
      });
    },
  };

  deps.bus.register(respond);
  deps.bus.register(claim);
};

/**
 * Public responses on an experience.
 *
 * Labelled as the organization's account. A response never replaces the
 * experience it answers, and a viewer must be able to see both.
 */
export interface PublicResponse {
  readonly responseId: string;
  readonly organizationName: string;
  readonly kind: string;
  readonly body: string;
  readonly respondedAt: number;
}

export const publicResponsesFor = async (
  deps: EngineDeps,
  target: { experienceId?: string; clusterId?: string },
): Promise<readonly PublicResponse[]> => {
  const criteria = target.experienceId
    ? [eq<OrganizationResponse>('experienceId', target.experienceId)]
    : [eq<OrganizationResponse>('clusterId', target.clusterId ?? '')];
  const rows = await deps.store.organizationResponses.query(
    [...criteria, { field: 'isPublic', op: 'isTrue' }],
    { orderBy: { field: 'createdAt', direction: 'asc' } },
  );

  const out: PublicResponse[] = [];
  for (const row of rows) {
    const profile = await deps.store.organizationProfiles.get(row.organizationId);
    out.push({
      responseId: row.id,
      organizationName: profile?.displayName ?? 'Organization',
      kind: row.kind,
      body: row.body,
      respondedAt: row.createdAt,
    });
  }
  return out;
};
