import {
  allow,
  deny,
  hasAtLeast,
  type ActorContext,
  type Authorizer,
  type PolicyAction,
  type PolicyDecision,
  type ResourceRef,
  type Role,
} from '../runtime/authz.ts';

/**
 * The authorization matrix. Deny by default: an action absent from the table is
 * refused, so adding a command without a policy fails closed rather than open.
 *
 * Two rules are absolute and have no role that satisfies them:
 *   - `media.read_original`  — original media is never readable on any path
 *   - `transcript.read_raw`  — raw transcript text is never readable on any path
 * Only protected derivatives are servable. See docs/ROADMAP.md P10.
 */

type Requirement = {
  /** Minimum role. */
  readonly role: Role;
  /** Actor must own the resource. */
  readonly ownership?: 'required' | 'forbidden';
  /** Resource statuses this action is permitted against. */
  readonly statuses?: readonly string[];
  /** No role may perform this action. */
  readonly never?: true;
};

const MATRIX: Readonly<Record<PolicyAction, Requirement>> = {
  // ── Identity & access ────────────────────────────────────────────────
  'actor.register': { role: 'guest' },
  'actor.authenticate': { role: 'guest' },
  'session.revoke': { role: 'member', ownership: 'required' },
  'alias.create': { role: 'member', ownership: 'required' },
  'alias.retire': { role: 'member', ownership: 'required' },
  'actor.set_default_visibility': { role: 'member', ownership: 'required' },

  // ── Experience lifecycle ────────────────────────────────────────────
  'experience.create': { role: 'member' },
  'experience.update': { role: 'member', ownership: 'required', statuses: ['draft', 'pending_media', 'published'] },
  'experience.publish': {
    role: 'member',
    ownership: 'required',
    statuses: ['draft', 'validating', 'pending_moderation', 'published'],
  },
  'experience.read': { role: 'guest' },
  'experience.hide': { role: 'moderator' },
  'experience.delete': { role: 'member', ownership: 'required' },
  'experience.change_visibility': { role: 'member', ownership: 'required' },

  // ── Voice & media ───────────────────────────────────────────────────
  'voice.request_upload': { role: 'member', ownership: 'required' },
  'voice.attach': { role: 'member', ownership: 'required' },
  'voice.playback': { role: 'guest' },
  'transcript.read': { role: 'guest' },
  'transcript.read_raw': { role: 'admin', never: true },
  'media.read_original': { role: 'admin', never: true },

  // ── Read surfaces ───────────────────────────────────────────────────
  'feed.read': { role: 'guest' },
  'search.query': { role: 'guest' },
  'subject.read': { role: 'guest' },

  // ── Engagement (Ragers-native) ──────────────────────────────────────
  'reaction.toggle': { role: 'member', statuses: ['published'] },
  'fair_vote.cast': { role: 'member', ownership: 'forbidden', statuses: ['published'] },
  'reply.create': { role: 'member', statuses: ['published'] },
  'reply.delete': { role: 'member', ownership: 'required' },

  // ── Trust & safety ──────────────────────────────────────────────────
  'report.file': { role: 'member' },
  'moderation.claim': { role: 'moderator' },
  'moderation.action': { role: 'moderator', ownership: 'forbidden' },
  'moderation.read_queue': { role: 'moderator' },

  // ── Social graph & notifications ────────────────────────────────────
  'graph.follow': { role: 'member' },
  'graph.block': { role: 'member' },
  'graph.mute': { role: 'member' },
  'notification.read': { role: 'member', ownership: 'required' },
  'notification.set_preference': { role: 'member', ownership: 'required' },

  // ── Reputation ──────────────────────────────────────────────────────
  'reputation.read_public': { role: 'guest' },
  'reputation.read_internal': { role: 'moderator' },

  // ── Creator control ─────────────────────────────────────────────────
  'export.request': { role: 'member', ownership: 'required' },

  // ── Governance & operations ─────────────────────────────────────────
  'role.grant': { role: 'admin' },
  'audit.read': { role: 'admin' },
  'dead_letter.read': { role: 'admin' },
  'dead_letter.replay': { role: 'admin' },
  'analytics.read': { role: 'admin' },
  'health.read': { role: 'admin' },

  // ── Experience Signal Engine ────────────────────────────────────────────
  // Corroborating is a claim about your own experience, so the author of the
  // experience is forbidden — they already made the claim by posting it.
  'corroboration.create': { role: 'member', ownership: 'forbidden', statuses: ['published'] },
  'corroboration.retract': { role: 'member', ownership: 'required' },
  // Sharing is amplification, not a claim, so the author may share their own.
  'share.create': { role: 'guest' },
  'evidence.attach': { role: 'member', ownership: 'required' },
  // Evidence originals are as sensitive as media originals: unreadable on every
  // path, for every role. Assessments read the protected derivative.
  'evidence.read_original': { role: 'admin', never: true },
  'evidence.assess': { role: 'moderator' },
  // Only someone who claims the experience may report its resolution; which
  // actors qualify is resolved by the engine, not expressible as ownership here.
  'resolution.report': { role: 'member' },
  'cluster.read': { role: 'guest' },
  'signal.read': { role: 'guest' },
  'signal.read_internal': { role: 'moderator' },
  'entity.claim': { role: 'member' },
  // Organizations answer through their own records and can never write a claim.
  'organization.respond': { role: 'member' },
  'organization.manage_members': { role: 'member' },
  'trust.read_internal': { role: 'moderator' },
  'experience.confirm_metadata': { role: 'member', ownership: 'required' },

  // ── Engine contract gaps ────────────────────────────────────────────────
  // Anyone signed in may dispute; which party they are and whether they have
  // standing is resolved by the engine, since the matrix cannot express
  // "is an experiencer" or "acts for the disputed organization".
  'dispute.open': { role: 'member' },
  'dispute.withdraw': { role: 'member', ownership: 'required' },
  // Only an operator decides a dispute. The disputed party has no path here at
  // all, which is the whole point of a formal dispute.
  'dispute.review': { role: 'moderator' },
  'relation.assert': { role: 'member' },
  'relation.retract': { role: 'member', ownership: 'required' },
  'responsiveness.read': { role: 'guest' },
  // Proposals are produced by the engine itself and reviewed by operators. There
  // is no member path to either: a proposal is not a way for a person to place a
  // request in front of a moderator.
  'proposal.create': { role: 'moderator' },
  'proposal.decide': { role: 'moderator' },
  'proposal.read': { role: 'moderator' },

  // ── Phases 31–35 ──────────────────────────────────────────────────────
  // What an experience cost is the experiencer's own to state, so ownership is
  // required rather than merely checked in the engine.
  'enrichment.assert': { role: 'member', ownership: 'required' },
  'enrichment.read': { role: 'member', ownership: 'required' },
  // The severity *band* is public — it is how a reader tells a serious failure from
  // an annoyance. The dimensions behind it are not, and live under enrichment.read.
  'severity.read': { role: 'guest' },
  // Escalations describe an operational decision to look at something; publishing
  // them would let anyone infer moderation thresholds.
  'escalation.read': { role: 'moderator' },
  // A case is an organization's workspace. Membership is checked in the engine
  // against a live, unrevoked row; the matrix cannot express that.
  'case.read': { role: 'member' },
  'case.manage': { role: 'member' },

  // ── Phases 48–49 ──────────────────────────────────────────────────────
  // Membership is checked in the engine against a live row, as with cases.
  'integration.manage': { role: 'member' },
  // A plan is set by an operator, never by the organization that benefits from it.
  'entitlement.manage': { role: 'admin' },
};

/** Statuses that only a moderator or admin may read. */
const RESTRICTED_READ_STATUSES: readonly string[] = ['hidden', 'removed', 'under_review', 'deleted'];

export const createAuthorizer = (): Authorizer => ({
  authorize: (actor: ActorContext, action: PolicyAction, resource: ResourceRef): PolicyDecision => {
    const requirement = MATRIX[action];
    if (!requirement) {
      return deny('policy_unknown_action', `No policy defined for ${action}`);
    }

    if (requirement.never) {
      return deny('policy_forbidden_always', `${action} is not permitted on any read path`);
    }

    if (!hasAtLeast(actor.role, requirement.role)) {
      return deny('policy_insufficient_role', `${action} requires role ${requirement.role}`);
    }

    if (requirement.role !== 'guest' && !actor.authenticated) {
      return deny('policy_unauthenticated', `${action} requires an authenticated actor`);
    }

    const isOwner = resource.ownerActorId !== undefined && resource.ownerActorId === actor.actorId;
    const isStaff = hasAtLeast(actor.role, 'moderator');

    if (requirement.ownership === 'required' && !isOwner) {
      return deny('policy_not_owner', `${action} is limited to the resource owner`);
    }
    if (requirement.ownership === 'forbidden' && isOwner) {
      return deny('policy_owner_forbidden', `${action} may not be performed on your own ${resource.type}`);
    }

    if (requirement.statuses && resource.status !== undefined) {
      if (!requirement.statuses.includes(resource.status)) {
        return deny(
          'policy_status_not_permitted',
          `${action} is not permitted while the ${resource.type} is ${resource.status}`,
        );
      }
    }

    // Reads of non-public states are staff-or-owner only, regardless of action.
    if (
      resource.status !== undefined &&
      RESTRICTED_READ_STATUSES.includes(resource.status) &&
      !isStaff &&
      !isOwner
    ) {
      return deny('policy_status_hidden', `This ${resource.type} is not visible`);
    }

    return allow();
  },
});

export const policyActions = (): readonly PolicyAction[] => Object.keys(MATRIX) as PolicyAction[];
