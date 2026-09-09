import { getEngine } from '../../../lib/engine-instance.ts';
import { resolveViewer } from '../../../lib/persona.ts';
import { pendingSuggestions } from '../../../src/engines/normalization.engine.ts';
import { eq } from '../../../src/ports/store.ts';
import type { Experience } from '../../../src/domain/experience.ts';

export const dynamic = 'force-dynamic';

/**
 * Governed proposals awaiting a decision.
 *
 * What is shown here is the only machine-generated proposal the platform
 * currently produces: extracted structure that nobody has confirmed. It is real,
 * not a placeholder — every row corresponds to a stored suggestion with the
 * person's own words attached, and none of it has been applied to anything.
 *
 * The rule this surface exists to make visible: **a proposal is not a decision.**
 * An unconfirmed suggestion is treated as *unknown* by matching and clustering,
 * not as the suggested value. So this page reports what has been proposed and who
 * has to act on it — and offers no approve button, because the person whose
 * experience it is confirms their own structure. An operator approving it on their
 * behalf would be the exact substitution the design forbids.
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
      <p className="lede">
        Structure that was read from an account and not confirmed by the person who wrote it.
      </p>
      <p className="proposal-rule">
        Nothing here has been applied. Until the person confirms it, matching treats each field as
        unknown — never as the proposed value.
      </p>

      {rows.length === 0 ? (
        <div className="empty">
          <h2>Nothing proposed.</h2>
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
    </>
  );
};

export default ProposalsPage;
