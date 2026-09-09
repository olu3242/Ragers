import { getEngine } from '../../../lib/engine-instance.ts';
import { resolveViewer } from '../../../lib/persona.ts';
import { toPublicExperience } from '../../../src/domain/projection.ts';
import { summariseFairness } from '../../../src/engines/reaction.engine.ts';
import { mayReportResolution, resolutionSummaryFor } from '../../../src/engines/resolution.engine.ts';
import { publicResponsesFor } from '../../../src/engines/organization.engine.ts';
import { disputesFor } from '../../../src/engines/dispute.engine.ts';
import { relatedTo } from '../../../src/engines/relation.engine.ts';
import { evidenceSummaryFor } from '../../../src/engines/evidence.engine.ts';
import { ReactionRow } from '../../../components/ReactionRow.tsx';
import { SignalRow } from '../../../components/SignalRow.tsx';
import { ResolutionRow } from '../../../components/ResolutionRow.tsx';
import { OrganizationResponses } from '../../../components/OrganizationResponses.tsx';
import { RelateControl } from '../../../components/RelateControl.tsx';
import { DisputeControl } from '../../../components/DisputeControl.tsx';
import { SeverityBadge } from '../../../components/SeverityBadge.tsx';
import { CostControl } from '../../../components/CostControl.tsx';
import { severityFor } from '../../../src/engines/severity.engine.ts';
import { enrichmentFor } from '../../../src/engines/enrichment.engine.ts';
import { assertedValues } from '../../../src/domain/enrichment.ts';

export const dynamic = 'force-dynamic';

/**
 * One experience, with everything that has happened around it.
 *
 * Read from the feed projection, which carries an identity label and no author
 * reference — so this page cannot leak an author even by accident. The raw row is
 * consulted only for the things the projection deliberately omits and that a viewer
 * is entitled to (whether it is in a cluster).
 *
 * The ordering is the argument: the account, then what people claimed, then what the
 * organization said, then what the people it happened to reported. A response never
 * sits above the account it answers.
 */
const ExperiencePage = async ({ params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const engine = getEngine();
  const viewer = await resolveViewer();

  const entry = await engine.store.feedEntries.get(id);
  if (!entry || entry.suppressed) {
    return (
      <div className="empty">
        <h1>Not available</h1>
        <p>That experience is not available.</p>
      </div>
    );
  }

  const experience = await engine.store.experiences.get(id);
  const counters = await engine.store.counters.get(id);
  const resolution = await resolutionSummaryFor(engine, id);
  const disputes = await disputesFor(engine, id);
  const related = await relatedTo(engine, id);
  const responses = await publicResponsesFor(engine, { experienceId: id });
  const evidence = await evidenceSummaryFor(engine, id);
  const severity = await severityFor(engine, id);
  // Only the author's own enrichment is read, and only to avoid asking them twice.
  // Nobody else's view of this page touches the row.
  const isAuthor = viewer.actor.authenticated && experience?.actorId === viewer.actor.actorId;
  const enrichment = isAuthor ? await enrichmentFor(engine, id) : undefined;
  const canReport =
    viewer.actor.authenticated && (await mayReportResolution(engine, id, viewer.actor.actorId));

  const projection = experience
    ? toPublicExperience(experience, {
        ...(entry.identityLabel === undefined ? {} : { displayName: entry.identityLabel }),
      })
    : undefined;

  return (
    <article className="card card-detail">
      <div className="card-head">
        <span className={entry.kind === 'rage' ? 'badge badge-rage' : 'badge badge-rave'}>
          {entry.kind === 'rage' ? 'Rager' : 'Rave'}
        </span>
        {entry.hasVoice ? <span className="badge badge-protected">Identity Protected</span> : null}
        {/* Contested is shown here, next to the account, because it is about the
            account — not folded into the outcome badge below. */}
        {disputes.contested ? <span className="badge badge-contested">Contested</span> : null}
        <span className="byline">{entry.identityLabel}</span>
      </div>

      <p className="card-body">{projection?.bodyText ?? entry.excerpt}</p>

      {/* What the person said it cost them. Renders nothing when they said nothing:
          an unassessed experience must not read as a mild one. */}
      <SeverityBadge
        severity={
          severity === undefined
            ? undefined
            : { band: severity.band, basis: severity.basis, unassessed: severity.unassessed }
        }
      />

      {evidence.count > 0 ? (
        <p className="evidence-note">
          {evidence.count} piece{evidence.count === 1 ? '' : 's'} of evidence attached
          {evidence.latestOutcome === 'unassessed'
            ? ', not yet assessed'
            : `, most recently assessed as ${evidence.latestOutcome}`}
          .
        </p>
      ) : null}

      <SignalRow
        experienceId={id}
        kind={entry.kind}
        counts={{
          corroborations: (counters?.reRageCount ?? 0) + (counters?.reRaveCount ?? 0),
          shares: counters?.shareCount ?? 0,
        }}
      />
      <ReactionRow
        experienceId={id}
        counts={{
          same: counters?.same ?? 0,
          fairPoint: counters?.fairPoint ?? 0,
          disagree: counters?.disagree ?? 0,
          replyCount: counters?.replyCount ?? 0,
        }}
      />

      {isAuthor ? (
        <CostControl
          experienceId={id}
          asserted={enrichment ? assertedValues(enrichment).map((value) => value.dimension) : []}
        />
      ) : null}

      <RelateControl
        experienceId={id}
        related={related.map((item) => ({ ...item }))}
        canRelate={viewer.actor.authenticated}
      />

      <OrganizationResponses responses={responses} />

      {resolution === undefined ? null : (
        <ResolutionRow
          experienceId={id}
          state={{
            status: resolution.status,
            reporters: resolution.reporters,
            resolvedShare: resolution.resolvedShare,
            partial: resolution.partial,
            unresolved: resolution.unresolved,
            organizationResponded: resolution.organizationResponded,
            resolutionProposed: resolution.resolutionProposed,
            presentation: resolution.presentation,
          }}
          canReport={canReport}
        />
      )}

      <DisputeControl
        experienceId={id}
        contested={disputes.contested}
        disputes={disputes.disputes.map((row) => ({ ...row }))}
        canDispute={viewer.actor.authenticated}
        organizations={viewer.organizations.map((organization) => ({ ...organization }))}
      />

      <div className="fairness">
        {(() => {
          const fairness = summariseFairness(counters?.fairYes ?? 0, counters?.fairNo ?? 0);
          return fairness.fairPercent === undefined ? (
            <span>Fair Rager? No votes yet.</span>
          ) : (
            <span>
              Fair Rager? {fairness.fairPercent}% yes · {fairness.totalVotes} vote
              {fairness.totalVotes === 1 ? '' : 's'}
            </span>
          );
        })()}
      </div>

      {experience?.clusterId === undefined ? null : (
        <p className="detail-cluster">
          <a href={`/clusters/${experience.clusterId}`}>See the pattern this belongs to</a>
        </p>
      )}
    </article>
  );
};

export default ExperiencePage;
