import { eq } from '../../src/ports/store.ts';
import { getEngine } from '../../lib/engine-instance.ts';
import { resolveViewer } from '../../lib/persona.ts';
import { ModerationQueue, type QueueCase } from '../../components/ModerationQueue.tsx';
import type { ScreeningResult } from '../../src/ports/store.ts';

export const dynamic = 'force-dynamic';

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
