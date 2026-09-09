/**
 * An organization's answering record.
 *
 * Not an SLA and not labelled as one: no service-level agreement exists, so there
 * is nothing to be overdue against and no overdue indicator here. What is shown is
 * measured — how many cases, how many answered, how many the people it happened to
 * confirmed resolved.
 *
 * Below the sample floor the timings are absent from the payload entirely, and this
 * component renders the caption that says how far off it is rather than a
 * precise-looking number from two cases.
 */
export interface Responsiveness {
  readonly casesTotal: number;
  readonly casesAnswered: number;
  readonly casesConfirmedResolved: number;
  readonly casesOpen: number;
  readonly responseRate: number;
  readonly resolutionRate: number;
  readonly medianAcknowledgementMs?: number;
  readonly medianFirstResponseMs?: number;
  readonly medianResolutionMs?: number;
  readonly oldestOpenMs?: number;
  readonly sampleSize: number;
  readonly insufficientSample: boolean;
  readonly caption: string;
}

/** Plain duration wording. Never a false precision like "1.7 days". */
const duration = (ms: number): string => {
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
};

export const ResponsivenessPanel = ({ responsiveness }: { responsiveness: Responsiveness }) => (
  <section className="responsiveness">
    <dl className="signal-grid">
      <div>
        <dt>Cases</dt>
        <dd>{responsiveness.casesTotal}</dd>
      </div>
      <div>
        <dt>Answered</dt>
        <dd>{responsiveness.casesAnswered}</dd>
      </div>
      <div>
        {/* Deliberately worded as confirmed, and by whom. */}
        <dt>Confirmed resolved</dt>
        <dd>{responsiveness.casesConfirmedResolved}</dd>
      </div>
      <div>
        <dt>Still open</dt>
        <dd>{responsiveness.casesOpen}</dd>
      </div>
    </dl>

    {responsiveness.insufficientSample ? (
      <p className="responsiveness-note">{responsiveness.caption}</p>
    ) : (
      <ul className="responsiveness-timings">
        {responsiveness.medianAcknowledgementMs === undefined ? null : (
          <li>
            Typically acknowledges in <strong>{duration(responsiveness.medianAcknowledgementMs)}</strong>
          </li>
        )}
        {responsiveness.medianFirstResponseMs === undefined ? null : (
          <li>
            Typically first replies in <strong>{duration(responsiveness.medianFirstResponseMs)}</strong>
          </li>
        )}
        {responsiveness.medianResolutionMs === undefined ? null : (
          <li>
            Where confirmed resolved, typically in{' '}
            <strong>{duration(responsiveness.medianResolutionMs)}</strong>
          </li>
        )}
        {responsiveness.oldestOpenMs === undefined ? null : (
          <li>
            Oldest still open: <strong>{duration(responsiveness.oldestOpenMs)}</strong>
          </li>
        )}
      </ul>
    )}

    {responsiveness.insufficientSample ? null : (
      <p className="signal-caption">{responsiveness.caption}</p>
    )}
  </section>
);
