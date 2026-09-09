import { getEngine } from '../../../../lib/engine-instance.ts';
import { jsonError, jsonOk } from '../../../../lib/api.ts';
import { unauthorizedError } from '../../../../src/runtime/errors.ts';
import { hasAtLeast } from '../../../../src/runtime/authz.ts';
import { eq } from '../../../../src/ports/store.ts';
import { currentActor } from '../../../../lib/session.ts';
import type { QueueItem, ScreeningResult } from '../../../../src/ports/store.ts';

/**
 * The moderation queue.
 *
 * A read, so it has no command to dispatch — which means the authorization check
 * has to be made here explicitly rather than inherited from the bus. It uses the
 * same role predicate the policy matrix uses for `moderation.read_queue`, so the
 * two cannot drift apart in spirit even though this path does not run the matrix.
 *
 * The rows carry the screening signals that routed each item to review, and the
 * body text so a moderator can actually judge it. Nothing here is a public
 * surface: `moderation.read_queue` is moderator-only.
 */
export const GET = async (): Promise<Response> => {
  const actor = await currentActor();
  if (!hasAtLeast(actor.role, 'moderator')) {
    return jsonError(unauthorizedError('policy_role', 'that surface is for moderators'));
  }

  const engine = getEngine();
  const items = await engine.store.queueItems.query(
    [{ field: 'state', op: 'in', value: ['queued', 'claimed'] }],
    { orderBy: { field: 'priority', direction: 'desc' } },
  );

  const cases = [];
  for (const item of items) {
    const experience = await engine.store.experiences.get(item.targetId);
    const screening = await engine.store.screenings.queryOne([
      eq<ScreeningResult>('targetId', item.targetId),
    ]);
    const reports = await engine.store.reports.countWhere([eq('targetId', item.targetId)]);
    cases.push({
      queueItemId: item.id,
      targetType: item.targetType,
      targetId: item.targetId,
      priority: item.priority,
      state: item.state,
      claimedBy: item.claimedBy,
      // Why it is here, so a moderator is not guessing.
      signals: screening?.signals ?? [],
      screeningOutcome: screening?.outcome ?? 'unknown',
      reportCount: reports,
      // Publication state, which is what a moderation decision acts on. The
      // outcome axis is a different question and is not shown here.
      publicationStatus: experience?.status ?? 'unknown',
      bodyText: experience?.bodyText ?? '',
      createdAt: item.createdAt,
    });
  }

  return jsonOk({
    cases,
    claimedByMe: cases.filter((row) => row.claimedBy === actor.actorId).length,
  });
};

/** Narrow re-export so the page and the tests agree on the row shape. */
export type ModerationCase = {
  readonly queueItemId: string;
  readonly targetType: QueueItem['targetType'];
  readonly targetId: string;
  readonly priority: number;
  readonly state: QueueItem['state'];
  readonly claimedBy?: string;
  readonly signals: readonly string[];
  readonly screeningOutcome: string;
  readonly reportCount: number;
  readonly publicationStatus: string;
  readonly bodyText: string;
  readonly createdAt: number;
};
