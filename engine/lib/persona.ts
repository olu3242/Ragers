import { eq } from '../src/ports/store.ts';
import { getEngine } from './engine-instance.ts';
import { currentActor } from './session.ts';
import type { ActorContext } from '../src/runtime/authz.ts';
import type { OrganizationMembership } from '../src/ports/store.ts';

/**
 * Which persona a viewer is, resolved on the server from their actor role and
 * their organization memberships.
 *
 * Server-side on purpose. A persona decides what navigation and actions a person
 * is *offered*, and it must never be the thing that decides what they are
 * *allowed* — every action still goes through the command bus and the policy
 * matrix, so a hand-crafted request from a consumer to an operator surface is
 * refused by authorization rather than by the absence of a link.
 *
 * Personas are not exclusive. Someone can be a consumer, a community participant
 * and organization staff at once; the navigation shows every surface they hold.
 */
export type Persona =
  | 'consumer'
  | 'community'
  | 'organization'
  | 'operator'
  | 'intelligence';

export interface ViewerContext {
  readonly actor: ActorContext;
  readonly personas: readonly Persona[];
  /** Organizations this viewer may act for, already filtered to claimed ones. */
  readonly organizations: readonly { readonly id: string; readonly displayName: string }[];
}

export const resolveViewer = async (): Promise<ViewerContext> => {
  const actor = await currentActor();
  const engine = getEngine();

  const personas: Persona[] = [];
  // A signed-out visitor can read, so they get the consumer surface and nothing
  // that implies an identity they do not have.
  personas.push('consumer');
  if (actor.authenticated) personas.push('community');

  const organizations: { id: string; displayName: string }[] = [];
  if (actor.authenticated) {
    const memberships = await engine.store.organizationMemberships.query([
      eq<OrganizationMembership>('actorId', actor.actorId),
    ]);
    for (const membership of memberships) {
      // A revoked membership is not a membership.
      if (membership.revokedAt !== undefined) continue;
      const profile = await engine.store.organizationProfiles.get(membership.organizationId);
      // A pending claim confers nothing: verifying that someone speaks for an
      // organization is a human decision, and until it is made they get no
      // organization surface at all.
      if (!profile || profile.status !== 'claimed') continue;
      organizations.push({ id: profile.id, displayName: profile.displayName });
    }
    if (organizations.length > 0) personas.push('organization');
  }

  if (actor.role === 'moderator' || actor.role === 'admin') {
    personas.push('operator');
    // The intelligence surface shows governed proposals awaiting a decision, so
    // it is only meaningful to someone who can make one.
    personas.push('intelligence');
  }

  return { actor, personas, organizations };
};

export const hasPersona = (viewer: ViewerContext, persona: Persona): boolean =>
  viewer.personas.includes(persona);
