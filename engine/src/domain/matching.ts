import type { MatchRelationship } from './corroboration.ts';

/**
 * Experience matching.
 *
 * The rule that shapes this module: a semantic similarity score may never decide
 * the outcome on its own. Two experiences that read alike but concern different
 * organizations are not the same experience, and an embedding cannot know that.
 * So deterministic agreement (entity, issue, category) *gates* the relationship,
 * and semantic similarity only refines it.
 */
export interface MatchFactors {
  /** 1 when the same entity, 0 when different, 0.5 when unknown on either side. */
  readonly entity: number;
  readonly issue: number;
  readonly category: number;
  readonly semantic: number;
  readonly temporal: number;
  readonly geographic: number;
}

export interface MatchResult {
  readonly score: number;
  readonly relationship: MatchRelationship;
  readonly factors: MatchFactors;
  /** Why this relationship, in terms a person can check. */
  readonly rationale: string;
}

export interface MatchCandidate {
  readonly entityId?: string;
  readonly categoryId?: string;
  readonly issueTypeId?: string;
  readonly locationId?: string;
  readonly occurredAt?: number;
  /** Normalised terms, from redacted text only. */
  readonly terms: readonly string[];
}

/** Experiences more than this far apart are not the same occurrence. */
export const SAME_EXPERIENCE_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;

const UNKNOWN = 0.5;

/** Agreement on an identifier: 1 same, 0 different, 0.5 when either is unknown. */
const identifierAgreement = (left: string | undefined, right: string | undefined): number => {
  if (left === undefined || right === undefined) return UNKNOWN;
  return left === right ? 1 : 0;
};

/** Jaccard overlap of normalised terms — the semantic factor, kept explainable. */
export const termSimilarity = (left: readonly string[], right: readonly string[]): number => {
  if (left.length === 0 || right.length === 0) return 0;
  const a = new Set(left.map((term) => term.toLowerCase()));
  const b = new Set(right.map((term) => term.toLowerCase()));
  let shared = 0;
  for (const term of a) if (b.has(term)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : Number((shared / union).toFixed(4));
};

/** Decays from 1 to 0 across the same-experience window. */
export const temporalProximity = (left: number | undefined, right: number | undefined): number => {
  if (left === undefined || right === undefined) return UNKNOWN;
  const distance = Math.abs(left - right);
  if (distance >= SAME_EXPERIENCE_WINDOW_MS) return 0;
  return Number((1 - distance / SAME_EXPERIENCE_WINDOW_MS).toFixed(4));
};

export const computeFactors = (left: MatchCandidate, right: MatchCandidate): MatchFactors => ({
  entity: identifierAgreement(left.entityId, right.entityId),
  issue: identifierAgreement(left.issueTypeId, right.issueTypeId),
  category: identifierAgreement(left.categoryId, right.categoryId),
  semantic: termSimilarity(left.terms, right.terms),
  temporal: temporalProximity(left.occurredAt, right.occurredAt),
  geographic: identifierAgreement(left.locationId, right.locationId),
});

/** Weights sum to 1. Entity and issue dominate, because they are the facts. */
const WEIGHTS: MatchFactors = {
  entity: 0.3,
  issue: 0.25,
  category: 0.1,
  semantic: 0.2,
  temporal: 0.1,
  geographic: 0.05,
};

export const scoreFactors = (factors: MatchFactors): number =>
  Number(
    (
      factors.entity * WEIGHTS.entity +
      factors.issue * WEIGHTS.issue +
      factors.category * WEIGHTS.category +
      factors.semantic * WEIGHTS.semantic +
      factors.temporal * WEIGHTS.temporal +
      factors.geographic * WEIGHTS.geographic
    ).toFixed(4),
  );

export const SEMANTIC_RELATED_THRESHOLD = 0.3;

/**
 * Decide the relationship from deterministic gates first, then the score.
 *
 * The gates are the point: `same_experience` requires actual agreement on the
 * entity and the issue. No amount of textual similarity substitutes for that.
 */
export const matchExperiences = (left: MatchCandidate, right: MatchCandidate): MatchResult => {
  const factors = computeFactors(left, right);
  const score = scoreFactors(factors);

  // A different entity is disqualifying, however similar the wording.
  if (factors.entity === 0) {
    return {
      score,
      relationship: 'no_match',
      factors,
      rationale: 'different entities, so this cannot be the same or a similar experience',
    };
  }

  const entityAgrees = factors.entity === 1;
  const issueAgrees = factors.issue === 1;
  const categoryAgrees = factors.category === 1;
  const withinWindow = factors.temporal > 0;
  const locationCompatible = factors.geographic > 0;

  if (entityAgrees && issueAgrees && withinWindow && locationCompatible) {
    return {
      score,
      relationship: 'same_experience',
      factors,
      rationale: 'same entity and issue, within the same window and compatible location',
    };
  }

  if (entityAgrees && (issueAgrees || factors.semantic >= SEMANTIC_RELATED_THRESHOLD)) {
    return {
      score,
      relationship: 'similar_experience',
      factors,
      rationale: issueAgrees
        ? 'same entity and issue, but a different time or place'
        : 'same entity, and the accounts describe comparable circumstances',
    };
  }

  if ((entityAgrees || categoryAgrees) && factors.semantic >= SEMANTIC_RELATED_THRESHOLD) {
    return {
      score,
      relationship: 'related_experience',
      factors,
      rationale: 'the same entity or category, with comparable circumstances',
    };
  }

  return {
    score,
    relationship: 'no_match',
    factors,
    rationale: 'not enough deterministic agreement to relate these experiences',
  };
};

/**
 * The cluster key for an experience. A cluster is a repeated pattern, so the key
 * is the pattern: kind plus the identifiers that make it one.
 */
export interface ClusterKey {
  readonly kind: 'rage' | 'rave';
  readonly entityId?: string;
  readonly categoryId?: string;
  readonly issueTypeId?: string;
}

export const clusterKeyOf = (
  kind: 'rage' | 'rave',
  candidate: MatchCandidate,
): ClusterKey => ({
  kind,
  ...(candidate.entityId === undefined ? {} : { entityId: candidate.entityId }),
  ...(candidate.categoryId === undefined ? {} : { categoryId: candidate.categoryId }),
  ...(candidate.issueTypeId === undefined ? {} : { issueTypeId: candidate.issueTypeId }),
});

export const clusterKeyMatches = (left: ClusterKey, right: ClusterKey): boolean =>
  left.kind === right.kind &&
  left.entityId === right.entityId &&
  left.categoryId === right.categoryId &&
  left.issueTypeId === right.issueTypeId;

/** A cluster needs an entity to be meaningful; a bare category is too broad. */
export const isClusterable = (key: ClusterKey): boolean => key.entityId !== undefined;
