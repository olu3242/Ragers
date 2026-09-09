import { getEngine } from '../../../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, readJson, respond } from '../../../../../lib/api.ts';
import { currentActor } from '../../../../../lib/session.ts';
import { caseKey } from '../../../../../src/engines/case.engine.ts';

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
