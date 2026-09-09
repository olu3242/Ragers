import { ok } from '../runtime/result.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import { eq } from '../ports/store.ts';
import type { Subject } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * P12 Subject Graph Engine.
 *
 * Subjects are *behaviours*, never people. The guardrail is structural: a
 * candidate that looks like a person's name is rejected at extraction, and
 * extraction reads only redacted text — never a raw transcript.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'this', 'that', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
  'did', 'will', 'would', 'should', 'could', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'my', 'your', 'his', 'her', 'its', 'our', 'their', 'me', 'him', 'them', 'us', 'again',
  'at', 'in', 'on', 'for', 'to', 'of', 'with', 'without', 'from', 'by', 'as', 'so', 'just',
  'someone', 'somebody', 'anyone', 'people', 'person', 'guy', 'man', 'woman',
]);

/**
 * A candidate that reads as a personal name is refused. Redaction markers are
 * refused too: `[person_name]` in redacted text must never become a subject.
 */
export const isPersonLikeCandidate = (candidate: string): boolean => {
  if (candidate.startsWith('[') && candidate.endsWith(']')) return true;
  if (/^(mr|mrs|ms|miss|dr|prof)\b/i.test(candidate)) return true;
  // Two or more capitalised words reads as a name, not a behaviour.
  return /^([A-Z][a-z]+)(\s+[A-Z][a-z]+)+$/.test(candidate);
};

export const extractCandidates = (text: string): readonly string[] => {
  const bracketed = text.match(/\[[a-z_]+\]/g) ?? [];
  const cleaned = bracketed.reduce((acc, marker) => acc.replaceAll(marker, ' '), text);
  const words = cleaned
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word));
  return [...new Set(words)].slice(0, 8);
};

export const createSubjectExtractionConsumer = (deps: EngineDeps): Consumer => ({
  name: 'subject.extract',
  events: ['ExperiencePublished', 'TranscriptRedacted'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    const experience = await deps.store.experiences.get(experienceId);
    if (!experience || experience.status !== 'published') return ok(undefined);

    // The category is always a subject, and is the seed taxonomy.
    const terms = new Map<string, 'category' | 'extracted'>();
    terms.set(experience.category.toLowerCase(), 'category');

    const asset = experience.mediaAssetId ? await deps.store.mediaAssets.get(experience.mediaAssetId) : undefined;
    const transcript = asset
      ? await deps.store.transcripts.queryOne([eq('mediaAssetId', asset.id)])
      : undefined;

    // Only redacted text is ever read here.
    const source = [experience.bodyText, transcript?.redactedText ?? ''].join(' ');
    for (const candidate of extractCandidates(source)) {
      if (isPersonLikeCandidate(candidate)) {
        deps.metrics.increment('subject.candidate_rejected', { reason: 'person_like' });
        continue;
      }
      if (!terms.has(candidate)) terms.set(candidate, 'extracted');
    }

    for (const [term, source_] of terms) {
      let subject = await deps.store.subjects.queryOne([eq('canonicalTerm', term)]);
      if (!subject) {
        subject = {
          id: deps.ids.next('subj'),
          canonicalTerm: term,
          kind: source_ === 'category' ? 'context' : 'behavior',
          experienceCount: 0,
          state: 'canonical',
        } satisfies Subject;
        await deps.store.subjects.put(subject);
      }
      const linkId = `${experienceId}:${subject.id}`;
      // Idempotent: the link is keyed, so re-extraction overwrites.
      await deps.store.experienceSubjects.put({
        id: linkId,
        experienceId,
        subjectId: subject.id,
        weight: source_ === 'category' ? 2 : 1,
        source: source_,
      });
    }

    // Counts are recomputed from links, so they converge under re-delivery.
    for (const subject of await deps.store.subjects.all()) {
      const count = await deps.store.experienceSubjects.countWhere([eq('subjectId', subject.id)]);
      if (count !== subject.experienceCount) {
        await deps.store.subjects.put({ ...subject, experienceCount: count });
      }
    }

    await deps.outbox.append(
      [
        {
          aggregateType: 'experience',
          aggregateId: experienceId,
          eventName: 'SubjectsExtracted',
          payload: { experienceId, subjectCount: terms.size },
        },
      ],
      event.correlationId,
    );
    return ok(undefined);
  },
});

/** Deletion and removal drop the subject links and recount. */
export const createSubjectPurgeConsumer = (deps: EngineDeps): Consumer => ({
  name: 'subject.purge',
  events: ['ContentRemoved', 'ExperienceDeleted'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    for (const link of await deps.store.experienceSubjects.query([eq('experienceId', experienceId)])) {
      await deps.store.experienceSubjects.remove(link.id);
    }
    for (const subject of await deps.store.subjects.all()) {
      const count = await deps.store.experienceSubjects.countWhere([eq('subjectId', subject.id)]);
      if (count !== subject.experienceCount) {
        await deps.store.subjects.put({ ...subject, experienceCount: count });
      }
    }
    return ok(undefined);
  },
});
