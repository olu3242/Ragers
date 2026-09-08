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
  | 'health.read';

export interface ActorContext {
  readonly actorId: string;
  readonly role: Role;
  readonly sessionId?: string;
  readonly authenticated: boolean;
}

export const GUEST: ActorContext = { actorId: 'guest', role: 'guest', authenticated: false };

export type PolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string; readonly reason: string };

export const allow = (): PolicyDecision => ({ allowed: true });
export const deny = (code: string, reason: string): PolicyDecision => ({ allowed: false, code, reason });

export interface Authorizer {
  authorize(actor: ActorContext, action: PolicyAction, resource: ResourceRef): PolicyDecision;
}

export const hasAtLeast = (role: Role, required: Role): boolean => ROLE_RANK[role] >= ROLE_RANK[required];
