import { jsonOk, readJson } from '../../../lib/api.ts';
import { guidanceFor, isBlocked } from '../../../src/domain/language.ts';

/**
 * Composer guidance.
 *
 * Advisory by design: it returns observations about the draft and never a
 * rewritten draft. The only finding that blocks is a threat.
 */
export const POST = async (request: Request): Promise<Response> => {
  const body = await readJson(request);
  const text = typeof body['text'] === 'string' ? body['text'] : '';
  const kind = body['kind'] === 'rave' ? 'rave' : 'rage';
  const guidance = guidanceFor({
    text,
    kind,
    namesPerson: body['namesPerson'] === true,
  });
  return jsonOk({ guidance, blocked: isBlocked(guidance) });
};
