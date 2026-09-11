import { getEngine } from '../../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, readJson, respond } from '../../../../lib/api.ts';
import { currentActor } from '../../../../lib/session.ts';
import type { UploadTargetResult } from '../../../../src/engines/voice.engine.ts';

/** Issue a single-use, scoped, expiring upload target for one experience. */
export const POST = async (request: Request): Promise<Response> => {
  const body = await readJson(request);
  const result = await getEngine().bus.dispatch<unknown, UploadTargetResult>({
    name: 'voice.requestUploadTarget',
    input: { experienceId: body['experienceId'] },
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result, 201);
};
