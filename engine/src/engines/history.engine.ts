import { eq } from '../ports/store.ts';
import {
  changesAcross,
  seriesOf,
  type Change,
  type HistorySeries,
} from '../domain/history.ts';
import type { Experience } from '../domain/experience.ts';
import type { OrganizationResponse } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * Organization Pattern History — E11, with E8, E9 and E10 in support. Phase 53.
 *
 * Derived on read from the same rows Phase 36's snapshot uses, cut into periods. No
 * new table: a stored series is a stored copy of arithmetic, and the copy is what
 * goes stale.
 *
 * The floors and the differencing guard live in `src/domain/history.ts`; this engine's
 * job is to count honestly — in particular to count *distinct people*, not accounts,
 * per period, since a series built on account counts is exactly what the person floor
 * exists to refuse.
 */

/** A month is the shortest period over which a resolution rate means anything. */
export const DEFAULT_PERIOD_MS = 30 * 86_400_000;
export const DEFAULT_PERIODS = 6;

export interface PatternHistory {
  readonly organizationId: string;
  readonly volume: HistorySeries<number>;
  readonly responseRate: HistorySeries<number>;
  readonly resolutionRate: HistorySeries<number>;
  /** Consecutive changes, per series, each independently withheld or stated. */
  readonly volumeChanges: readonly Change[];
  readonly responseRateChanges: readonly Change[];
  readonly resolutionRateChanges: readonly Change[];
}

const rate = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));

export const patternHistoryFor = async (
  deps: EngineDeps,
  organizationId: string,
  options: { readonly periodMs?: number; readonly periods?: number } = {},
): Promise<PatternHistory | undefined> => {
  const profile = await deps.store.organizationProfiles.get(organizationId);
  if (!profile) return undefined;

  const periodMs = Math.max(86_400_000, options.periodMs ?? DEFAULT_PERIOD_MS);
  const periods = Math.max(2, Math.min(options.periods ?? DEFAULT_PERIODS, 24));
  const now = deps.clock.now();

  const experiences = await deps.store.experiences.query([
    eq<Experience>('entityId', profile.entityId),
    eq<Experience>('status', 'published'),
  ]);

  // Bucket by the period an experience was published into, and collect *people*
  // rather than experiences, so the person floor has something real to measure.
  interface Bucket {
    readonly start: number;
    readonly end: number;
    total: number;
    answered: number;
    resolved: number;
    readonly contributors: Set<string>;
  }
  const buckets: Bucket[] = [];
  for (let index = periods - 1; index >= 0; index -= 1) {
    // Half-open `[start, end)` so no experience lands in two periods — except the
    // newest, whose end is *now* and must include this instant. Without that the
    // present moment falls into no bucket at all, and a series computed from a fixed
    // clock reports every period empty while looking entirely reasonable.
    const end = now - index * periodMs;
    buckets.push({
      start: end - periodMs,
      end: index === 0 ? end + 1 : end,
      total: 0,
      answered: 0,
      resolved: 0,
      contributors: new Set(),
    });
  }

  for (const experience of experiences) {
    const at = experience.publishedAt ?? experience.createdAt;
    const bucket = buckets.find((candidate) => at >= candidate.start && at < candidate.end);
    if (!bucket) continue;

    bucket.total += 1;
    bucket.contributors.add(experience.actorId);
    for (const row of await deps.store.corroborations.query([
      eq('experienceId', experience.id),
      eq('status', 'active'),
    ])) {
      bucket.contributors.add(row.corroboratorId);
    }

    const responses = await deps.store.organizationResponses.countWhere([
      eq<OrganizationResponse>('experienceId', experience.id),
    ]);
    if (responses > 0) bucket.answered += 1;

    // Confirmed by the people it happened to. An organization answering does not
    // move this, which is the same rule Phase 36 holds.
    if (experience.resolutionStatus === 'resolved') bucket.resolved += 1;
  }

  /** People new to this period. The input the time-differencing guard runs on. */
  const newContributorsAt = (index: number): number => {
    const current = buckets[index];
    if (!current) return 0;
    const previous = buckets[index - 1];
    if (!previous) return current.contributors.size;
    return [...current.contributors].filter((actorId) => !previous.contributors.has(actorId)).length;
  };

  const pointsFor = (compute: (bucket: Bucket) => number) =>
    buckets.map((bucket, index) => ({
      periodStart: bucket.start,
      periodEnd: bucket.end,
      sampleSize: bucket.total,
      distinctContributors: bucket.contributors.size,
      newContributors: newContributorsAt(index),
      compute: () => compute(bucket),
    }));

  const volume = seriesOf(organizationId, 'responsiveness', pointsFor((bucket) => bucket.total));
  const responseRate = seriesOf(
    organizationId,
    'responsiveness',
    pointsFor((bucket) => rate(bucket.answered, bucket.total)),
  );
  const resolutionRate = seriesOf(
    organizationId,
    'resolution_rate',
    pointsFor((bucket) => rate(bucket.resolved, bucket.total)),
  );

  return {
    organizationId,
    volume,
    responseRate,
    resolutionRate,
    // Volume rising is not an improvement for the organization *or* a worsening of
    // its conduct — more people reporting can mean either — so it is measured with
    // `higherIsBetter: false` and read as direction of movement, not as a verdict.
    volumeChanges: changesAcross(volume, { higherIsBetter: false }),
    responseRateChanges: changesAcross(responseRate, { higherIsBetter: true }),
    resolutionRateChanges: changesAcross(resolutionRate, { higherIsBetter: true }),
  };
};
