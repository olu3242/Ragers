import { eq } from '../../src/ports/store.ts';
import { getEngine } from '../../lib/engine-instance.ts';
import { resolveViewer } from '../../lib/persona.ts';
import { ModerationQueue, type QueueCase } from '../../components/ModerationQueue.tsx';
import { escalationsOf } from '../../src/engines/escalation.engine.ts';
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

  return (
    <>
      <h1>Review queue</h1>
      <p className="lede">
        Content routed here needs a human decision. Deciding that nothing is wrong is one of them.
      </p>
      <ModerationQueue cases={cases} actorId={viewer.actor.actorId} />
    </>
  );
};

export default OperatePage;
