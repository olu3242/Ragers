import { getEngine } from '../../../lib/engine-instance.ts';
import { jsonOk } from '../../../lib/api.ts';
import { searchExperiences } from '../../../src/engines/search.engine.ts';

/** Search the privacy-safe index. Readable by a guest. */
export const GET = async (request: Request): Promise<Response> => {
  const params = new URL(request.url).searchParams;
  const kind = params.get('kind');
  const text = params.get('q');
  const category = params.get('category');
  const hits = await searchExperiences(getEngine(), {
    ...(text ? { text } : {}),
    ...(kind === 'rage' || kind === 'rave' ? { kind } : {}),
    ...(category ? { category } : {}),
    ...(params.get('voiceOnly') === 'true' ? { voiceOnly: true } : {}),
  });
  return jsonOk({ hits });
};
