import { getEngine } from '../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, readJson, respond } from '../../../lib/api.ts';
import { currentActor } from '../../../lib/session.ts';
import { getRankedFeed } from '../../../src/engines/ranking.engine.ts';
import type { CreateExperienceResult } from '../../../src/engines/experience.engine.ts';

/** The feed. Readable by a guest, ranked when ranking has run. */
export const GET = async (request: Request): Promise<Response> => {
  const engine = getEngine();
  const url = new URL(request.url);
  const kindParam = url.searchParams.get('kind');
  const kind = kindParam === 'rage' || kindParam === 'rave' ? kindParam : undefined;

  const feed = await getRankedFeed(engine, {
    ...(kind === undefined ? {} : { kind }),
    limit: Number(url.searchParams.get('limit') ?? 25),
  });
  return Response.json(feed);
};

/** Create a Rage or a Rave. Voice mode returns awaitingMedia. */
export const POST = async (request: Request): Promise<Response> => {
  const engine = getEngine();
  const result = await engine.bus.dispatch<unknown, CreateExperienceResult>({
    name: 'experience.create',
    input: await readJson(request),
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result, 201);
};
