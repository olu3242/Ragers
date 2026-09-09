import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { extractCandidates, isPersonLikeCandidate } from '../../src/engines/subject.engine.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';

test('candidates that read as personal names are rejected', () => {
  for (const candidate of ['John Smith', 'Mary Jane Watson', 'Dr Watson', 'Mr Smith', '[person_name]']) {
    assert.ok(isPersonLikeCandidate(candidate), `${candidate} must be rejected as a subject`);
  }
  for (const candidate of ['crosswalk', 'queue jumping', 'trolley']) {
    assert.equal(isPersonLikeCandidate(candidate), false, `${candidate} is a behaviour, not a person`);
  }
});

test('extraction skips redaction markers so a marker never becomes a subject', () => {
  const candidates = extractCandidates('[person_name] blocked the crosswalk near [address] again');
  assert.equal(
    candidates.some((c) => c.includes('person') || c.includes('address')),
    false,
    'redaction class markers must not leak into the subject graph',
  );
  assert.ok(candidates.includes('crosswalk'));
});

test('extraction drops stopwords and short tokens', () => {
  const candidates = extractCandidates('The person was in the queue and it was very rude');
  assert.equal(candidates.includes('the'), false);
  assert.equal(candidates.includes('was'), false);
  assert.equal(candidates.includes('person'), false, 'person is a stopword, not a subject');
  assert.ok(candidates.includes('queue'));
});

test('the category is always a subject, and two experiences about one behaviour share it', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');

  const ids: string[] = [];
  for (const body of ['Someone blocked the crosswalk again', 'Another driver blocked the crosswalk']) {
    const created = expect(
      await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
        name: 'experience.create',
        input: { kind: 'rage', creationMode: 'text', category: 'Driving & transit', bodyText: body, visibility: 'public' },
        actor: author.actor,
        idempotencyKey: h.nextKey(),
      }),
      'create',
    );
    ids.push(created.experienceId);
  }
  await h.settle();

  const crosswalk = await h.engine.store.subjects.findOne((row) => row.canonicalTerm === 'crosswalk');
  assert.ok(crosswalk, 'the shared behaviour resolves to one canonical subject');
  assert.equal(crosswalk?.experienceCount, 2, 'both experiences link to it');

  const category = await h.engine.store.subjects.findOne((row) => row.canonicalTerm === 'driving & transit');
  assert.ok(category, 'the category is the seed taxonomy');
  assert.equal(category?.kind, 'context');

  for (const id of ids) {
    const links = await h.engine.store.experienceSubjects.find((row) => row.experienceId === id);
    assert.ok(links.length >= 2, 'each experience links to its category and its extracted behaviours');
  }
});

test('subject extraction reads redacted transcript text, never raw', async () => {
  const h = createEngineHarness({
    providers: {
      transcription: {
        name: 'planted',
        transcribe: async () => ({
          ok: true as const,
          value: { text: 'Jane Doe skipped the entire queue', language: 'en', confidence: 0.9 },
        }),
      },
    },
  });
  const author = await h.signUp('author@example.com');

  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'voice', category: 'Shopping & service', visibility: 'anonymous' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  const target = expect(
    await h.engine.bus.dispatch<unknown, { uploadTargetId: string }>({
      name: 'voice.requestUploadTarget',
      input: { experienceId: created.experienceId },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'target',
  );
  expect(
    await h.engine.bus.dispatch({
      name: 'voice.attachAsset',
      input: {
        experienceId: created.experienceId,
        uploadTargetId: target.uploadTargetId,
        durationMs: 4_000,
        byteSize: 90_000,
        mimeType: 'audio/webm',
      },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'attach',
  );
  await h.settle();

  const terms = (await h.engine.store.subjects.all()).map((row) => row.canonicalTerm);
  assert.equal(terms.includes('jane'), false, 'a name from the raw transcript must not become a subject');
  assert.equal(terms.includes('doe'), false);
  assert.ok(terms.includes('queue'), 'the behaviour is extracted from the redacted form');
});

test('deleting an experience drops its subject links and recounts', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');

  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: {
        kind: 'rage',
        creationMode: 'text',
        category: 'Neighborhood',
        bodyText: 'Someone left rubbish by the bins',
        visibility: 'public',
      },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();
  assert.ok((await h.engine.store.experienceSubjects.count()) > 0);

  expect(
    await h.engine.bus.dispatch({
      name: 'creator.deleteExperience',
      input: { experienceId: created.experienceId },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'delete',
  );
  await h.settle();

  assert.equal(await h.engine.store.experienceSubjects.count(), 0, 'links are dropped');
  for (const subject of await h.engine.store.subjects.all()) {
    assert.equal(subject.experienceCount, 0, 'counts are recomputed, not left stale');
  }
});
