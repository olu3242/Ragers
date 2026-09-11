import { ok } from '../runtime/result.ts';
import {
  clusterKeyOf,
  isClusterable,
  matchExperiences,
  type ClusterKey,
  type MatchCandidate,
  type MatchResult,
} from '../domain/matching.ts';
import { confirmedValue, extractTerms } from '../domain/normalization.ts';
import { eq } from '../ports/store.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { Criterion, ClusterMember, ClusterRow, ExperienceMetadata } from '../ports/store.ts';
import type { Experience } from '../domain/experience.ts';
import type { EngineDeps } from './deps.ts';

/**
 * Matching and Cluster Engine.
 *
 * Two rules shape this file.
 *
 * **Confirmed fields only.** The candidate is built from `confirmed` metadata. An
 * unconfirmed extraction is absent, which the matcher scores as *unknown* rather
 * than as agreement — so a misread entity name cannot pull an experience into a
 * cluster about a company nobody mentioned.
 *
 * **Deterministic agreement decides, not similarity.** `matchExperiences` gates
 * on entity and issue before the score is consulted at all. Text similarity can
 * only ever weaken or refine a relationship the identifiers already permit; it
 * can never create one.
 */

/** Build a match candidate from an experience and its *confirmed* metadata. */
export const candidateFor = (
  experience: Experience,
  metadata: ExperienceMetadata | undefined,
  terms: readonly string[],
): MatchCandidate => {
  const confirmed = metadata?.confirmed ?? {};
  // Prefer the confirmed value; fall back to the column, which is only ever
  // written from a confirmation or a migration — never from extraction.
  const entityId = confirmedValue(confirmed, 'entity') ?? experience.entityId;
  const categoryId = confirmedValue(confirmed, 'category') ?? experience.categoryId;
  const issueTypeId = confirmedValue(confirmed, 'issueType') ?? experience.issueTypeId;
  const locationId = confirmedValue(confirmed, 'location') ?? experience.locationId;
  const occurredRaw = confirmedValue(confirmed, 'occurredAt');
  const occurredAt = occurredRaw === undefined ? experience.occurredAt : Number(occurredRaw);

  return {
    ...(entityId === undefined ? {} : { entityId }),
    ...(categoryId === undefined ? {} : { categoryId }),
    ...(issueTypeId === undefined ? {} : { issueTypeId }),
    ...(locationId === undefined ? {} : { locationId }),
    ...(occurredAt === undefined || !Number.isFinite(occurredAt) ? {} : { occurredAt }),
    terms,
  };
};

const termsFor = async (deps: EngineDeps, experience: Experience): Promise<readonly string[]> => {
  const transcript = experience.mediaAssetId
    ? await deps.store.transcripts.queryOne([eq('mediaAssetId', experience.mediaAssetId)])
    : undefined;
  // Redacted text only. `rawText` is unreadable on every path by design.
  return extractTerms([experience.bodyText, transcript?.redactedText ?? ''].join(' '));
};

const headlineFor = async (deps: EngineDeps, key: ClusterKey): Promise<string> => {
  const entity = key.entityId ? await deps.store.entities.get(key.entityId) : undefined;
  const issue = key.issueTypeId ? await deps.store.issueTypes.get(key.issueTypeId) : undefined;
  const category = key.categoryId ? await deps.store.categories.get(key.categoryId) : undefined;
  const subject = entity?.name ?? category?.name ?? 'Repeated experiences';
  const about = issue?.name ?? category?.name;
  // Plainly descriptive. A cluster headline is shown to people, so it is never
  // an accusation and never a summary of the worst account in it.
  return about === undefined ? subject : `${subject} — ${about}`;
};

/** The cluster for a key, created if it does not exist. */
export const clusterFor = async (deps: EngineDeps, key: ClusterKey): Promise<ClusterRow | undefined> => {
  if (!isClusterable(key)) return undefined;

  const criteria: Criterion<ClusterRow>[] = [eq<ClusterRow>('kind', key.kind)];
  criteria.push({ field: 'entityId', op: 'eq', value: key.entityId ?? null });
  criteria.push({ field: 'categoryId', op: 'eq', value: key.categoryId ?? null });
  criteria.push({ field: 'issueTypeId', op: 'eq', value: key.issueTypeId ?? null });

  const existing = await deps.store.clusters.queryOne(criteria);
  if (existing) return existing;

  const now = deps.clock.now();
  const created: ClusterRow = {
    // Deterministic id, so two concurrent publications converge on one cluster
    // instead of racing to create two for the same pattern.
    id: `clu_${key.kind}_${key.entityId ?? 'none'}_${key.categoryId ?? 'none'}_${key.issueTypeId ?? 'none'}`,
    kind: key.kind,
    ...(key.entityId === undefined ? {} : { entityId: key.entityId }),
    ...(key.categoryId === undefined ? {} : { categoryId: key.categoryId }),
    ...(key.issueTypeId === undefined ? {} : { issueTypeId: key.issueTypeId }),
    headline: await headlineFor(deps, key),
    totalExperiences: 0,
    corroborations: 0,
    uniqueExperiencers: 0,
    createdAt: now,
    updatedAt: now,
  };
  // Insert-if-absent: the loser of the race reads the winner's row.
  const won = await deps.store.clusters.compareAndSet(created, 'absent');
  return won ? created : ((await deps.store.clusters.get(created.id)) ?? created);
};

/**
 * Compare one experience against the others already in its cluster.
 *
 * The comparison is what justifies membership: an experience joins because the
 * identifiers agree, and the recorded relationship and factors say exactly how
 * much they agree — so a person reviewing a cluster can check the reasoning.
 */
export const compareWithinCluster = async (
  deps: EngineDeps,
  experience: Experience,
  cluster: ClusterRow,
): Promise<MatchResult | undefined> => {
  const members = await deps.store.clusterMembers.query([eq<ClusterMember>('clusterId', cluster.id)]);
  const others = members.filter((member) => member.experienceId !== experience.id);
  if (others.length === 0) return undefined;

  const metadata = await deps.store.experienceMetadata.get(experience.id);
  const mine = candidateFor(experience, metadata, await termsFor(deps, experience));

  let best: MatchResult | undefined;
  for (const member of others) {
    const other = await deps.store.experiences.get(member.experienceId);
    if (!other || other.status !== 'published') continue;
    const otherMeta = await deps.store.experienceMetadata.get(other.id);
    const result = matchExperiences(mine, candidateFor(other, otherMeta, await termsFor(deps, other)));
    if (best === undefined || result.score > best.score) best = result;
  }
  return best;
};

/**
 * Cluster assignment, as a consumer.
 *
 * Runs on publication and again on confirmation, because confirming an entity is
 * exactly the moment an experience becomes clusterable.
 */
export const createClusterAssignmentConsumer = (deps: EngineDeps): Consumer => ({
  name: 'matching.assign_cluster',
  events: ['ExperiencePublished', 'ExperienceNormalizationConfirmed', 'TranscriptRedacted'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    if (!experienceId) return ok(undefined);
    const experience = await deps.store.experiences.get(experienceId);
    if (!experience || experience.status !== 'published') return ok(undefined);

    const metadata = await deps.store.experienceMetadata.get(experienceId);
    const candidate = candidateFor(experience, metadata, await termsFor(deps, experience));
    const key = clusterKeyOf(experience.kind, candidate);

    if (!isClusterable(key)) {
      deps.metrics.increment('matching.not_clusterable');
      return ok(undefined);
    }

    const cluster = await clusterFor(deps, key);
    if (!cluster) return ok(undefined);

    const comparison = await compareWithinCluster(deps, experience, cluster);
    // The first experience in a cluster has nothing to compare against, so it is
    // the pattern rather than a match to it.
    const relationship = comparison?.relationship ?? 'same_experience';
    const score = comparison?.score ?? 1;
    const factors = comparison?.factors ?? {};

    // A comparison that came back `no_match` means the identifiers agreed enough
    // to share a key but the accounts do not relate. It still belongs to the
    // pattern — the key is the pattern — so it joins, with that recorded.
    await deps.store.clusterMembers.put({
      // Keyed on the pair, so re-delivery updates rather than duplicating.
      id: `${cluster.id}:${experienceId}`,
      clusterId: cluster.id,
      experienceId,
      relationship,
      score,
      factors: factors as Readonly<Record<string, number>>,
    });

    if (experience.clusterId !== cluster.id) {
      await deps.store.experiences.put({ ...experience, clusterId: cluster.id });
    }

    await recomputeClusterCounters(deps, cluster.id);
    deps.metrics.increment('matching.clustered', { relationship });

    await deps.outbox.append(
      [
        {
          aggregateType: 'cluster',
          aggregateId: cluster.id,
          eventName: 'ClusterMembershipChanged',
          payload: { clusterId: cluster.id, experienceId, relationship },
          ...(event.id === undefined ? {} : { causationId: event.id }),
        },
      ],
      event.correlationId,
    );
    return ok(undefined);
  },
});

/**
 * Cluster counters, recomputed from rows.
 *
 * `uniqueExperiencers` is the load-bearing one: authors plus corroborators,
 * counted once each across the whole cluster. One person appearing in five
 * experiences in a cluster is one experiencer, not five.
 */
export const recomputeClusterCounters = async (deps: EngineDeps, clusterId: string): Promise<void> => {
  const cluster = await deps.store.clusters.get(clusterId);
  if (!cluster) return;

  const members = await deps.store.clusterMembers.query([eq<ClusterMember>('clusterId', clusterId)]);
  const experiencers = new Set<string>();
  let corroborations = 0;
  let published = 0;

  for (const member of members) {
    const experience = await deps.store.experiences.get(member.experienceId);
    if (!experience || experience.status !== 'published') continue;
    published += 1;
    experiencers.add(experience.actorId);
    const claims = await deps.store.corroborations.query([
      eq('experienceId', member.experienceId),
      eq('status', 'active'),
    ]);
    corroborations += claims.length;
    for (const claim of claims) experiencers.add(claim.corroboratorId);
  }

  await deps.store.clusters.put({
    ...cluster,
    totalExperiences: published,
    corroborations,
    uniqueExperiencers: experiencers.size,
    updatedAt: deps.clock.now(),
  });
};

/** Cluster counters follow corroborations too, not only publications. */
export const createClusterCounterConsumer = (deps: EngineDeps): Consumer => ({
  name: 'matching.cluster_counters',
  events: ['ExperienceReRaged', 'ExperienceReRaved', 'CorroborationRetracted', 'ExperienceDeleted', 'ContentRemoved'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    if (!experienceId) return ok(undefined);
    const membership = await deps.store.clusterMembers.queryOne([eq<ClusterMember>('experienceId', experienceId)]);
    if (!membership) return ok(undefined);
    await recomputeClusterCounters(deps, membership.clusterId);
    return ok(undefined);
  },
});

/** A cluster and its published members, as a public projection. */
export const clusterWithMembers = async (
  deps: EngineDeps,
  clusterId: string,
): Promise<{ cluster: ClusterRow; members: readonly ClusterMember[] } | undefined> => {
  const cluster = await deps.store.clusters.get(clusterId);
  if (!cluster) return undefined;
  const members = await deps.store.clusterMembers.query([eq<ClusterMember>('clusterId', clusterId)], {
    orderBy: { field: 'score', direction: 'desc' },
  });
  return { cluster, members };
};
