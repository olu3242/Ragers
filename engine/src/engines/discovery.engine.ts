import { eq } from '../ports/store.ts';
import {
  compareRelevance,
  explainRelevance,
  fairnessFor,
  recencyBucketOf,
  type ContextMatch,
  type RelevanceFactors,
} from '../domain/relevance.ts';
import { confirmedValue } from '../domain/normalization.ts';
import { decideEligibility } from '../domain/personalization.ts';
import { isBlockedBetween } from './graph.engine.ts';
import { decideEmergence, reachOf, type Reach } from '../domain/reach.ts';
import { lifecycleOf, type SignalLifecycleInput } from '../domain/signal-lifecycle.ts';
import type {
  ClusterMember,
  CorroborationRow,
  ExperienceSubject,
  FeedEntry,
  SearchDocument,
  SignalSnapshotRow,
} from '../ports/store.ts';
import type { Experience } from '../domain/experience.ts';
import type { ExperienceKind } from '../domain/types.ts';
import type { EngineDeps } from './deps.ts';

/**
 * Discovery, search and relevance — Phases 71, 72 and 73.
 *
 * The reads that make the product usable once there is more content than a person can
 * scroll. Three things shape every one of them:
 *
 * **The read is the authority on status, not the projection.** `feed_entries` and
 * `search_documents` are caches maintained by consumers, and a consumer that has not
 * drained yet is a cache that is wrong. Between the moment a moderator removes something
 * and the moment `feed.suppress` runs, the projection still says published — and a search
 * hit in that window discloses content that has been taken down. Phase 51 already learned
 * this with `relatedTo`, where a relation asserted while both experiences were published
 * outlived one of them being removed. So every read here re-checks the experience row.
 *
 * The cost is one lookup per candidate, and it buys the only guarantee that matters here.
 * The consumers stay: they keep the *candidate set* small, which is what a projection is
 * for. What they no longer do is decide what is safe to show.
 *
 * **Relevance is factors, not a score.** See `src/domain/relevance.ts` for the argument
 * and for what the previous composite got wrong. This module's job is to *build* the
 * factors from rows honestly — in particular, to count corroborating **people** rather
 * than corroboration rows, and to withhold fairness below its floor rather than passing a
 * zero.
 *
 * **A hit carries what a public page already shows, and nothing else.** The search
 * document holds no actor reference and the hit adds none. Asserted structurally over the
 * hit's own keys, so a field added later fails the test rather than shipping.
 */

/** How many candidates a single read will consider before ranking. */
export const DISCOVERY_CANDIDATE_LIMIT = 500;

/** What a discovery read is asking for. Every field is a *context*, never an internal attribute. */
export interface DiscoveryQuery {
  readonly kind?: ExperienceKind;
  readonly category?: string;
  /** The organization or product the experience was about. */
  readonly entityId?: string;
  /** A subject term — what came up in it. */
  readonly subjectId?: string;
  readonly limit?: number;
  /**
   * Who is asking, when somebody is.
   *
   * Phase 86's addition, and it is the eligibility stage rather than a filter: a viewer-less
   * read can check whether an experience is *published* and cannot check whether **this**
   * person is permitted to see it. Absent for the public page, which is correct — a guest has
   * blocked nobody — and present for every signed-in read.
   *
   * Deliberately not in `FORBIDDEN_DISCOVERY_FILTERS` and deliberately not a filter at all:
   * it narrows nothing by preference, it applies a floor. The difference is the whole of
   * `relevant != permitted`.
   */
  readonly viewerId?: string;
}

/**
 * Filters a discovery query may never accept, each with its reason.
 *
 * Not merely absent from `DiscoveryQuery` — named, so the reason survives and so a test can
 * assert that none of them appears as a key. An internal attribute as a discovery *filter*
 * would leak it: "show me the low-trust accounts" reveals the trust score one query at a
 * time even though the score itself is never rendered.
 */
export const FORBIDDEN_DISCOVERY_FILTERS: Readonly<Record<string, string>> = {
  trustBand: 'Trust is internal. A filter on it discloses it one query at a time.',
  severityBand:
    'Severity is what people asserted it cost them. Browsing by it invites treating other people’s losses as a category.',
  screeningOutcome: 'A screening outcome is a moderation input, not a public facet.',
  rankScore: 'There is no composite score to filter on, which is the point of Phase 73.',
  actorId:
    'Discovery is by what happened, never by who. Browsing one person’s experiences is a profile of them.',
  reporterId: 'Who reported something is never a public facet.',
};

export interface DiscoveryResult {
  readonly experienceId: string;
  readonly kind: ExperienceKind;
  readonly category: string;
  readonly excerpt: string;
  readonly identityLabel: string;
  readonly hasVoice: boolean;
  readonly publishedAt: number;
  /** The factors this ordering used, so a surface can show them. */
  readonly factors: RelevanceFactors;
  /** Why this is above the next one. Absent on the last result. */
  readonly reason?: string;
}

/**
 * Whether an experience is still safe to surface, read from the row itself.
 *
 * `published` and nothing else. A draft, a hidden experience, one under review, one removed
 * and one deleted are all absent.
 *
 * **Visibility is deliberately not checked here, and the reason is worth stating** because
 * the first version of this did check it. `Visibility` is `public | alias | anonymous` —
 * all three are publicly readable, and the value governs *attribution* rather than reach.
 * An anonymous experience is meant to be discoverable; that is the point of offering
 * anonymity rather than a private mode. Filtering on it would have quietly removed exactly
 * the accounts somebody felt unsafe attaching their name to, which is the opposite of what
 * the setting is for. Identity protection happens in the projection, which carries a label
 * and never an actor id.
 */
export const isDiscoverable = (experience: Experience | undefined): experience is Experience =>
  experience !== undefined && experience.status === 'published';

/**
 * The eligibility stage — Phase 86.
 *
 * `isDiscoverable` answers "may anybody read this". This answers "may **this person** read
 * this", which is a different question and the one that was never asked. It runs before the
 * context match and before ranking, so nothing a viewer may not see reaches personalization or
 * an ordering position.
 *
 * **What writing this found.** `isBlockedBetween` carries the comment "Consulted on every read
 * path" and was consulted on exactly one — notifications. So a blocked author's accounts were
 * served straight into the blocker's personalized feed. Not reachable by an anonymous visitor,
 * because a guest has blocked nobody; reachable by every signed-in reader who had ever used
 * the feature.
 *
 * A guest passes trivially, which is correct rather than a shortcut: eligibility for somebody
 * with no identity is exactly `isDiscoverable`, and pretending otherwise would mean inventing a
 * viewer to check a floor against.
 */
export const eligibleForViewer = async (
  deps: EngineDeps,
  viewerId: string | undefined,
  experience: Experience,
): Promise<boolean> => {
  const eligibility = decideEligibility({
    published: experience.status === 'published',
    viewerIsAuthor: viewerId !== undefined && viewerId === experience.actorId,
    blockedEitherWay:
      viewerId === undefined
        ? false
        : await isBlockedBetween(deps, viewerId, experience.actorId),
  });
  return eligibility.permitted;
};

/**
 * Build the relevance factors for one experience, from rows.
 *
 * The corroboration count is **distinct people**, taken from the corroboration rows rather
 * than from `counters.corroboratorCount`. The counter is maintained by a consumer and is a
 * count of rows; the number that belongs in a ranking is a count of people, and six
 * accounts from one person is one person. That distinction is the entire trust primitive.
 */
export const factorsFor = async (
  deps: EngineDeps,
  experience: Experience,
  contextMatch: ContextMatch,
): Promise<RelevanceFactors> => {
  const counters = await deps.store.counters.get(experience.id);
  const corroborations = await deps.store.corroborations.query([
    eq<CorroborationRow>('experienceId', experience.id),
    eq<CorroborationRow>('status', 'active'),
  ]);
  const people = new Set(corroborations.map((row) => row.corroboratorId));

  // Replies and reactions only. Corroborations are the factor above and are not summed in
  // here — the whole repair of Phase 73 is that these two never meet in one number.
  const engagement = (counters?.same ?? 0) + (counters?.fairPoint ?? 0) + (counters?.replyCount ?? 0);
  const fairness = fairnessFor(counters?.fairYes ?? 0, counters?.fairNo ?? 0);
  const publishedAt = experience.publishedAt ?? experience.createdAt;

  return {
    experienceId: experience.id,
    kind: experience.kind,
    contextMatch,
    corroboratingPeople: people.size,
    recency: recencyBucketOf(publishedAt, deps.clock.now()),
    ...(fairness === undefined ? {} : { fairness }),
    engagement,
    publishedAt,
  };
};

/**
 * How well this experience answers the question that was asked.
 *
 * `direct` when the thing asked for is what the experience is about. `adjacent` when it
 * shares the category but not the specific subject — near enough to be worth showing, not
 * near enough to outrank a direct answer. `none` when only a free-text term matched.
 */
const contextMatchFor = async (
  deps: EngineDeps,
  experience: Experience,
  query: DiscoveryQuery,
): Promise<ContextMatch> => {
  if (query.entityId !== undefined) {
    // **Confirmed structure only**, through the same `confirmedValue` path the matcher
    // uses. An extracted-but-unconfirmed entity is *unknown*, not agreement — so browsing
    // "what happens at this company" never surfaces an experience the machine guessed was
    // about them and the author never said was.
    const metadata = await deps.store.experienceMetadata.get(experience.id);
    const entityId = confirmedValue(metadata?.confirmed ?? {}, 'entity');
    if (entityId === query.entityId) return 'direct';
    if (query.category !== undefined && experience.category === query.category) return 'adjacent';
    return 'none';
  }
  if (query.subjectId !== undefined) {
    const links = await deps.store.experienceSubjects.query([
      eq<ExperienceSubject>('experienceId', experience.id),
    ]);
    if (links.some((link) => link.subjectId === query.subjectId)) return 'direct';
    return 'none';
  }
  if (query.category !== undefined) {
    return experience.category === query.category ? 'direct' : 'none';
  }
  // No context asked for, so nothing is more on-topic than anything else. Every candidate
  // is equal here and the ordering falls through to corroboration, which is the right
  // default for a bare browse.
  return 'adjacent';
};

/**
 * Phase 71 — discover published experiences by what they were about.
 *
 * Candidates come from the feed projection (cheap, indexed, and small) and every one is
 * re-checked against its experience row before it can appear.
 */
export const discover = async (
  deps: EngineDeps,
  query: DiscoveryQuery = {},
): Promise<readonly DiscoveryResult[]> => {
  const entries = (
    await deps.store.feedEntries.query([
      { field: 'suppressed', op: 'isFalse' },
      ...(query.kind === undefined ? [] : [eq<FeedEntry>('kind', query.kind)]),
    ])
  ).slice(0, DISCOVERY_CANDIDATE_LIMIT);

  const candidates: { factors: RelevanceFactors; entry: FeedEntry }[] = [];
  for (const entry of entries) {
    // The re-check. A suppressed projection is already excluded above; this catches the
    // window where the row has changed and the consumer has not run.
    const experience = await deps.store.experiences.get(entry.experienceId);
    if (!isDiscoverable(experience)) continue;
    // The eligibility stage. Runs before the context match and before ranking, so nothing a
    // viewer may not see can reach personalization or an ordering position.
    if (!(await eligibleForViewer(deps, query.viewerId, experience))) continue;
    const match = await contextMatchFor(deps, experience, query);
    if (match === 'none') continue;
    candidates.push({ entry, factors: await factorsFor(deps, experience, match) });
  }

  const ranked = candidates.sort((left, right) => compareRelevance(left.factors, right.factors));
  const limited = ranked.slice(0, query.limit ?? 25);

  return limited.map(({ entry, factors }, index) => {
    const next = limited[index + 1];
    return {
      experienceId: entry.experienceId,
      kind: entry.kind,
      category: entry.category,
      excerpt: entry.excerpt,
      identityLabel: entry.identityLabel,
      hasVoice: entry.hasVoice,
      publishedAt: entry.publishedAt,
      factors,
      // Every result but the last says why it is above the one after it. A ranking that
      // cannot answer that is the thing this phase exists to replace.
      ...(next === undefined ? {} : { reason: explainRelevance(factors, next.factors) }),
    };
  });
};

export interface ContextualSearchQuery extends DiscoveryQuery {
  readonly text?: string;
  readonly voiceOnly?: boolean;
}

/** A search hit. Deliberately the same shape a public page already shows. */
export interface ContextualHit {
  readonly experienceId: string;
  readonly kind: ExperienceKind;
  readonly category: string;
  readonly identityLabel: string;
  readonly hasVoice: boolean;
  readonly excerpt: string;
  readonly publishedAt: number;
  readonly factors: RelevanceFactors;
  readonly reason?: string;
}

/**
 * Phase 72 — search the safe searchable fields, ranked by the same factors.
 *
 * The index is the candidate source and the experience row is the authority. The purge
 * consumer covers all four removal events, so the index is correct *eventually*; this read
 * is correct *now*, which is the difference that matters when the content in question has
 * just been taken down.
 */
export const searchContextually = async (
  deps: EngineDeps,
  query: ContextualSearchQuery,
): Promise<readonly ContextualHit[]> => {
  const needle = query.text?.trim().toLowerCase();
  const criteria = [
    ...(query.kind === undefined ? [] : [eq<SearchDocument>('kind', query.kind)]),
    ...(query.category === undefined ? [] : [eq<SearchDocument>('category', query.category)]),
    ...(query.voiceOnly === true ? [{ field: 'hasVoice' as const, op: 'isTrue' as const }] : []),
  ];
  const documents = (await deps.store.searchDocuments.query(criteria)).slice(0, DISCOVERY_CANDIDATE_LIMIT);

  const matched =
    needle && needle.length > 0
      ? documents.filter((row) =>
          `${row.searchableText} ${row.subjectTerms.join(' ')}`.toLowerCase().includes(needle),
        )
      : documents;

  const candidates: { document: SearchDocument; factors: RelevanceFactors }[] = [];
  for (const document of matched) {
    const experience = await deps.store.experiences.get(document.experienceId);
    if (!isDiscoverable(experience)) continue;
    // Search runs the same eligibility stage, for the same reason: a hit is a read. A block
    // honoured in the feed and not in search is a block that fails the moment somebody types.
    if (!(await eligibleForViewer(deps, query.viewerId, experience))) continue;
    const match = await contextMatchFor(deps, experience, query);
    if (match === 'none') continue;
    candidates.push({ document, factors: await factorsFor(deps, experience, match) });
  }

  const ranked = candidates
    .sort((left, right) => compareRelevance(left.factors, right.factors))
    .slice(0, query.limit ?? 25);

  return ranked.map(({ document, factors }, index) => {
    const next = ranked[index + 1];
    return {
      experienceId: document.experienceId,
      kind: document.kind,
      category: document.category,
      identityLabel: document.identityLabel,
      hasVoice: document.hasVoice,
      excerpt: document.searchableText.slice(0, 160),
      publishedAt: document.publishedAt,
      factors,
      ...(next === undefined ? {} : { reason: explainRelevance(factors, next.factors) }),
    };
  });
};

/**
 * Related experiences, by shared subject.
 *
 * Kept here rather than in the relationship engine because that one answers a different
 * question — Phase 51's graph is over *asserted* relations, and this is over what two
 * experiences happen to be about. Both re-check status, for the reason Phase 51 found.
 */
export const relatedByContext = async (
  deps: EngineDeps,
  experienceId: string,
  limit = 10,
): Promise<readonly DiscoveryResult[]> => {
  const links = await deps.store.experienceSubjects.query([
    eq<ExperienceSubject>('experienceId', experienceId),
  ]);
  const subjectIds = new Set(links.map((link) => link.subjectId));
  if (subjectIds.size === 0) return [];

  const seen = new Set<string>([experienceId]);
  const results: DiscoveryResult[] = [];
  for (const subjectId of subjectIds) {
    for (const result of await discover(deps, { subjectId, limit })) {
      if (seen.has(result.experienceId)) continue;
      seen.add(result.experienceId);
      results.push(result);
    }
  }
  return results.slice(0, limit);
};

/**
 * Whether a signal is current enough to be amplified.
 *
 * Derived through `lifecycleOf` rather than reimplemented, because "is this pattern still
 * happening" already has one answer in this codebase and a second one would drift. A
 * stabilising pattern is still current; an expired or resolved one is not, and amplifying
 * either as though it were live would present "this used to happen" as "this happens".
 */
export const signalIsCurrent = (input: SignalLifecycleInput): boolean => {
  const state = lifecycleOf(input).state;
  return state === 'emerging' || state === 'active' || state === 'stabilizing';
};

// ── Phases 76 and 77: emergence and reach, over rows ─────────────────────

/**
 * Reach for one experience, counted in people.
 *
 * Built from the corroboration rows rather than from `counters.corroboratorCount`, for the
 * same reason `factorsFor` is: the counter counts rows and reach counts people. The share
 * count travels beside reach rather than inside it, so a reader can see that something
 * travelled without being able to mistake that for how many people it happened to.
 */
export const reachFor = async (deps: EngineDeps, experienceId: string): Promise<Reach> => {
  const experience = await deps.store.experiences.get(experienceId);
  if (!experience) return { people: 0, selfOrDuplicate: 0, amplification: 0 };
  const corroborations = await deps.store.corroborations.query([
    eq<CorroborationRow>('experienceId', experienceId),
    eq<CorroborationRow>('status', 'active'),
  ]);
  const counters = await deps.store.counters.get(experienceId);
  return reachOf({
    authorActorId: experience.actorId,
    corroboratorActorIds: corroborations.map((row) => row.corroboratorId),
    shareCount: counters?.shareCount ?? 0,
    reactionCount: (counters?.same ?? 0) + (counters?.fairPoint ?? 0),
  });
};

export interface EmergingPattern {
  readonly clusterId: string;
  readonly headline: string;
  /** Always the word `emerging`. Never a synonym that could read as established. */
  readonly label: 'emerging';
  readonly people: number;
  readonly experiences: number;
}

/**
 * Phase 76 — patterns that may be surfaced as emerging, and only those.
 *
 * Every candidate goes through `decideEmergence`, so a pattern below either floor or over a
 * stale signal is absent rather than caveated. The refusals are not returned: a list of
 * "patterns we decided not to show you" is a list of patterns, and a reader would treat it
 * as one.
 */
export const emergingPatterns = async (
  deps: EngineDeps,
  limit = 10,
): Promise<readonly EmergingPattern[]> => {
  const clusters = (await deps.store.clusters.query([])).slice(0, DISCOVERY_CANDIDATE_LIMIT);
  const surfaced: EmergingPattern[] = [];

  for (const cluster of clusters) {
    const members = await deps.store.clusterMembers.query([
      eq<ClusterMember>('clusterId', cluster.id),
    ]);

    // Distinct *people* across the cluster's experiences, and distinct *published*
    // experiences — a cluster whose members have been removed is not a live pattern, and the
    // status re-check applies here for the same reason it does everywhere else in this file.
    const people = new Set<string>();
    let experiences = 0;
    for (const member of members) {
      const experience = await deps.store.experiences.get(member.experienceId);
      if (!isDiscoverable(experience)) continue;
      experiences += 1;
      people.add(experience.actorId);
      for (const row of await deps.store.corroborations.query([
        eq<CorroborationRow>('experienceId', experience.id),
        eq<CorroborationRow>('status', 'active'),
      ])) {
        people.add(row.corroboratorId);
      }
    }

    const snapshot = await deps.store.signalSnapshots.queryOne([
      eq<SignalSnapshotRow>('clusterId', cluster.id),
    ]);
    const verdict = decideEmergence({
      distinctPeople: people.size,
      distinctExperiences: experiences,
      signalCurrent: signalIsCurrent({
        firstContributionAt: cluster.createdAt,
        lastContributionAt: snapshot?.computedAt ?? cluster.updatedAt,
        uniqueExperiencers: people.size,
        recentContributions: experiences,
        resolvedShare: 0,
        outcomeReporters: 0,
        now: deps.clock.now(),
      }),
    });
    if (!verdict.surfaced) continue;

    surfaced.push({
      clusterId: cluster.id,
      headline: cluster.headline,
      label: verdict.label,
      people: verdict.people,
      experiences,
    });
  }

  // Most people first. Not a score — one named factor, and the only one that means anything
  // for an emerging pattern.
  return surfaced.sort((left, right) => right.people - left.people).slice(0, limit);
};
