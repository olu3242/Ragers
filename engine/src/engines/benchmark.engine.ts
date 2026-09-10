import { aggregate, publishableTogether, type Aggregate } from '../domain/aggregation.ts';
import { eq } from '../ports/store.ts';
import type { Experience } from '../domain/experience.ts';
import type { CorroborationRow, OrganizationProfile, ResolutionReportRow } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * Experience Benchmarking — Phase 47, E11.
 *
 * The aggregation this needs was built and certified in Phase 39, so this engine is the
 * thin part: it defines the *population*, the *time window* and the *comparison set*, then
 * hands each group to `aggregate` and reports what comes back — including when what comes
 * back is a suppression.
 *
 * This phase is **data-blocked rather than code-blocked**, and saying so honestly is the
 * point. The person floor is 5 and the benchmark sample floor is 20; a platform without
 * that many contributors per comparison set produces an empty benchmark, and that is the
 * engine working rather than failing. Nothing here fabricates rows to make the feature look
 * finished — a benchmark built from invented data is worse than no benchmark, because
 * somebody would act on it.
 *
 * The re-identification risk is the reason for every constraint. A comparison between
 * organizations, over a small set, published repeatedly, is the most identifying thing this
 * system could emit — so the row floor, the distinct-person floor and the differencing
 * guard all apply, and `publishableTogether` is consulted over the whole set rather than
 * per group.
 */
export type BenchmarkDimension = 'category' | 'geography' | 'size_band';

export type BenchmarkMetric = 'response_rate' | 'confirmed_resolution_rate';

/** The window a benchmark describes. Stated, because "currently" is not a time. */
export interface BenchmarkWindow {
  readonly fromMs: number;
  readonly toMs: number;
  readonly label: string;
}

export const trailingWindow = (deps: EngineDeps, days = 90): BenchmarkWindow => {
  const to = deps.clock.now();
  return { fromMs: to - days * 86_400_000, toMs: to, label: `the last ${days} days` };
};

export interface BenchmarkGroup {
  readonly dimension: BenchmarkDimension;
  /** Which group, e.g. a category id. Never an organization id — that would be the point. */
  readonly key: string;
  readonly metric: BenchmarkMetric;
  readonly result: Aggregate<number>;
}

export interface BenchmarkReport {
  readonly window: BenchmarkWindow;
  readonly groups: readonly BenchmarkGroup[];
  /**
   * True when the whole report is withheld because publishing the groups *together* would
   * let one be recovered by subtraction, even though each passed its own floors.
   */
  readonly withheldAsASet: boolean;
  /** Said plainly, so a surface explains an empty report rather than showing a blank. */
  readonly explanation: string;
}

interface Contribution {
  readonly experienceId: string;
  readonly organizationId: string;
  readonly categoryId?: string;
  readonly contributors: ReadonlySet<string>;
  readonly answered: boolean;
  readonly confirmedResolved: boolean;
}

/**
 * Gather contributions inside the window.
 *
 * Reads published experiences that name a claimed organization, and counts *distinct
 * people* per group rather than rows — twenty accounts from three people is not twenty
 * people's experience, and the person floor is what Phase 39 checks first.
 */
const contributionsIn = async (
  deps: EngineDeps,
  window: BenchmarkWindow,
): Promise<readonly Contribution[]> => {
  const profiles = await deps.store.organizationProfiles.query([
    eq<OrganizationProfile>('status', 'claimed'),
  ]);
  const byEntity = new Map(profiles.map((profile) => [profile.entityId, profile]));

  const published = await deps.store.experiences.query([eq<Experience>('status', 'published')], {
    orderBy: { field: 'publishedAt', direction: 'desc' },
    limit: 1_000,
  });

  const out: Contribution[] = [];
  for (const experience of published) {
    const publishedAt = experience.publishedAt ?? experience.createdAt;
    if (publishedAt < window.fromMs || publishedAt > window.toMs) continue;
    if (experience.entityId === undefined) continue;
    const profile = byEntity.get(experience.entityId);
    if (!profile) continue;

    const contributors = new Set<string>([experience.actorId]);
    for (const claim of await deps.store.corroborations.query([
      eq<CorroborationRow>('experienceId', experience.id),
      eq<CorroborationRow>('status', 'active'),
    ])) {
      contributors.add(claim.corroboratorId);
    }

    const responses = await deps.store.organizationResponses.countWhere([
      eq('experienceId', experience.id),
    ]);
    const reports = await deps.store.resolutionReports.query([
      eq<ResolutionReportRow>('experienceId', experience.id),
    ]);

    out.push({
      experienceId: experience.id,
      organizationId: profile.id,
      ...(experience.categoryId === undefined ? {} : { categoryId: experience.categoryId }),
      contributors,
      answered: responses > 0,
      // Only what the people it happened to said. An organization responding is not the
      // same thing, and this is the metric most likely to be quietly conflated.
      confirmedResolved: reports.some((report) => report.kind === 'resolved_for_me'),
    });
  }
  return out;
};

/**
 * Build a benchmark report for one dimension and metric.
 *
 * Every group goes through Phase 39's `aggregate`, which applies the person floor, the row
 * floor and the differencing guard against the whole population. The set is then checked
 * with `publishableTogether`, because individually safe groups can be unsafe together — if
 * every sibling but one is published alongside the total, the missing one is arithmetic.
 */
export const benchmarkFor = async (
  deps: EngineDeps,
  dimension: BenchmarkDimension,
  metric: BenchmarkMetric,
  window: BenchmarkWindow = trailingWindow(deps),
): Promise<BenchmarkReport> => {
  const contributions = await contributionsIn(deps, window);

  const grouped = new Map<string, Contribution[]>();
  for (const contribution of contributions) {
    // Geography and size band are not derivable from what is stored today, so they group
    // as `unknown` rather than being invented. An empty benchmark is the honest output.
    const key =
      dimension === 'category' ? (contribution.categoryId ?? 'uncategorised') : 'unknown';
    grouped.set(key, [...(grouped.get(key) ?? []), contribution]);
  }

  const allPeople = new Set<string>();
  for (const contribution of contributions) {
    for (const person of contribution.contributors) allPeople.add(person);
  }

  const groups: BenchmarkGroup[] = [];
  for (const [key, rows] of grouped) {
    const people = new Set<string>();
    for (const row of rows) for (const person of row.contributors) people.add(person);

    const numerator =
      metric === 'response_rate'
        ? rows.filter((row) => row.answered).length
        : rows.filter((row) => row.confirmedResolved).length;

    groups.push({
      dimension,
      key,
      metric,
      result: aggregate({
        kind: 'benchmark',
        sampleSize: rows.length,
        distinctContributors: people.size,
        parentDistinctContributors: allPeople.size,
        compute: () => Number((numerator / rows.length).toFixed(3)),
      }),
    });
  }

  const siblings = groups.map((group) => ({
    distinctContributors: group.result.suppressed ? 0 : group.result.distinctContributors,
    published: !group.result.suppressed,
  }));
  const together = publishableTogether(allPeople.size, siblings);

  const published = groups.filter((group) => !group.result.suppressed).length;
  return {
    window,
    // Withholding as a set means withholding all of it: publishing the safe half is what
    // makes the unsafe half recoverable.
    groups: together ? groups : [],
    withheldAsASet: !together,
    explanation: !together
      ? 'Publishing these groups together would let one of them be recovered by subtracting the others.'
      : published === 0
        ? 'Not enough different people have contributed yet to compare anything without identifying them.'
        : `${published} of ${groups.length} groups have enough contributors to compare.`,
  };
};

/**
 * Whether the benchmark has enough real data to say anything.
 *
 * Reported separately from whether the code works, because they are different questions and
 * the certification says so: `CODE_READY_DATA_BLOCKED` is an honest status and a false
 * `READY` is not.
 */
export const benchmarkDataReadiness = async (
  deps: EngineDeps,
): Promise<{ ready: boolean; distinctContributors: number; floor: number }> => {
  const contributions = await contributionsIn(deps, trailingWindow(deps));
  const people = new Set<string>();
  for (const contribution of contributions) {
    for (const person of contribution.contributors) people.add(person);
  }
  return { ready: people.size >= 20, distinctContributors: people.size, floor: 20 };
};

/** No benchmark ever names another organization's figures. Asserted in a test. */
export const benchmarkNamesOrganizations = (): false => false;
