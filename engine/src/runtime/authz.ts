/**
 * Authorization contract. The runtime enforces it; `src/policy` implements it.
 * Defined here so the command bus can require authorization structurally —
 * a handler is only reachable through the bus, and the bus always authorizes.
 */
export type Role = 'guest' | 'member' | 'moderator' | 'admin';

export const ROLE_RANK: Readonly<Record<Role, number>> = {
  guest: 0,
  member: 1,
  moderator: 2,
  admin: 3,
};

export type ResourceType =
  | 'experience'
  | 'reply'
  | 'media'
  | 'transcript'
  | 'actor'
  | 'alias'
  | 'session'
  | 'report'
  | 'queue_item'
  | 'notification'
  | 'graph_edge'
  | 'reputation'
  | 'search'
  | 'feed'
  | 'subject'
  | 'audit'
  | 'dead_letter'
  | 'analytics'
  | 'role_assignment'
  | 'export'
  | 'operator_control'
  | 'corroboration'
  | 'share'
  | 'evidence'
  | 'cluster'
  | 'signal'
  | 'entity'
  | 'organization'
  | 'trust'
  | 'dispute'
  | 'relation'
  | 'proposal'
  | 'organization_case'
  | 'resolution_report'
  | 'responsiveness'
  | 'system';

export interface ResourceRef {
  readonly type: ResourceType;
  readonly id?: string;
  readonly ownerActorId?: string;
  readonly status?: string;
  readonly visibility?: string;
}

export type PolicyAction =
  // identity
  | 'actor.register'
  | 'actor.authenticate'
  | 'session.revoke'
  | 'alias.create'
  | 'alias.retire'
  | 'actor.set_default_visibility'
  // experience
  | 'experience.create'
  | 'experience.update'
  | 'experience.publish'
  | 'experience.read'
  | 'experience.hide'
  | 'experience.delete'
  | 'experience.change_visibility'
  // voice / media
  | 'voice.request_upload'
  | 'voice.attach'
  | 'voice.playback'
  | 'transcript.read'
  | 'transcript.read_raw'
  | 'media.read_original'
  // feed / search
  | 'feed.read'
  | 'search.query'
  | 'subject.read'
  // engagement
  | 'reaction.toggle'
  | 'fair_vote.cast'
  | 'reply.create'
  | 'reply.delete'
  // safety
  | 'report.file'
  | 'moderation.claim'
  | 'moderation.action'
  | 'moderation.read_queue'
  // graph / notifications
  | 'watch.manage'
  | 'graph.follow'
  | 'graph.block'
  | 'graph.mute'
  | 'notification.read'
  | 'notification.set_preference'
  // reputation
  | 'reputation.read_public'
  | 'reputation.read_internal'
  // creator control
  | 'export.request'
  // governance / ops
  | 'role.grant'
  | 'audit.read'
  | 'dead_letter.read'
  | 'dead_letter.replay'
  | 'analytics.read'
  | 'health.read'
  /**
   * Phase 94. One action for all six controls, because they are one kind of act: an operator
   * overriding the system. Splitting them per control would invite a matrix where some are
   * admin and some are not, which is how a kill switch becomes reachable by somebody who
   * should be describing an incident instead.
   */
  | 'control.apply'
  // ── Experience Signal Engine ──────────────────────────────────────────
  | 'corroboration.create'
  | 'corroboration.retract'
  | 'share.create'
  | 'evidence.attach'
  | 'evidence.read_original'
  | 'evidence.assess'
  | 'resolution.report'
  | 'cluster.read'
  | 'signal.read'
  | 'signal.read_internal'
  | 'entity.claim'
  | 'organization.respond'
  | 'organization.manage_members'
  | 'trust.read_internal'
  | 'experience.confirm_metadata'
  // ── Engine contract gaps ──────────────────────────────────────────────
  | 'dispute.open'
  | 'dispute.withdraw'
  | 'dispute.review'
  | 'relation.assert'
  | 'relation.retract'
  | 'responsiveness.read'
  | 'proposal.create'
  | 'proposal.decide'
  | 'proposal.read'
  // ── Phases 31–35: enrichment, severity, escalation, organization cases ──
  | 'enrichment.assert'
  | 'enrichment.read'
  | 'severity.read'
  | 'escalation.read'
  | 'case.read'
  | 'case.manage'
  // ── Phases 48–49 ──────────────────────────────────────────────────────
  | 'integration.manage'
  | 'entitlement.manage';

export interface ActorContext {
  readonly actorId: string;
  readonly role: Role;
  readonly sessionId?: string;
  readonly authenticated: boolean;
}

export const GUEST: ActorContext = { actorId: 'guest', role: 'guest', authenticated: false };

/**
 * The engine's own service identity.
 *
 * A consumer that has to dispatch a command needs somebody to dispatch as, and borrowing
 * a person's identity would attribute a machine's suggestion to a human who did not make
 * it. So the engine acts as itself. Named here rather than spelled as a literal at each
 * dispatch site, because anything that has to treat an internal caller differently needs
 * to agree on what one is.
 *
 * **It is not an account.** There is no row for it in `actors`, nobody can authenticate
 * as it, and it holds no session. So nothing keyed to a real account may be written for
 * it — and the database says so: every table with `actor_id references actors (id)`
 * refuses the write. That refusal is how the quota guard's missing exclusion was found,
 * which is the argument for keeping those foreign keys rather than relaxing them.
 *
 * `authenticated: true` is still correct for it: the flag means "this is not an
 * unidentified caller", and the policy matrix has to evaluate an internal dispatch as a
 * named principal or the command would be refused as a guest.
 */
export const SERVICE_ACTOR_ID = 'engine';

/**
 * Whether this is the engine acting on its own behalf rather than a person acting.
 *
 * A predicate rather than a comparison at each call site, so the set of internal
 * identities can grow without every caller having to learn about it.
 */
export const isServiceActor = (actor: ActorContext): boolean => actor.actorId === SERVICE_ACTOR_ID;

export type PolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string; readonly reason: string };

export const allow = (): PolicyDecision => ({ allowed: true });
export const deny = (code: string, reason: string): PolicyDecision => ({ allowed: false, code, reason });

export interface Authorizer {
  authorize(actor: ActorContext, action: PolicyAction, resource: ResourceRef): PolicyDecision;
}

export const hasAtLeast = (role: Role, required: Role): boolean => ROLE_RANK[role] >= ROLE_RANK[required];
