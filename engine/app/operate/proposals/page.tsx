import { RecommendationCard } from '../../../components/RecommendationCard.tsx';
import { getEngine } from '../../../lib/engine-instance.ts';
import { resolveViewer } from '../../../lib/persona.ts';
import { pendingSuggestions } from '../../../src/engines/normalization.engine.ts';
import { openProposals } from '../../../src/engines/proposal.engine.ts';
import { eq } from '../../../src/ports/store.ts';
import type { Experience } from '../../../src/domain/experience.ts';

export const dynamic = 'force-dynamic';

/**
 * Proposals awaiting a decision — two kinds, deliberately not merged.
 *
 * **Governed recommendations** are machine suggestions about a platform action: a
 * reviewer decides them, and approving dispatches the target engine's own command
 * rather than writing its state. Those get approve / reject / escalate here.
 *
 * **Unconfirmed structure** is what was read out of somebody's own account. That is
 * theirs to confirm, and there is no approve control on it at all — an operator
 * confirming it on their behalf would be the exact substitution the design
 * forbids. Until they do, matching treats each field as *unknown*, never as the
 * suggested value.
 *
 * The reason the two live on one page but in separate sections: they are both
 * "things a machine proposed", and a reviewer needs to see the whole queue. The
 * reason they are never one list: only one of them is a reviewer's to decide.
 */
const ProposalsPage = async () => {
  const viewer = await resolveViewer();
  if (!viewer.personas.includes('intelligence')) {
    return (
      <div className="empty">
        <h1>Not available</h1>
        <p>This surface is for moderators.</p>
      </div>
    );
  }

  const engine = getEngine();

  const recommendations = await openProposals(engine);

  const published = await engine.store.experiences.query([eq<Experience>('status', 'published')], {
    orderBy: { field: 'publishedAt', direction: 'desc' },
    limit: 50,
  });

  const rows = [];
  for (const experience of published) {
    const suggestions = await pendingSuggestions(engine, experience.id);
    if (suggestions.length === 0) continue;
    rows.push({ experienceId: experience.id, suggestions });
  }

  return (
    <>
      <h1>Proposals</h1>
      <p className="lede">What the system has suggested, and who decides it.</p>

      <section className="recommendations-section" aria-labelledby="recommendations-heading">
        <h2 id="recommendations-heading">Recommendations for you to decide</h2>
        <p className="proposal-rule">
          A recommendation carries no authority. Approving one runs the action through the engine
          that owns it, under the same rules as doing it by hand — so it can be refused, and you
          will be told if it is.
        </p>

        {recommendations.length === 0 ? (
          <div className="empty">
            <h3>Nothing to decide.</h3>
            <p>Recommendations awaiting a decision will appear here.</p>
          </div>
        ) : (
          <ul className="recommendations">
            {recommendations.map((row) => (
              <RecommendationCard
                key={row.id}
                recommendation={{
                  proposalId: row.id,
                  proposalType: row.proposalType,
                  sourceEngine: row.sourceEngine,
                  targetEngine: row.targetEngine,
                  subjectId: row.subjectId,
                  summary: row.summary,
                  rationale: row.rationale,
                  confidence: row.confidence,
                  evidenceRefs: row.evidenceRefs,
                  status: row.status,
                  proposedCommand: row.proposedCommand,
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="unconfirmed-section" aria-labelledby="unconfirmed-heading">
        <h2 id="unconfirmed-heading">Structure only its author can confirm</h2>
        <p className="proposal-rule">
          Nothing here has been applied. Until the person confirms it, matching treats each field as
          unknown — never as the proposed value. There is no control here for you to confirm it on
          their behalf.
        </p>

        {rows.length === 0 ? (
          <div className="empty">
            <h3>Nothing proposed.</h3>
            <p>Suggestions awaiting confirmation will appear here.</p>
          </div>
        ) : (
          <ul className="proposals">
            {rows.map((row) => (
              <li className="proposal" key={row.experienceId}>
                <p className="proposal-target">
                  <a href={`/experiences/${row.experienceId}`}>{row.experienceId}</a>
                </p>
                <ul className="proposal-fields">
                  {row.suggestions.map((suggestion) => (
                    <li key={`${row.experienceId}:${suggestion.field}`}>
                      <span className="proposal-field">{suggestion.field}</span>
                      <span className="proposal-value">{suggestion.value}</span>
                      <span className="proposal-confidence">
                        {Math.round(suggestion.confidence * 100)}% confidence
                      </span>
                      {suggestion.evidence === undefined ? null : (
                        // The person's own words, never a paraphrase.
                        <span className="proposal-evidence">“{suggestion.evidence}”</span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="proposal-owner">Awaiting confirmation from the person who posted it.</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
};

export default ProposalsPage;
