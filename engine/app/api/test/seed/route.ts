import { getEngine } from '../../../../lib/engine-instance.ts';
import { jsonError, jsonOk, readJson } from '../../../../lib/api.ts';
import { notFoundError } from '../../../../src/runtime/errors.ts';
import { currentActor } from '../../../../lib/session.ts';

/**
 * Test-only fixture seeding.
 *
 * This is a write path that creates taxonomy rows and grants an organization
 * membership, so it must not exist in a real deployment. It is gated on an
 * explicit environment flag rather than on `NODE_ENV`: a production build with a
 * stray `NODE_ENV` would otherwise expose it, and the failure mode — anyone able
 * to enrol themselves as an organization's staff — is exactly the one the
 * organization rules exist to prevent.
 *
 * Absent the flag it behaves as though the route does not exist, which is also
 * what a scanner should see. `tests/unit/host.surfaces.test.ts` asserts the guard
 * is present and that it is the first thing the handler does.
 */
const ENABLED = (): boolean => process.env['RAGERS_TEST_SEED'] === 'enabled';

export const POST = async (request: Request): Promise<Response> => {
  if (!ENABLED()) return jsonError(notFoundError('not_found', 'not found'));

  const engine = getEngine();
  const body = await readJson(request);

  await engine.store.entities.put({
    id: 'ent_northwind',
    name: 'Northwind Air',
    slug: 'northwind-air',
    kind: 'organization',
  });
  await engine.store.entityAliases.put({
    id: 'ali_northwind',
    entityId: 'ent_northwind',
    alias: 'Northwind Air',
  });
  const existingCategory = await engine.store.categories.get('cat_shopping');
  if (!existingCategory) {
    await engine.store.categories.put({
      id: 'cat_shopping',
      name: 'Shopping & service',
      slug: 'shopping-service',
    });
  }
  await engine.store.issueTypes.put({
    id: 'iss_refund',
    categoryId: 'cat_shopping',
    name: 'Refund not processed',
    slug: 'refund-not-processed',
  });
  await engine.store.organizationProfiles.put({
    id: 'org_northwind',
    entityId: 'ent_northwind',
    displayName: 'Northwind Air',
    status: 'claimed',
  });

  // Promote the current session to moderator, on request. Same gate: this would
  // be a privilege-escalation path if it were ever reachable in a deployment.
  if (body['grantModerator'] === true) {
    const actor = await currentActor();
    const row = actor.authenticated ? await engine.store.actors.get(actor.actorId) : undefined;
    if (!row) return jsonError(notFoundError('no_session', 'sign in first'));
    await engine.store.actors.put({ ...row, role: 'moderator' });
  }

  // Enrol the *current* session as organization staff, on request. Only ever
  // reachable behind the flag above.
  if (body['grantOrganizationMembership'] === true) {
    const actor = await currentActor();
    if (!actor.authenticated) {
      return jsonError(notFoundError('no_session', 'sign in first'));
    }
    await engine.store.organizationMemberships.put({
      id: `mem_${actor.actorId}`,
      organizationId: 'org_northwind',
      actorId: actor.actorId,
      role: 'admin',
      grantedAt: Date.now(),
    });
  }

  return jsonOk({ seeded: true });
};
