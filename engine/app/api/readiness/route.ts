import { getEngine } from '../../../lib/engine-instance.ts';
import { jsonOk } from '../../../lib/api.ts';
import { readiness } from '../../../src/engines/observability.engine.ts';

/**
 * Whether this instance may serve traffic — Phase 97.
 *
 * **Deliberately not `/api/health`.** Health answers "are my dependencies up" and is for a person
 * or an alerting system. This answers "may a load balancer send me requests", which is a different
 * question: an instance whose store is unreachable or whose projections nothing advances is
 * *healthy* by every dependency check and must not be in rotation.
 *
 * 503 when not ready, so a balancer's default behaviour is correct without configuration. The
 * per-check detail is in the body for whoever is debugging, and names no internal identifiers.
 */
export const GET = async (): Promise<Response> => {
  const report = await readiness(getEngine());
  return jsonOk(report, report.ready ? 200 : 503);
};
