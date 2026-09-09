import { ok } from '../runtime/result.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { FeedEntry, RankingInput, Trend, TrendWindow } from '../ports/store.ts';
import type { ExperienceKind } from '../domain/types.ts';
import type { EngineDeps } from './deps.ts';

/**
 * P16 Ranking & Trends Engine.
 *
 * Deterministic for fixed inputs, and never load-bearing: if ranking fails the
 * feed falls back to reverse-chronological order, because a feed that does not
 * render is worse than a feed that is merely ordered plainly.
 *
 * The balance adjustment exists to counteract the "complaint board" risk in
 * PRD §10 — if Rages outpace Raves, Raves gain a lift.
 */
export const HALF_LIFE_MS = 24 * 60 * 60 * 1_000;

export const recencyDecay = (ageMs: number): number => {
  if (ageMs <= 0) return 1;
  return Number(Math.pow(0.5, ageMs / HALF_LIFE_MS).toFixed(6));
};

export interface BalanceContext {
  readonly rageCount: number;
  readonly raveCount: number;
  readonly targetRaveShare: number;
}

/**
 * A lift for the under-represented kind, proportional to how far the corpus is
 * from the target balance. Zero when the corpus is already balanced.
 */
export const balanceAdjustment = (kind: ExperienceKind, context: BalanceContext): number => {
  const total = context.rageCount + context.raveCount;
  if (total === 0) return 0;
  const raveShare = context.raveCount / total;
  const gap = context.targetRaveShare - raveShare;
  if (Math.abs(gap) < 0.01) return 0;
  const lift = Number(Math.abs(gap).toFixed(6));
  if (gap > 0) return kind === 'rave' ? lift : 0;
  return kind === 'rage' ? lift : 0;
};

export const computeScore = (parts: {
  engagementScore: number;
  fairnessScore: number;
  recencyDecay: number;
  balanceAdjustment: number;
}): number =>
  Number(
    ((parts.engagementScore * 0.5 + parts.fairnessScore * 0.3 + parts.balanceAdjustment) * parts.recencyDecay).toFixed(
      6,
    ),
  );

export const computeRanking = async (deps: EngineDeps): Promise<readonly RankingInput[]> => {
  const entries = await deps.store.feedEntries.find((row) => !row.suppressed);
  const rageCount = entries.filter((row) => row.kind === 'rage').length;
  const raveCount = entries.filter((row) => row.kind === 'rave').length;
  const now = deps.clock.now();
  const computed: RankingInput[] = [];

  for (const entry of entries) {
    const counters = await deps.store.counters.get(entry.experienceId);
    const engagement =
      (counters?.beenThere ?? 0) + (counters?.same ?? 0) + (counters?.fairPoint ?? 0) + (counters?.replyCount ?? 0);
    const totalVotes = (counters?.fairYes ?? 0) + (counters?.fairNo ?? 0);
    const fairness = totalVotes === 0 ? 0 : (counters?.fairYes ?? 0) / totalVotes;
    const decay = recencyDecay(now - entry.publishedAt);
    const balance = balanceAdjustment(entry.kind, {
      rageCount,
      raveCount,
      targetRaveShare: deps.config.targetRaveShare,
    });

    const input: RankingInput = {
      id: entry.experienceId,
      experienceId: entry.experienceId,
      engagementScore: engagement,
      fairnessScore: Number(fairness.toFixed(6)),
      recencyDecay: decay,
      balanceAdjustment: balance,
      finalScore: computeScore({
        engagementScore: engagement,
        fairnessScore: Number(fairness.toFixed(6)),
        recencyDecay: decay,
        balanceAdjustment: balance,
      }),
      computedAt: now,
    };
    await deps.store.rankingInputs.put(input);
    await deps.store.feedEntries.put({ ...entry, rankScore: input.finalScore });
    computed.push(input);
  }
  return computed;
};

export const createRankingConsumer = (deps: EngineDeps): Consumer => ({
  name: 'ranking.compute',
  events: ['ExperiencePublished', 'ReactionAdded', 'ReactionRemoved', 'FairVoteCast', 'FairVoteChanged', 'ReplyPublished'],
  handle: async () => {
    await computeRanking(deps);
    return ok(undefined);
  },
});

export type FeedOrder = 'ranked' | 'chronological';

export interface RankedFeed {
  readonly entries: readonly FeedEntry[];
  readonly order: FeedOrder;
}

/**
 * Ranked read with a chronological fallback. The feed always renders, even when
 * ranking has not run or has failed.
 */
export const getRankedFeed = async (
  deps: EngineDeps,
  options: { kind?: ExperienceKind; limit?: number } = {},
): Promise<RankedFeed> => {
  const entries = await deps.store.feedEntries.find(
    (row) => !row.suppressed && (options.kind === undefined || row.kind === options.kind),
  );
  const scored = await deps.store.rankingInputs.count();
  const order: FeedOrder = scored === 0 ? 'chronological' : 'ranked';

  const sorted = [...entries].sort((a, b) =>
    order === 'ranked'
      ? b.rankScore - a.rankScore || b.publishedAt - a.publishedAt
      : b.publishedAt - a.publishedAt,
  );
  return { entries: sorted.slice(0, options.limit ?? 25), order };
};

const WINDOW_MS: Readonly<Record<TrendWindow, number>> = {
  '1h': 60 * 60 * 1_000,
  '24h': 24 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60 * 1_000,
};

/** Trends are suppressed below the volume threshold rather than shown thin. */
export const computeTrends = async (deps: EngineDeps, window: TrendWindow): Promise<readonly Trend[]> => {
  const now = deps.clock.now();
  const cutoff = now - WINDOW_MS[window];
  const recent = await deps.store.feedEntries.find((row) => !row.suppressed && row.publishedAt >= cutoff);

  const counts = new Map<string, { volume: number; kind: ExperienceKind }>();
  for (const entry of recent) {
    for (const link of await deps.store.experienceSubjects.find((row) => row.experienceId === entry.experienceId)) {
      const key = `${link.subjectId}:${entry.kind}`;
      const current = counts.get(key) ?? { volume: 0, kind: entry.kind };
      counts.set(key, { volume: current.volume + 1, kind: entry.kind });
    }
  }

  const trends: Trend[] = [];
  for (const [key, value] of counts) {
    if (value.volume < deps.config.trendMinVolume) continue;
    const subjectId = key.slice(0, key.lastIndexOf(':'));
    const trend: Trend = {
      id: `${subjectId}:${window}:${value.kind}`,
      subjectId,
      window,
      kind: value.kind,
      volume: value.volume,
      velocity: Number((value.volume / (WINDOW_MS[window] / (60 * 60 * 1_000))).toFixed(6)),
      state: 'trending',
      computedAt: now,
    };
    await deps.store.trends.put(trend);
    trends.push(trend);
  }
  return trends;
};
