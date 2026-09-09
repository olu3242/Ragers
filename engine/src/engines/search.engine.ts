import { ok } from '../runtime/result.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { SearchDocument } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * P11 Search Engine.
 *
 * Search indexes the privacy-safe projection only: redacted transcript text,
 * never raw; an identity label, never an actor id. Purges are urgent — a stale
 * entry after removal is a privacy incident, not a latency problem.
 */
const buildDocument = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<SearchDocument | undefined> => {
  const experience = await deps.store.experiences.get(experienceId);
  if (!experience || experience.status !== 'published') return undefined;

  const entry = await deps.store.feedEntries.get(experienceId);
  const asset = experience.mediaAssetId ? await deps.store.mediaAssets.get(experience.mediaAssetId) : undefined;
  const transcript = asset
    ? await deps.store.transcripts.findOne((row) => row.mediaAssetId === asset.id)
    : undefined;

  // Only the redacted form is ever indexed.
  const transcriptText = transcript?.redactedText ?? '';
  const subjectLinks = await deps.store.experienceSubjects.find((row) => row.experienceId === experienceId);
  const subjectTerms: string[] = [];
  for (const link of subjectLinks) {
    const subject = await deps.store.subjects.get(link.subjectId);
    if (subject) subjectTerms.push(subject.canonicalTerm);
  }

  return {
    id: experienceId,
    experienceId,
    kind: experience.kind,
    category: experience.category,
    searchableText: [experience.bodyText, transcriptText].filter((part) => part.length > 0).join(' '),
    subjectTerms,
    identityLabel: entry?.identityLabel ?? 'Anonymous',
    hasVoice: experience.creationMode === 'voice',
    publishedAt: experience.publishedAt ?? experience.createdAt,
  };
};

export const createSearchIndexConsumer = (deps: EngineDeps): Consumer => ({
  name: 'search.index',
  events: ['ExperiencePublished', 'TranscriptRedacted', 'SubjectsExtracted', 'ContentRestored'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    if (!experienceId) return ok(undefined);
    const document = await buildDocument(deps, experienceId);
    // Keyed by experience id: re-indexing overwrites rather than duplicating.
    if (!document) {
      await deps.store.searchDocuments.remove(experienceId);
      return ok(undefined);
    }
    await deps.store.searchDocuments.put(document);
    deps.metrics.increment('search.indexed');
    return ok(undefined);
  },
});

export const createSearchPurgeConsumer = (deps: EngineDeps): Consumer => ({
  name: 'search.purge',
  events: ['ContentRemoved', 'ExperienceDeleted', 'ExperienceHidden', 'ExperienceUnderReview'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    await deps.store.searchDocuments.remove(experienceId);
    deps.metrics.increment('search.purged');
    return ok(undefined);
  },
});

export interface SearchQuery {
  readonly text?: string;
  readonly kind?: 'rage' | 'rave';
  readonly category?: string;
  readonly voiceOnly?: boolean;
  readonly limit?: number;
}

export interface SearchHit {
  readonly experienceId: string;
  readonly kind: 'rage' | 'rave';
  readonly category: string;
  readonly identityLabel: string;
  readonly hasVoice: boolean;
  readonly excerpt: string;
  readonly publishedAt: number;
}

/** Query the index. Results are built from the document, which holds no actor reference. */
export const searchExperiences = async (
  deps: EngineDeps,
  query: SearchQuery,
): Promise<readonly SearchHit[]> => {
  const needle = query.text?.trim().toLowerCase();
  const documents = await deps.store.searchDocuments.find((row) => {
    if (query.kind && row.kind !== query.kind) return false;
    if (query.category && row.category !== query.category) return false;
    if (query.voiceOnly && !row.hasVoice) return false;
    if (needle && needle.length > 0) {
      const haystack = `${row.searchableText} ${row.subjectTerms.join(' ')}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  return [...documents]
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, query.limit ?? 25)
    .map((row) => ({
      experienceId: row.experienceId,
      kind: row.kind,
      category: row.category,
      identityLabel: row.identityLabel,
      hasVoice: row.hasVoice,
      excerpt: row.searchableText.slice(0, 160),
      publishedAt: row.publishedAt,
    }));
};
