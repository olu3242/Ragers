import { getEngine } from '../../../lib/engine-instance.ts';
import { jsonOk } from '../../../lib/api.ts';
import { readiness } from '../../../src/engines/observability.engine.ts';
import { isPersistent } from '../../../lib/engine-store.ts';

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

  /**
   * Whether this process persists anything — added after a P1 on PR #5.
   *
   * The composition root used to build an in-memory engine unconditionally, and an in-memory
   * instance is *healthy* by every dependency check while losing all state on restart and
   * disagreeing with its siblings. So readiness reports it, and reports the **presence** of a
   * configured URL rather than the URL, because a connection string is a credential.
   *
   * It does not make the instance unready: `npm run dev` is legitimately in-memory. What it does
   * is make the fact visible to whoever is looking at why data vanished.
   */
  const persistent = isPersistent();
  return jsonOk(
    {
      ...report,
      persistent,
      checks: [
        ...report.checks,
        {
          name: 'persistent_store',
          ok: persistent,
          detail: persistent
            ? 'a database is configured; state survives a restart'
            : 'in-memory adapters: state is lost on restart and is not shared between processes',
        },
      ],
    },
    report.ready ? 200 : 503,
  );
};
