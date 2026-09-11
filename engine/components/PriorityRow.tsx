import { URGENCY_LABELS, type UrgencyLevel } from '../src/domain/urgency.ts';
import type { PriorityBand } from '../src/domain/priority.ts';

/**
 * Where something sits in the queue, and why.
 *
 * Four things this deliberately does not render:
 *
 *   1. **A score.** There isn't one to render. The band comes from stated rules over
 *      named inputs, and a number here would invite exactly the comparison across
 *      unlike experiences that the rules avoid.
 *   2. **Severity and urgency as one thing.** They are shown separately because they
 *      disagree constantly — a minor problem left for months is not severe and is
 *      urgent — and a reader who cannot see both cannot judge the position.
 *   3. **A zero for an unknown impact.** "Not enough people have said this happened to
 *      them" and "nobody was affected" are opposite statements. Only the first is true
 *      when the estimate is withheld, and only the first is shown.
 *   4. **Anything at all when nothing was assessed.** An unassessed experience is not
 *      in the queue; rendering `LOW` for it would report an absence of information as a
 *      judgement that it does not matter.
 */
export interface PriorityView {
  readonly band: PriorityBand;
  readonly reason: string;
  readonly urgency: UrgencyLevel;
  /** Why it is urgent, in the words a person reads. */
  readonly urgencyFactors: readonly string[];
  readonly peopleAffected?: number;
  readonly impactKnown: boolean;
  readonly unassessed: boolean;
  readonly position?: number;
}

const BAND_LABELS: Readonly<Record<PriorityBand, string>> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

export const PriorityRow = ({ priority }: { priority: PriorityView | undefined }) => {
  if (priority === undefined || priority.unassessed) return null;

  return (
    <div className={`priority priority-${priority.band.toLowerCase()}`}>
      <p className="priority-head">
        {priority.position === undefined ? null : (
          <span className="priority-position">#{priority.position}</span>
        )}
        {/* Band and urgency named separately, in words, because they answer different
            questions and colour carries neither on its own. */}
        <span className="priority-band">{BAND_LABELS[priority.band]} priority</span>
        <span className="priority-urgency">{URGENCY_LABELS[priority.urgency]}</span>
      </p>

      {/* The reason names a cause. "High priority" alone tells an operator nothing. */}
      <p className="priority-reason">{priority.reason}</p>

      {priority.urgencyFactors.length === 0 ? null : (
        <ul className="priority-factors">
          {priority.urgencyFactors.map((factor) => (
            <li key={factor}>{factor}</li>
          ))}
        </ul>
      )}

      <p className="priority-impact">
        {priority.impactKnown && priority.peopleAffected !== undefined
          ? `${priority.peopleAffected} people say this happened to them`
          : 'Not enough people have said this happened to them to estimate what it has cost'}
      </p>
    </div>
  );
};
