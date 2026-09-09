import type { CorroborationType } from './corroboration.ts';
import type { ResolutionReport } from './resolution.ts';
import { tallyReports } from './resolution.ts';

/**
 * Signal aggregation.
 *
 * Every metric is derived from rows, never incremented, so a retry, a replay or
 * a retraction all converge on the same answer. The vocabulary is chosen to stay
 * honest: `evidenceSupportedCount` means someone attached evidence, *not* that
 * Ragers verified the claim. Nothing here is labelled "verified".
 */
export interface SignalInputs {
  /** Published experiences in the cluster. */
  readonly experiences: readonly {
    readonly id: string;
    readonly kind: 'rage' | 'rave';
    readonly actorId: string;
    readonly publishedAt: number;
    readonly locationId?: string;
    readonly hasVoice: boolean;
    readonly hasNarrative: boolean;
    readonly hasEvidence: boolean;
    readonly resolutionStatus: string;
    readonly resolvedAt?: number;
    readonly reopenedCount: number;
  }[];
  /** Active corroborations across those experiences. */
  readonly corroborations: readonly {
    readonly experienceId: string;
    readonly corroboratorId: string;
    readonly type: CorroborationType;
    readonly createdAt: number;
    readonly locationId?: string;
    readonly hasVoice: boolean;
    readonly hasNarrative: boolean;
    readonly hasEvidence: boolean;
  }[];
  readonly reports: readonly ResolutionReport[];
  /** Experiences that received at least one organization response. */
  readonly respondedExperienceIds: readonly string[];
  readonly now: number;
}

export interface SignalMetrics {
  readonly rageCount: number;
  readonly raveCount: number;
  readonly reRageCount: number;
  readonly reRaveCount: number;
  /**
   * People claiming the experience: authors plus corroborators, counted once
   * each. This is the number that matters, and it is why corroborations are
   * unique per user per experience.
   */
  readonly uniqueExperiencers: number;
  readonly contextSupportedCount: number;
  readonly voiceSupportedCount: number;
  readonly evidenceSupportedCount: number;
  readonly responseRate: number;
  readonly resolutionRate: number;
  readonly medianResolutionMs?: number;
  /** Share of experiencers who claim it happened more than once. */
  readonly repeatIncidence: number;
  readonly geographicConcentration: Readonly<Record<string, number>>;
  readonly growthRate: number;
  readonly signalAcceleration: number;
  readonly reopenRate: number;
  readonly computedAt: number;
}

const WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

const rate = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));

export const median = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  const low = sorted[middle - 1] ?? 0;
  const high = sorted[middle] ?? 0;
  return Math.round((low + high) / 2);
};

export const computeSignal = (inputs: SignalInputs): SignalMetrics => {
  const { experiences, corroborations, reports, respondedExperienceIds, now } = inputs;

  const rageCount = experiences.filter((experience) => experience.kind === 'rage').length;
  const raveCount = experiences.filter((experience) => experience.kind === 'rave').length;
  const reRageCount = corroborations.filter((row) => row.type === 're_rage').length;
  const reRaveCount = corroborations.filter((row) => row.type === 're_rave').length;

  // Authors and corroborators are all experiencers, each counted once.
  const experiencers = new Set<string>();
  for (const experience of experiences) experiencers.add(experience.actorId);
  for (const corroboration of corroborations) experiencers.add(corroboration.corroboratorId);

  // Support counts span both claims and corroborations, since a corroborator can
  // attach context, voice or evidence of their own.
  const claims = [
    ...experiences.map((experience) => ({
      hasNarrative: experience.hasNarrative,
      hasVoice: experience.hasVoice,
      hasEvidence: experience.hasEvidence,
      locationId: experience.locationId,
    })),
    ...corroborations.map((corroboration) => ({
      hasNarrative: corroboration.hasNarrative,
      hasVoice: corroboration.hasVoice,
      hasEvidence: corroboration.hasEvidence,
      locationId: corroboration.locationId,
    })),
  ];

  const geographicConcentration: Record<string, number> = {};
  for (const claim of claims) {
    if (claim.locationId === undefined) continue;
    geographicConcentration[claim.locationId] = (geographicConcentration[claim.locationId] ?? 0) + 1;
  }

  // Resolution is measured from what experiencers reported, not from what an
  // organization said.
  const tally = tallyReports(reports);
  const resolutionDurations = experiences
    .filter((experience) => experience.resolvedAt !== undefined)
    .map((experience) => (experience.resolvedAt as number) - experience.publishedAt)
    .filter((duration) => duration >= 0);

  // Growth compares the last window against the one before it, over claims.
  const claimTimes = [
    ...experiences.map((experience) => experience.publishedAt),
    ...corroborations.map((corroboration) => corroboration.createdAt),
  ];
  const recent = claimTimes.filter((at) => at > now - WINDOW_MS).length;
  const previous = claimTimes.filter((at) => at > now - 2 * WINDOW_MS && at <= now - WINDOW_MS).length;
  const growthRate = previous === 0 ? (recent > 0 ? 1 : 0) : Number(((recent - previous) / previous).toFixed(4));

  // Acceleration is the change in growth: the previous window against the one
  // before that, subtracted from the current growth.
  const earlier = claimTimes.filter((at) => at > now - 3 * WINDOW_MS && at <= now - 2 * WINDOW_MS).length;
  const previousGrowth =
    earlier === 0 ? (previous > 0 ? 1 : 0) : Number(((previous - earlier) / earlier).toFixed(4));
  const signalAcceleration = Number((growthRate - previousGrowth).toFixed(4));

  // Repeat incidence: experiencers appearing on more than one claim in the
  // cluster, which is what "it keeps happening to me" looks like in data.
  const perExperiencer = new Map<string, number>();
  for (const experience of experiences) {
    perExperiencer.set(experience.actorId, (perExperiencer.get(experience.actorId) ?? 0) + 1);
  }
  for (const corroboration of corroborations) {
    perExperiencer.set(
      corroboration.corroboratorId,
      (perExperiencer.get(corroboration.corroboratorId) ?? 0) + 1,
    );
  }
  const repeats = [...perExperiencer.values()].filter((count) => count > 1).length;

  const medianResolution = median(resolutionDurations);
  const reopened = experiences.filter((experience) => experience.reopenedCount > 0).length;
  const responded = new Set(respondedExperienceIds);

  return {
    rageCount,
    raveCount,
    reRageCount,
    reRaveCount,
    uniqueExperiencers: experiencers.size,
    contextSupportedCount: claims.filter((claim) => claim.hasNarrative).length,
    voiceSupportedCount: claims.filter((claim) => claim.hasVoice).length,
    evidenceSupportedCount: claims.filter((claim) => claim.hasEvidence).length,
    responseRate: rate(experiences.filter((experience) => responded.has(experience.id)).length, experiences.length),
    // Of those who reported, the share saying it was resolved for them.
    resolutionRate: tally.resolvedShare,
    ...(medianResolution === undefined ? {} : { medianResolutionMs: medianResolution }),
    repeatIncidence: rate(repeats, perExperiencer.size),
    geographicConcentration,
    growthRate,
    signalAcceleration,
    reopenRate: rate(reopened, experiences.length),
    computedAt: now,
  };
};

/** The location carrying the most claims, when there is one. */
export const highestConcentration = (
  concentration: Readonly<Record<string, number>>,
): { locationId: string; count: number } | undefined => {
  const entries = Object.entries(concentration);
  if (entries.length === 0) return undefined;
  const [locationId, count] = entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best));
  return { locationId, count };
};

/**
 * A cluster is worth surfacing as a trend when it has real volume and is
 * growing. Volume alone is history; growth alone is noise.
 */
export const isTrending = (metrics: SignalMetrics, minExperiencers = 3, minGrowth = 0.2): boolean =>
  metrics.uniqueExperiencers >= minExperiencers && metrics.growthRate >= minGrowth;
