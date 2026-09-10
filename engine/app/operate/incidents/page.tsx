import { getEngine } from '../../../lib/engine-instance.ts';
import { resolveViewer } from '../../../lib/persona.ts';
import { incidentReport, STRUGGLING_ATTEMPT_THRESHOLD } from '../../../src/engines/incident.engine.ts';
import { degradedStateFrom } from '../../../src/domain/degraded.ts';
import { describeDuration } from '../../../src/domain/aging.ts';

export const dynamic = 'force-dynamic';

/**
 * The incident surface — Phase 66.
 *
 * Everything an operator needed during an incident already existed as a table. What did
 * not exist was a read: diagnosing a stuck pipeline meant opening psql and remembering
 * the schema, at the hour when remembering things is hardest.
 *
 * Gated twice, like every operator surface here. The page refuses a non-operator, and the
 * one action it offers — replaying a dead letter — goes through
 * `governance.replayDeadLetter`, where the policy matrix decides again and an audit event
 * is written. Neither check is load-bearing alone, and the replay path is the existing one
 * rather than a second: a second path is how one of them ends up without the audit.
 *
 * **This page reports and does not act.** No retry, no reclaim, no drain. The runtime
 * already reclaims a dead worker's leases on its own schedule, and a surface that also did
 * it would be a second actor racing the first — precisely the class of bug an incident
 * surface exists to help find.
 */
const IncidentsPage = async () => {
  const viewer = await resolveViewer();
  if (!viewer.personas.includes('operator')) {
    return (
      <div className="empty">
        <h1>Not available</h1>
        <p>This surface is for moderators.</p>
      </div>
    );
  }

  const report = await incidentReport(getEngine());
  // Derived here rather than in the engine module. Phase 67's guard keeps `degraded.ts`
  // out of `src/domain` and `src/engines` entirely, so an unavailable dependency can never
  // start causing refusals on top of the ones it already causes — and a surface is the
  // right place for a lens.
  const degraded = degradedStateFrom(report.health);

  return (
    <>
      <h1>System state</h1>
      <p className="lede">
        What is failing, what is behind, and what is consequently being refused. Read as of one
        moment, so every number here agrees with every other.
      </p>

      <section aria-labelledby="state-heading" className="incident-state">
        <h2 id="state-heading">
          {degraded.level === 'nominal'
            ? 'Everything is healthy'
            : degraded.level === 'degraded'
              ? 'Something is behind'
              : 'Requests are being refused'}
        </h2>
        {degraded.affected.length === 0 ? (
          <p>Every dependency is responding.</p>
        ) : (
          <ul className="incident-dependencies">
            {degraded.affected.map((dependency) => (
              <li key={dependency.name}>
                <p className="incident-dependency">
                  <strong>{dependency.name}</strong> — {dependency.state}
                  {dependency.detail === undefined ? '' : `: ${dependency.detail}`}
                </p>
                <p className="incident-summary">{dependency.consequences.summary}</p>
                {/* What still works, named on purpose. During an incident the expensive
                    mistake is assuming everything is down and telling everybody so. */}
                <ul className="incident-unaffected">
                  {dependency.consequences.unaffected.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {degraded.refusing.length > 0 && (
          <>
            <h3>Being refused</h3>
            <ul className="incident-refusing">
              {degraded.refusing.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="workers-heading">
        <h2 id="workers-heading">Workers</h2>
        {report.workers.length === 0 ? (
          // Distinguished from "all healthy" on purpose: no workers registered and every
          // worker healthy look identical on a page that only lists problems, and they are
          // opposite situations.
          <p>No worker has registered. Nothing is draining the queue.</p>
        ) : (
          <ul className="incident-workers">
            {report.workers.map((worker) => {
              const stale = report.staleWorkers.find((candidate) => candidate.id === worker.id);
              return (
                <li key={worker.id}>
                  <strong>{worker.hostname}</strong> — {worker.state}
                  {stale === undefined
                    ? ''
                    : ` · silent for ${describeDuration(stale.silentForMs)}`}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="behind-heading">
        <h2 id="behind-heading">Work in flight</h2>
        <p>
          {report.outboxPending} event{report.outboxPending === 1 ? '' : 's'} waiting to be
          delivered.
        </p>
        {report.struggling.length === 0 ? (
          <p>Nothing has failed more than {STRUGGLING_ATTEMPT_THRESHOLD - 1} times.</p>
        ) : (
          <ul className="incident-struggling">
            {report.struggling.map((event) => (
              <li key={event.id}>
                <strong>{event.eventName}</strong> on {event.aggregateType} {event.aggregateId} —
                attempt {event.attemptCount}
                {event.lastError === undefined ? '' : `: ${event.lastError}`}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="dead-heading">
        <h2 id="dead-heading">Exhausted work</h2>
        <p className="lede">
          Work that failed every retry. Nothing here was dropped; it is waiting for a person to
          decide what happened.
        </p>
        {report.deadLetters.length === 0 ? (
          <p>Nothing has been dead-lettered.</p>
        ) : (
          <ul className="incident-dead-letters">
            {report.deadLetters.map((entry) => (
              <li key={entry.id}>
                <p>
                  <strong>{entry.eventName}</strong> on {entry.aggregateType} {entry.aggregateId}
                  {entry.replayCount > 0 ? ` · replayed ${entry.replayCount}×` : ''}
                </p>
                {/* The full failure history, because "it failed" is not a diagnosis and the
                    attempt that failed differently is usually the informative one. */}
                <ol className="incident-failures">
                  {entry.failureHistory.map((failure) => (
                    <li key={`${entry.id}-${failure.attempt}`}>
                      attempt {failure.attempt}: {failure.error}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
};

export default IncidentsPage;
