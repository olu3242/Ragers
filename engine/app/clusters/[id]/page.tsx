import { getEngine } from '../../../lib/engine-instance.ts';
import { clusterWithMembers } from '../../../src/engines/matching.engine.ts';
import { publicSignalFor } from '../../../src/engines/signal.engine.ts';
import { publicResponsesFor } from '../../../src/engines/organization.engine.ts';
import { OrganizationResponses } from '../../../components/OrganizationResponses.tsx';

export const dynamic = 'force-dynamic';

/**
 * A pattern: the same thing happening to more than one person.
 *
 * The numbers are shown as separate, named figures — how many people, how many
 * gave context, how many reported it fixed. There is deliberately no single
 * score and no "outrage" figure: one number invites ranking by whichever thing is
 * loudest, and these are the numbers that describe what is actually happening.
 */
const ClusterPage = async ({ params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const engine = getEngine();
  const view = await clusterWithMembers(engine, id);

  if (!view) {
    return (
      <div className="empty">
        <h1>Not found</h1>
        <p>That pattern is not available.</p>
      </div>
    );
  }

  const signal = await publicSignalFor(engine, id);
  const responses = await publicResponsesFor(engine, { clusterId: id });
  const isRage = view.cluster.kind === 'rage';

  return (
    <>
      <h1>{view.cluster.headline}</h1>
      <p className="lede">
        {isRage
          ? 'People reporting the same thing going wrong.'
          : 'People reporting the same thing going right.'}
      </p>

      <dl className="signal-grid">
        <div>
          <dt>People affected</dt>
          {/* The load-bearing number: people, each counted once. */}
          <dd>{signal?.peopleAffected ?? view.cluster.uniqueExperiencers}</dd>
        </div>
        <div>
          <dt>Experiences</dt>
          <dd>{signal?.experiences ?? view.cluster.totalExperiences}</dd>
        </div>
        <div>
          <dt>{isRage ? 'Re-Rages' : 'Re-Raves'}</dt>
          <dd>{signal?.corroborations ?? view.cluster.corroborations}</dd>
        </div>
        <div>
          <dt>With added context</dt>
          <dd>{signal?.withContext ?? 0}</dd>
        </div>
        <div>
          <dt>Reported resolved</dt>
          <dd>{Math.round((signal?.resolutionRate ?? 0) * 100)}%</dd>
        </div>
        <div>
          <dt>Answered</dt>
          <dd>{Math.round((signal?.responseRate ?? 0) * 100)}%</dd>
        </div>
      </dl>

      <p className="signal-caption">
        “Reported resolved” counts only what the people it happened to said. An organization
        responding is not the same thing.
      </p>

      <OrganizationResponses responses={responses} />

      <h2>Experiences in this pattern</h2>
      <ul className="cluster-members">
        {view.members.map((member) => (
          <li key={member.experienceId}>
            <a href={`/experiences/${member.experienceId}`}>{member.experienceId}</a>
            <span className="cluster-relationship">{member.relationship.replace(/_/g, ' ')}</span>
          </li>
        ))}
      </ul>
    </>
  );
};

export default ClusterPage;
