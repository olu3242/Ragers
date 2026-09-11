/**
 * How long something has been waiting.
 *
 * Words rather than a figure, and deliberately no overdue indicator: nothing here is
 * measured against an agreement, because no service-level agreement exists to be
 * overdue against. "Unresolved for 3 weeks" is a fact. "3 weeks overdue" would be an
 * accusation the platform is not in a position to make.
 *
 * Silence is reported as silence: an organization that has never responded produces
 * "no response yet", not "responded in 0 days".
 */
export interface AgingView {
  readonly unresolvedFor?: string;
  readonly sinceOrganizationContact?: string;
  readonly proposedUnconfirmedFor?: string;
  readonly unresolved: boolean;
}

export const AgingNote = ({ aging }: { aging: AgingView }) => {
  const parts: string[] = [];
  if (aging.unresolved && aging.unresolvedFor !== undefined) {
    parts.push(`unresolved for ${aging.unresolvedFor}`);
  }
  parts.push(
    aging.sinceOrganizationContact === undefined
      ? 'no response yet'
      : `last response ${aging.sinceOrganizationContact} ago`,
  );
  if (aging.proposedUnconfirmedFor !== undefined) {
    parts.push(`a described fix has gone unconfirmed for ${aging.proposedUnconfirmedFor}`);
  }

  return <p className="aging">{parts.join(' · ')}</p>;
};
