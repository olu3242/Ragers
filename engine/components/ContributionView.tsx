/**
 * What a person contributed, and what other people confirmed.
 *
 * Four named counts and no composite. A single score beside somebody's name turns
 * every contribution into a referendum on the contributor, and lands hardest on new
 * and anonymous accounts — which is to say on the people this product exists to make
 * safe. So the figures stay separate and each says what it counts.
 *
 * Nothing here comes from the trust layer. Below the sample floor the view says so
 * rather than showing a rate from one vote.
 */
export interface Contribution {
  readonly experiencesPublished: number;
  readonly corroboratedExperiences: number;
  readonly corroborationsGiven: number;
  readonly consistentEvidence: number;
  readonly approvalRate?: number;
  readonly totalFairVotes: number;
  readonly insufficientSample: boolean;
  readonly caption: string;
}

export const ContributionView = ({
  contribution,
  displayName,
}: {
  contribution: Contribution;
  displayName: string;
}) => (
  <section className="contribution">
    <h2>{displayName}</h2>

    <dl className="signal-grid">
      <div>
        <dt>Experiences shared</dt>
        <dd>{contribution.experiencesPublished}</dd>
      </div>
      <div>
        {/* Confirmation by other people, which is the meaningful one. */}
        <dt>Confirmed by others</dt>
        <dd>{contribution.corroboratedExperiences}</dd>
      </div>
      <div>
        <dt>Times they said “me too”</dt>
        <dd>{contribution.corroborationsGiven}</dd>
      </div>
      <div>
        <dt>Evidence found consistent</dt>
        <dd>{contribution.consistentEvidence}</dd>
      </div>
    </dl>

    {contribution.approvalRate === undefined ? (
      <p className="contribution-note">
        {contribution.insufficientSample
          ? 'Too little activity to describe a pattern yet.'
          : `Not enough Fair Rager? votes yet (${contribution.totalFairVotes}).`}
      </p>
    ) : (
      <p className="contribution-note">
        {Math.round(contribution.approvalRate * 100)}% of {contribution.totalFairVotes} Fair Rager?
        votes said their Ragers were fair.
      </p>
    )}

    <p className="signal-caption">{contribution.caption}</p>
  </section>
);
