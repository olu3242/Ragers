import { eq } from '../../src/ports/store.ts';
import { getEngine } from '../../lib/engine-instance.ts';
import { resolveViewer } from '../../lib/persona.ts';
import { ModerationQueue, type QueueCase } from '../../components/ModerationQueue.tsx';
import { PriorityRow } from '../../components/PriorityRow.tsx';
import { escalationsOf } from '../../src/engines/escalation.engine.ts';
import { prioritisedQueue } from '../../src/engines/priority.engine.ts';
import { ageOf, describeDuration } from '../../src/domain/aging.ts';
import { eq as equals } from '../../src/ports/store.ts';
import type { ResolutionEventRow, ScreeningResult } from '../../src/ports/store.ts';
import type { ResolutionStatus } from '../../src/domain/resolution.ts';

export const dynamic = 'force-dynamic';

/**
 * How long it has been waiting, in words.
 *
 * No overdue indicator, here or anywhere: nothing is measured against an agreement,
 * because no service-level agreement exists to be overdue against.
 */
const describeUnresolved = (aging: { unresolved: boolean; inCurrentStatusMs: number }): string =>
  aging.unresolved
    ? `unresolved for ${describeDuration(aging.inCurrentStatusMs)}`
    : `settled ${describeDuration(aging.inCurrentStatusMs)} ago`;

/**
 * Operator surface.
 *
 * Gated twice on purpose. The page refuses a non-operator, and every action it
 * offers goes through the command bus where `moderation.claim` and
 * `moderation.action` decide again. Neither check is load-bearing alone.
 */
const OperatePage = async () => {
  const viewer = await resolveViewer();
  if (!viewer.personas.includes('operator')) {
    return (
      <div className="empty">
        <h1>Not available</h1>
        <p>This surface is for moderators.</p>
      </div>
    );
  }

  const engine = getEngine();
  const items = await engine.store.queueItems.query(
    [{ field: 'state', op: 'in', value: ['queued', 'claimed'] }],
    { orderBy: { field: 'priority', direction: 'desc' } },
  );

  // The prioritised queue, read once and joined by experience id. Position is derived
  // here rather than stored: a stored position is wrong the moment anything else in the
  // queue changes, and a stale "#9" is worse than no number at all.
  const ranked = new Map((await prioritisedQueue(engine)).map((entry) => [entry.subjectId, entry]));

  const cases: QueueCase[] = [];
  for (const item of items) {
    const experience = await engine.store.experiences.get(item.targetId);
    const screening = await engine.store.screenings.queryOne([
      eq<ScreeningResult>('targetId', item.targetId),
    ]);
    cases.push({
      queueItemId: item.id,
      targetType: item.targetType,
      targetId: item.targetId,
      priority: item.priority,
      state: item.state,
      ...(item.claimedBy === undefined ? {} : { claimedBy: item.claimedBy }),
      signals: screening?.signals ?? [],
      screeningOutcome: screening?.outcome ?? 'unknown',
      reportCount: await engine.store.reports.countWhere([eq('targetId', item.targetId)]),
      publicationStatus: experience?.status ?? 'unknown',
      bodyText: experience?.bodyText ?? '',
      escalations: (await escalationsOf(engine, item.targetId)).map((row) => row.because),
      ...(await (async () => {
        const entry = ranked.get(item.targetId);
        if (!entry) return {};
        const row = await engine.store.priorities.get(`pri:${item.targetId}`);
        return {
          ranking: {
            band: entry.band,
            reason: entry.reason,
            urgency: entry.urgency,
            urgencyFactors: row?.urgencyFactors ?? [],
            ...(entry.peopleAffected === undefined ? {} : { peopleAffected: entry.peopleAffected }),
            impactKnown: entry.impactKnown,
            unassessed: entry.unassessed,
            position: entry.position,
          },
        };
      })()),
      // Aging is derived on read from the event log, never stored — so what an
      // operator sees is what the log says, not a counter somebody forgot to update.
      ...(experience?.publishedAt === undefined
        ? {}
        : {
            aging: describeUnresolved(
              ageOf({
                events: await engine.store.resolutionEvents.query([
                  equals<ResolutionEventRow>('experienceId', item.targetId),
                ]),
                currentStatus: (experience.resolutionStatus ?? 'open') as ResolutionStatus,
                publishedAt: experience.publishedAt,
                now: Date.now(),
              }),
            ),
          }),
    });
  }

  /**
   * Two lists, and they are not the same question.
   *
   * The review queue is about *content decisions* — screening or a report routed
   * something here, and much of it is not published yet. Priority is about *what to look
   * at first among things that are live*, and its inputs (elapsed time, corroborations,
   * resolution state) only exist after publication.
   *
   * Decorating one with the other would have been the tempting shortcut and would have
   * produced a queue where half the rows silently have no ranking. Two sections, each
   * answering its own question, is the honest shape.
   */
  const ranking = [...ranked.values()];
  const rankedRows = [];
  for (const entry of ranking.slice(0, 25)) {
    const row = await engine.store.priorities.get(`pri:${entry.subjectId}`);
    const experience = await engine.store.experiences.get(entry.subjectId);
    rankedRows.push({ entry, row, experience });
  }

  return (
    <>
      <h1>Review queue</h1>
      <p className="lede">
        Content routed here needs a human decision. Deciding that nothing is wrong is one of them.
      </p>
      <ModerationQueue cases={cases} actorId={viewer.actor.actorId} />

      <section className="ranked-section" aria-labelledby="ranked-heading">
        <h2 id="ranked-heading">What to look at first</h2>
        <p className="lede">
          Published accounts, ordered by what people said it cost them and how long it has been
          waiting. Ordering is by named dimensions — there is no score.
        </p>
        {rankedRows.length === 0 ? (
          <div className="empty">
            <h3>Nothing ranked yet.</h3>
            <p>An account is ranked once somebody says what it cost them.</p>
          </div>
        ) : (
          <ul className="ranked">
            {rankedRows.map(({ entry, row, experience }) => (
              <li className="ranked-item" key={entry.subjectId}>
                <p className="ranked-body">
                  <a href={`/experiences/${entry.subjectId}`}>{experience?.bodyText ?? entry.subjectId}</a>
                </p>
                <PriorityRow
                  priority={{
                    band: entry.band,
                    reason: entry.reason,
                    urgency: entry.urgency,
                    urgencyFactors: row?.urgencyFactors ?? [],
                    ...(entry.peopleAffected === undefined ? {} : { peopleAffected: entry.peopleAffected }),
                    impactKnown: entry.impactKnown,
                    unassessed: entry.unassessed,
                    position: entry.position,
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
};

export default OperatePage;
