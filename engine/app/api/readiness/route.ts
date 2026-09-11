import { getEngine } from '../../../lib/engine-instance.ts';
import { jsonOk } from '../../../lib/api.ts';
import { readiness } from '../../../src/engines/observability.engine.ts';
import { isHostedDeployment, isPersistent } from '../../../lib/engine-store.ts';

/**
 * Whether this instance may serve traffic — Phase 97, extended by RC3.
 *
 * **Deliberately not `/api/health`.** Health answers "are my dependencies up" and is for a person or
 * an alerting system. This answers "may a load balancer send me requests", which is a different
 * question: an instance whose store is unreachable, whose projections nothing advances, or that is
 * holding everything in memory is *healthy* by every dependency check and must not be in rotation.
 *
 * 503 when not ready, so a balancer's default behaviour is correct without configuration.
 *
 * The route's whole job is to supply the two facts the engine cannot see for itself — whether a
 * database is configured, and whether this process is a hosted deployment — and to let
 * `readiness()` decide what they mean. An earlier version appended its own check to the engine's
 * result, which put half the readiness rule in the engine and half in a route; a second surface
 * would then have had to remember to append the same thing.
 *
 * **No secret appears in the response.** Providers are named, the store is reported as configured or
 * not, and no connection string, key or bucket name is included — a readiness endpoint is usually
 * the most reachable thing a deployment has.
 */
export const GET = async (): Promise<Response> => {
  const report = await readiness(getEngine(), {
    persistentStore: isPersistent(),
    hosted: isHostedDeployment(),
  });
  return jsonOk(report, report.ready ? 200 : 503);
};
