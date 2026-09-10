import { ok } from '../runtime/result.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import { eq } from '../ports/store.ts';
import type { FeedEntry, RankingInput, Trend, TrendWindow } from '../ports/store.ts';
import type { ExperienceKind } from '../domain/types.ts';
import { discover } from './discovery.engine.ts';
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
 *
 * ## Phase 73 — `finalScore` no longer decides anything
 *
 * `computeScore` is retained, still computed, still stored, and **no longer read by any
 * ordering.** It is kept rather than deleted for two reasons: the `ranking_inputs` and
 * `feed_entries.rank_score` columns exist and the additive-migration rule forbids dropping
 * them, and the four stored factors are genuinely useful as recorded inputs even though
 * their weighted sum was not.
 *
 * Why the sum had to go — the argument is in `src/domain/relevance.ts` and the summary is
 * that it broke three rules this codebase states elsewhere. It added corroborations
 * (`reRageCount`, somebody saying *this happened to me too*) to reactions and replies, so
 * `corroboration != popularity` and `engagement != truth` were both violated by one `+`, in
 * the one place the result decided what everybody saw. It read "nobody has voted" as
 * `fairness = 0`, giving every new experience the same contribution as a unanimously-unfair
 * one at a 0.3 weight. And it was one opaque number, so nothing could tell an author or an
 * operator why one account sat above another.
 *
 * `getRankedFeed` now delegates to `discover`, which orders by named factors in stated
 * precedence and returns the reason each pair was ordered that way. Leaving both orderings
 * live would have meant two answers to "what order is this in", with the opaque one already
 * wired to the home page.
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

/**
 * The Phase 16 composite. **Superseded — nothing orders by this.**
 *
 * Retained because the columns it fills cannot be dropped and because a recorded input is
 * worth keeping even when its weighting was wrong. `rankingCompositeIsAuthoritative()`
 * returns false so a future edit that re-wires an ordering to it has a test to argue with.
 */
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
  const entries = await deps.store.feedEntries.query([{ field: 'suppressed', op: 'isFalse' }]);
  const rageCount = entries.filter((row) => row.kind === 'rage').length;
  const raveCount = entries.filter((row) => row.kind === 'rave').length;
  const now = deps.clock.now();
  const computed: RankingInput[] = [];

  for (const entry of entries) {
    const counters = await deps.store.counters.get(entry.experienceId);
    // Corroborations replace the retired been_there term. Shares are deliberately
    // absent: amplification is not evidence that anything happened.
    const engagement =
      (counters?.reRageCount ?? 0) +
      (counters?.reRaveCount ?? 0) +
      (counters?.same ?? 0) +
      (counters?.fairPoint ?? 0) +
      (counters?.replyCount ?? 0);
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
 *
 * **Phase 73: the ordering is now `discover`'s.** The entries are looked up by the ids
 * discovery returned, so this keeps its `FeedEntry[]` signature for the two callers that
 * have it while the *order* comes from named factors with a stated reason. The
 * chronological fallback stays and is now reached when discovery returns nothing at all —
 * a feed that does not render is still worse than one ordered plainly.
 */
export const getRankedFeed = async (
  deps: EngineDeps,
  options: { kind?: ExperienceKind; limit?: number } = {},
): Promise<RankedFeed> => {
  const discovered = await discover(deps, {
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    limit: options.limit ?? 25,
  });

  if (discovered.length > 0) {
    const entries: FeedEntry[] = [];
    for (const result of discovered) {
      const entry = await deps.store.feedEntries.get(result.experienceId);
      if (entry) entries.push(entry);
    }
    return { entries, order: 'ranked' };
  }

  // Nothing ranked — either there is nothing published, or every candidate failed the
  // read-time status check. Fall back rather than returning an empty page on an ordering
  // failure, which is the original rule and still the right one.
  const entries = await deps.store.feedEntries.query([
    { field: 'suppressed', op: 'isFalse' },
    ...(options.kind === undefined ? [] : [eq<FeedEntry>('kind', options.kind)]),
  ]);
  const sorted = [...entries].sort((a, b) => b.publishedAt - a.publishedAt);
  return { entries: sorted.slice(0, options.limit ?? 25), order: 'chronological' };
};

/** Nothing orders by the composite. Asserted rather than trusted to review. */
export const rankingCompositeIsAuthoritative = (): false => false;

const WINDOW_MS: Readonly<Record<TrendWindow, number>> = {
  '1h': 60 * 60 * 1_000,
  '24h': 24 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60 * 1_000,
};

/** Trends are suppressed below the volume threshold rather than shown thin. */
export const computeTrends = async (deps: EngineDeps, window: TrendWindow): Promise<readonly Trend[]> => {
  const now = deps.clock.now();
  const cutoff = now - WINDOW_MS[window];
  const recent = await deps.store.feedEntries.query([
    { field: 'suppressed', op: 'isFalse' },
    { field: 'publishedAt', op: 'gte', value: cutoff },
  ]);

  const counts = new Map<string, { volume: number; kind: ExperienceKind }>();
  for (const entry of recent) {
    for (const link of await deps.store.experienceSubjects.query([eq('experienceId', entry.experienceId)])) {
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
