import { getEngine } from '../../../../../lib/engine-instance.ts';
import {
  correlationIdFrom,
  idempotencyKeyFrom,
  jsonError,
  jsonOk,
  readJson,
  respond,
} from '../../../../../lib/api.ts';
import { unauthorizedError } from '../../../../../src/runtime/errors.ts';
import { eq } from '../../../../../src/ports/store.ts';
import { currentActor } from '../../../../../lib/session.ts';
import { organizationFor } from '../../../../../src/engines/organization.engine.ts';
import { resolutionSummaryFor } from '../../../../../src/engines/resolution.engine.ts';
import { caseKey } from '../../../../../src/engines/case.engine.ts';
import type { Experience } from '../../../../../src/domain/experience.ts';

/**
 * An organization's case inbox: published experiences about their entity.
 *
 * Membership is checked here because this is a read with no command to dispatch,
 * and it is checked the same way the respond command checks it — via
 * `organizationFor`, which refuses a pending claim and a revoked membership. A
 * pending claim gets nothing, because verifying that someone speaks for an
 * organization is a human decision.
 *
 * What is deliberately absent: any field that would let an organization identify
 * who posted. The rows carry the account and its outcome, never an author.
 */
export const GET = async (
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const actor = await currentActor();
  const engine = getEngine();

  const scope = actor.authenticated ? await organizationFor(engine, actor.actorId, id) : undefined;
  if (!scope) {
    return jsonError(unauthorizedError('policy_membership', 'you cannot act for that organization'));
  }

  const experiences = await engine.store.experiences.query(
    [eq<Experience>('entityId', scope.profile.entityId), eq<Experience>('status', 'published')],
    { orderBy: { field: 'publishedAt', direction: 'desc' }, limit: 100 },
  );

  const cases = [];
  for (const experience of experiences) {
    const counters = await engine.store.counters.get(experience.id);
    const summary = await resolutionSummaryFor(engine, experience.id);
    cases.push({
      experienceId: experience.id,
      kind: experience.kind,
      bodyText: experience.bodyText,
      publishedAt: experience.publishedAt ?? experience.createdAt,
      // People, counted once each. Never presented as a finding of fact.
      corroborators: counters?.corroboratorCount ?? 0,
      reRages: counters?.reRageCount ?? 0,
      reRaves: counters?.reRaveCount ?? 0,
      resolutionStatus: summary?.status ?? 'open',
      presentation: summary?.presentation ?? 'unresolved_unreported',
      reporters: summary?.reporters ?? 0,
      resolvedShare: summary?.resolvedShare ?? 0,
      responded: summary?.organizationResponded ?? false,
      resolutionProposed: summary?.resolutionProposed ?? false,
      ...(experience.clusterId === undefined ? {} : { clusterId: experience.clusterId }),
    });
  }

  return jsonOk({ organization: { id: scope.profile.id, displayName: scope.profile.displayName }, cases });
};

/**
 * Open or move an organization's case.
 *
 * One endpoint for both, because from the organization's side it is one act: "this is
 * now at this stage". A first call opens the case and a second moves it, and the
 * engine decides which — so the client does not have to know whether a workspace
 * already exists.
 *
 * Nothing here can reach the experience. Both commands write to `organization_cases`
 * only, and there is no parameter through which a resolution status could travel.
 */
export const POST = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const body = await readJson(request);
  const experienceId = String(body['experienceId'] ?? '');
  const actor = await currentActor();
  const engine = getEngine();

  const opened = await engine.bus.dispatch({
    name: 'case.open',
    input: { organizationId: id, experienceId },
    actor,
    idempotencyKey: `${idempotencyKeyFrom(request)}:open`,
    correlationId: correlationIdFrom(request),
  });
  if (!opened.ok) return respond(opened);

  const to = body['to'];
  if (typeof to !== 'string') return respond(opened);

  const moved = await engine.bus.dispatch({
    name: 'case.transition',
    input: {
      caseId: caseKey(id, experienceId),
      to,
      ...(body['note'] === undefined ? {} : { note: body['note'] }),
    },
    actor,
    idempotencyKey: `${idempotencyKeyFrom(request)}:move:${to}`,
    correlationId: correlationIdFrom(request),
  });
  return respond(moved);
};
