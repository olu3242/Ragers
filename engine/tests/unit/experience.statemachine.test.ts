import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginReview,
  beginValidation,
  canTransition,
  changeVisibility,
  createExperience,
  deleteExperience,
  hideExperience,
  isPubliclyVisible,
  mediaFailed,
  mediaReady,
  publishExperience,
  removeExperience,
  restoreExperience,
  updateBody,
  type Experience,
} from '../../src/domain/experience.ts';
import { EXPERIENCE_STATUSES } from '../../src/domain/types.ts';
import { expect } from '../../src/runtime/result.ts';

const meta = { id: 'exp_0001', correlationId: 'corr_1', now: 1_000 };

const draftText = (): Experience =>
  expect(
    createExperience(
      {
        actorId: 'actor_1',
        kind: 'rage',
        creationMode: 'text',
        category: 'Everyday courtesy',
        bodyText: 'Someone blocked the crosswalk again.',
        visibility: 'public',
      },
      meta,
    ),
    'draft text',
  ).experience;

const draftVoice = (): Experience =>
  expect(
    createExperience(
      { actorId: 'actor_1', kind: 'rave', creationMode: 'voice', category: 'Neighborhood', visibility: 'anonymous' },
      meta,
    ),
    'draft voice',
  ).experience;

test('a text experience routes draft -> validating -> pending_moderation', () => {
  const change = expect(beginValidation(draftText(), 2_000), 'validate');
  assert.equal(change.experience.status, 'pending_moderation');
  assert.equal(change.events[0]?.eventName, 'ExperienceValidated');
});

test('a voice experience routes through pending_media and cannot skip it', () => {
  const validated = expect(beginValidation(draftVoice(), 2_000), 'validate');
  assert.equal(validated.experience.status, 'pending_media', 'voice must wait for its media');

  const published = publishExperience(validated.experience, 3_000);
  assert.equal(published.ok, false, 'a voice experience cannot publish while media is pending');
  if (!published.ok) assert.equal(published.error.code, 'illegal_transition');

  const ready = expect(mediaReady(validated.experience, 'media_1', 4_000), 'media ready');
  assert.equal(ready.experience.status, 'pending_moderation');
  assert.equal(ready.experience.mediaAssetId, 'media_1');
});

test('failed media returns a voice experience to draft so the author can re-record', () => {
  const validated = expect(beginValidation(draftVoice(), 2_000), 'validate');
  const failed = expect(mediaFailed(validated.experience, 'protection_failed', 3_000), 'media failed');
  assert.equal(failed.experience.status, 'draft');
  assert.equal(failed.events[0]?.eventName, 'ExperienceMediaFailed');
});

test('publish is idempotent and emits no second event', () => {
  const pending = expect(beginValidation(draftText(), 2_000), 'validate').experience;
  const first = expect(publishExperience(pending, 3_000), 'publish');
  assert.equal(first.experience.status, 'published');
  assert.equal(first.experience.publishedAt, 3_000);
  assert.equal(first.events.length, 1);

  const second = expect(publishExperience(first.experience, 4_000), 'republish');
  assert.equal(second.experience.version, first.experience.version, 'no version bump on a no-op');
  assert.equal(second.events.length, 0, 'a republish emits no second event');
});

test('every mutation increments the version', () => {
  const draft = draftText();
  assert.equal(draft.version, 1);
  const validated = expect(beginValidation(draft, 2_000), 'validate').experience;
  assert.equal(validated.version, 3, 'draft -> validating -> pending_moderation is two transitions');
  const published = expect(publishExperience(validated, 3_000), 'publish').experience;
  assert.equal(published.version, 4);
});

test('the transition table rejects every illegal move', () => {
  // deleted is terminal
  for (const status of EXPERIENCE_STATUSES) {
    assert.equal(canTransition('deleted', status), false, `deleted must not move to ${status}`);
  }
  assert.equal(canTransition('draft', 'published'), false, 'draft cannot publish directly');
  assert.equal(canTransition('draft', 'pending_moderation'), false, 'draft must be validated first');
  assert.equal(canTransition('pending_media', 'published'), false, 'media must be ready first');
  assert.equal(canTransition('published', 'draft'), false, 'a published experience cannot return to draft');
  assert.ok(canTransition('removed', 'published'), 'a moderator can restore removed content');
});

test('delete is idempotent and terminal', () => {
  const published = expect(
    publishExperience(expect(beginValidation(draftText(), 2_000), 'v').experience, 3_000),
    'publish',
  ).experience;

  const deleted = expect(deleteExperience(published, 4_000), 'delete');
  assert.equal(deleted.experience.status, 'deleted');
  assert.equal(deleted.experience.deletedAt, 4_000);

  const again = expect(deleteExperience(deleted.experience, 5_000), 'redelete');
  assert.equal(again.events.length, 0, 'a second delete emits no event');

  assert.equal(publishExperience(deleted.experience, 6_000).ok, false, 'deleted content cannot be revived');
});

test('hide, review, remove and restore follow the documented lifecycle', () => {
  const published = expect(
    publishExperience(expect(beginValidation(draftText(), 2_000), 'v').experience, 3_000),
    'publish',
  ).experience;

  const hidden = expect(hideExperience(published, 4_000), 'hide').experience;
  assert.equal(hidden.status, 'hidden');
  assert.equal(isPubliclyVisible(hidden.status), false);

  const reviewed = expect(beginReview(published, 4_000), 'review').experience;
  assert.equal(reviewed.status, 'under_review');
  assert.equal(isPubliclyVisible(reviewed.status), false, 'content under review is not public');

  const removed = expect(removeExperience(reviewed, 'naming_shaming', 5_000), 'remove').experience;
  assert.equal(removed.status, 'removed');

  const restored = expect(restoreExperience(removed, 6_000), 'restore').experience;
  assert.equal(restored.status, 'published');
  assert.ok(isPubliclyVisible(restored.status));
});

test('only published content is publicly visible', () => {
  for (const status of EXPERIENCE_STATUSES) {
    assert.equal(isPubliclyVisible(status), status === 'published', `${status} visibility`);
  }
});

test('editing is refused on removed or deleted content', () => {
  const published = expect(
    publishExperience(expect(beginValidation(draftText(), 2_000), 'v').experience, 3_000),
    'publish',
  ).experience;
  const removed = expect(removeExperience(published, 'spam', 4_000), 'remove').experience;
  const edited = updateBody(removed, 'trying to edit', 5_000);
  assert.equal(edited.ok, false);
  if (!edited.ok) assert.equal(edited.error.code, 'not_editable');
});

test('visibility may be tightened but never loosened', () => {
  const publicDraft = draftText();
  const toAlias = expect(changeVisibility(publicDraft, 'alias', 'alias_1', 2_000), 'tighten to alias');
  assert.equal(toAlias.experience.visibility, 'alias');
  assert.equal(toAlias.experience.aliasId, 'alias_1');

  const toAnonymous = expect(changeVisibility(toAlias.experience, 'anonymous', undefined, 3_000), 'tighten');
  assert.equal(toAnonymous.experience.visibility, 'anonymous');

  const loosen = changeVisibility(toAnonymous.experience, 'public', undefined, 4_000);
  assert.equal(loosen.ok, false, 'de-anonymising published content is a privacy violation');
  if (!loosen.ok) assert.equal(loosen.error.code, 'visibility_cannot_loosen');

  const noop = expect(changeVisibility(toAnonymous.experience, 'anonymous', undefined, 5_000), 'noop');
  assert.equal(noop.events.length, 0);
});
