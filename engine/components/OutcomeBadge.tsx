import { OUTCOME_COPY, type OutcomePresentation } from '../src/domain/outcome-presentation.ts';

/**
 * The one component that says what state an outcome is in.
 *
 * Shared by every surface — consumer card, organization inbox, cluster page — so
 * the five distinguishable states cannot drift into different words in different
 * places. Where a badge could be mistaken for a resolution, the explanation is
 * shown rather than tucked into a tooltip.
 */
export const OutcomeBadge = ({
  presentation,
  showExplanation = true,
}: {
  presentation: OutcomePresentation;
  showExplanation?: boolean;
}) => {
  const copy = OUTCOME_COPY[presentation];
  return (
    <span className={`outcome outcome-${presentation}`}>
      <span className="outcome-badge">{copy.badge}</span>
      {showExplanation || copy.clarifies ? (
        <span className="outcome-explanation">{copy.explanation}</span>
      ) : null}
    </span>
  );
};
