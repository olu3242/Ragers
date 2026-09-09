import { getEngine } from '../../../lib/engine-instance.ts';
import { jsonOk } from '../../../lib/api.ts';

/** Operational readiness. Reports per-dependency state, never internal detail. */
export const GET = async (): Promise<Response> => {
  const report = await getEngine().health.report();
  const status = report.state === 'unhealthy' ? 503 : 200;
  return jsonOk(report, status);
};
