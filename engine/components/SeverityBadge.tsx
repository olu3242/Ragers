import { BAND_LABELS, type SeverityBand } from '../src/domain/severity.ts';

/**
 * How serious the person said it was.
 *
 * Three things this component refuses to do, each for a reason:
 *
 *   1. **It shows no number.** A band is four named steps a reader can reason about.
 *      A 0–100 score invites comparison across unlike experiences, and puts a figure
 *      next to a person that they never chose.
 *   2. **It says whose account it is.** "They said" rather than a bare label, because
 *      severity here is asserted by the person it happened to, not measured by us.
 *   3. **It renders nothing at all when nothing was asserted.** An unassessed
 *      experience carries the band `minor` because a band is required; showing that
 *      would report an absence of information as a finding about the experience.
 *
 * The basis is shown alongside, so an organization reading "Serious" can see which
 * dimensions produced it rather than argue with a label.
 */
const BASIS_LABELS: Readonly<Record<string, string>> = {
  money_lost: 'money lost',
  time_lost_minutes: 'time lost',
  service_interrupted: 'service interrupted',
  safety_involved: 'safety involved',
  recurrence: 'it keeps happening',
  people_affected: 'other people affected',
};

export interface SeverityView {
  readonly band: SeverityBand;
  readonly basis: readonly string[];
  readonly unassessed: boolean;
}

export const SeverityBadge = ({ severity }: { severity: SeverityView | undefined }) => {
  // Nothing asserted, nothing to report. See (3) above.
  if (severity === undefined || severity.unassessed) return null;

  const basis = severity.basis.map((entry) => BASIS_LABELS[entry] ?? entry.replaceAll('_', ' '));

  return (
    <p className={`severity severity-${severity.band}`}>
      {/* State exposed as text, not by colour alone. */}
      <span className="severity-band">{BAND_LABELS[severity.band]}</span>
      <span className="severity-source">
        {' '}
        — what the person it happened to said it cost them
      </span>
      {basis.length === 0 ? null : <span className="severity-basis">: {basis.join(', ')}</span>}
    </p>
  );
};
