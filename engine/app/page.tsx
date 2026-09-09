import { getEngine } from '../lib/engine-instance.ts';
import { getRankedFeed } from '../src/engines/ranking.engine.ts';
import { summariseFairness } from '../src/engines/reaction.engine.ts';
import { ReactionRow } from '../components/ReactionRow.tsx';
import { SignalRow } from '../components/SignalRow.tsx';
import { ResolutionRow } from '../components/ResolutionRow.tsx';
import { OrganizationResponses } from '../components/OrganizationResponses.tsx';
import { VoicePlayer } from '../components/VoicePlayer.tsx';
import { resolutionSummaryFor, mayReportResolution } from '../src/engines/resolution.engine.ts';
import { publicResponsesFor } from '../src/engines/organization.engine.ts';
import { currentActor } from '../lib/session.ts';

export const dynamic = 'force-dynamic';

const formatDuration = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/**
 * The feed. Rendered entirely from the feed projection, which carries an
 * identity label and no author reference — so this page cannot leak an author
 * even by accident.
 */
const FeedPage = async () => {
  const engine = getEngine();
  const { entries } = await getRankedFeed(engine, { limit: 25 });
  const viewer = await currentActor();

  const cards = await Promise.all(
    entries.map(async (entry) => {
      const counters = await engine.store.counters.get(entry.experienceId);
      const experience = await engine.store.experiences.get(entry.experienceId);
      return {
        entry,
        mediaAssetId: experience?.mediaAssetId,
        signals: {
          // Two counts, never one: people who claim the experience, and times a
          // link was passed on.
          corroborations: (counters?.reRageCount ?? 0) + (counters?.reRaveCount ?? 0),
          shares: counters?.shareCount ?? 0,
        },
        counters: {
          same: counters?.same ?? 0,
          fairPoint: counters?.fairPoint ?? 0,
          disagree: counters?.disagree ?? 0,
          replyCount: counters?.replyCount ?? 0,
        },
        fairness: summariseFairness(counters?.fairYes ?? 0, counters?.fairNo ?? 0),
        resolution: await resolutionSummaryFor(engine, entry.experienceId),
        responses: await publicResponsesFor(engine, { experienceId: entry.experienceId }),
        // Only someone who claims the experience may report its outcome, so only
        // they are offered the control.
        canReport:
          viewer.authenticated &&
          (await mayReportResolution(engine, entry.experienceId, viewer.actorId)),
      };
    }),
  );

  return (
    <>
      <h1>What people noticed</h1>
      <p className="lede">
        Something that should happen less is a Rager. Something that should happen more is a Rave.
      </p>

      {cards.length === 0 ? (
        <div className="empty">
          <h2>No moments here yet.</h2>
          <p>Be the first to add one.</p>
          <a className="btn btn-primary" href="/compose">
            Create
          </a>
        </div>
      ) : (
        cards.map(({ entry, counters, signals, fairness, mediaAssetId, resolution, responses, canReport }) => (
          <article className="card" key={entry.experienceId}>
            <div className="card-head">
              <span className={entry.kind === 'rage' ? 'badge badge-rage' : 'badge badge-rave'}>
                {entry.kind === 'rage' ? 'Rager' : 'Rave'}
              </span>
              {entry.hasVoice ? (
                <span className="badge badge-voice">
                  Voice{entry.durationMs ? ` · ${formatDuration(entry.durationMs)}` : ''}
                </span>
              ) : null}
              {entry.hasVoice ? <span className="badge badge-protected">Identity Protected</span> : null}
              <span className="byline">{entry.identityLabel}</span>
            </div>

            {entry.excerpt ? <p className="card-body">{entry.excerpt}</p> : null}
            {entry.hasVoice && mediaAssetId ? <VoicePlayer mediaAssetId={mediaAssetId} /> : null}

            <SignalRow experienceId={entry.experienceId} kind={entry.kind} counts={signals} />
            <ReactionRow experienceId={entry.experienceId} counts={counters} />

            {resolution === undefined ? null : (
              <ResolutionRow
                experienceId={entry.experienceId}
                state={{
                  status: resolution.status,
                  reporters: resolution.reporters,
                  resolvedShare: resolution.resolvedShare,
                  partial: resolution.partial,
                  unresolved: resolution.unresolved,
                  organizationResponded: resolution.organizationResponded,
                }}
                canReport={canReport}
              />
            )}

            <OrganizationResponses responses={responses} />

            <div className="fairness">
              {fairness.fairPercent === undefined ? (
                <span>Fair Rager? No votes yet.</span>
              ) : (
                <>
                  <span>
                    Fair Rager? {fairness.fairPercent}% yes · {fairness.totalVotes} vote
                    {fairness.totalVotes === 1 ? '' : 's'}
                  </span>
                  <div className="meter" role="presentation">
                    <span style={{ width: `${fairness.fairPercent}%` }} />
                  </div>
                </>
              )}
            </div>
          </article>
        ))
      )}
    </>
  );
};

export default FeedPage;
