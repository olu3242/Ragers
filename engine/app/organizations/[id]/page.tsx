import { getEngine } from '../../../lib/engine-instance.ts';
import { resolveViewer } from '../../../lib/persona.ts';
import { organizationFor } from '../../../src/engines/organization.engine.ts';
import { resolutionSummaryFor } from '../../../src/engines/resolution.engine.ts';
import { eq } from '../../../src/ports/store.ts';
import { OrganizationCaseInbox, type OrganizationCase } from '../../../components/OrganizationCaseInbox.tsx';
import { ResponsivenessPanel } from '../../../components/ResponsivenessPanel.tsx';
import { publicResponsivenessFor } from '../../../src/engines/responsiveness.engine.ts';
import type { Experience } from '../../../src/domain/experience.ts';

export const dynamic = 'force-dynamic';

/**
 * Organization surface.
 *
 * Membership is resolved server-side through the same helper the respond command
 * uses, so a pending claim or a revoked membership sees the same refusal here as
 * it would from the API. The page never trusts a client-supplied organization id.
 */
const OrganizationPage = async ({ params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const viewer = await resolveViewer();
  const engine = getEngine();

  const scope = viewer.actor.authenticated
    ? await organizationFor(engine, viewer.actor.actorId, id)
    : undefined;

  if (!scope) {
    return (
      <div className="empty">
        <h1>Not available</h1>
        <p>You cannot act for that organization.</p>
      </div>
    );
  }

  const experiences = await engine.store.experiences.query(
    [eq<Experience>('entityId', scope.profile.entityId), eq<Experience>('status', 'published')],
    { orderBy: { field: 'publishedAt', direction: 'desc' }, limit: 100 },
  );

  const cases: OrganizationCase[] = [];
  for (const experience of experiences) {
    const counters = await engine.store.counters.get(experience.id);
    const summary = await resolutionSummaryFor(engine, experience.id);
    cases.push({
      experienceId: experience.id,
      kind: experience.kind,
      bodyText: experience.bodyText,
      corroborators: counters?.corroboratorCount ?? 0,
      reRages: counters?.reRageCount ?? 0,
      reRaves: counters?.reRaveCount ?? 0,
      presentation: summary?.presentation ?? 'unresolved_unreported',
      reporters: summary?.reporters ?? 0,
      resolvedShare: summary?.resolvedShare ?? 0,
      responded: summary?.organizationResponded ?? false,
      resolutionProposed: summary?.resolutionProposed ?? false,
      ...(experience.clusterId === undefined ? {} : { clusterId: experience.clusterId }),
    });
  }

  // Measured by the engine rather than counted in the page: the same figures a
  // viewer sees on the public record, so an organization is not shown a private
  // version of its own responsiveness.
  const responsiveness = await publicResponsivenessFor(engine, scope.profile.id);

  return (
    <>
      <h1>{scope.profile.displayName}</h1>
      <p className="lede">Experiences people have shared about your organization.</p>

      {/* Answering is not the same as fixing, so they are separate figures and the
          panel's caption says so. Not called an SLA: none exists. */}
      {responsiveness === undefined ? null : <ResponsivenessPanel responsiveness={responsiveness} />}

      <h2>Cases</h2>
      <OrganizationCaseInbox organizationId={scope.profile.id} cases={cases} />
    </>
  );
};

export default OrganizationPage;
