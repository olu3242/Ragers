import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExperience, updateBody } from '../../src/domain/experience.ts';
import { BODY_MAX_LENGTH, REJECTED_REACTION_TYPES, REACTION_TYPES, isReactionType } from '../../src/domain/types.ts';
import { expect } from '../../src/runtime/result.ts';

const meta = { id: 'exp_1', correlationId: 'corr_1', now: 1_000 };

const base = {
  actorId: 'actor_1',
  kind: 'rage' as const,
  creationMode: 'text' as const,
  category: 'Everyday courtesy',
  bodyText: 'A short observation.',
  visibility: 'public' as const,
};

test('a valid text Rage and Rave both draft successfully', () => {
  const rage = expect(createExperience(base, meta), 'rage');
  assert.equal(rage.experience.kind, 'rage');
  assert.equal(rage.experience.status, 'draft');
  assert.equal(rage.experience.creationMode, 'text');

  const rave = expect(createExperience({ ...base, kind: 'rave' }, meta), 'rave');
  assert.equal(rave.experience.kind, 'rave');
});

test('the client cannot invent a kind, mode, visibility or category', () => {
  const cases: readonly [Partial<typeof base>, string][] = [
    [{ kind: 'complaint' as never }, 'invalid_kind'],
    [{ creationMode: 'video' as never }, 'invalid_creation_mode'],
    [{ visibility: 'secret' as never }, 'invalid_visibility'],
    [{ category: 'Politics' }, 'invalid_category'],
  ];
  for (const [override, code] of cases) {
    const result = createExperience({ ...base, ...override }, meta);
    assert.equal(result.ok, false, `${code} must be rejected`);
    if (!result.ok) assert.equal(result.error.code, code);
  }
});

test('body length is bounded server-side', () => {
  const tooLong = createExperience({ ...base, bodyText: 'x'.repeat(BODY_MAX_LENGTH + 1) }, meta);
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.error.code, 'body_too_long');

  const atLimit = createExperience({ ...base, bodyText: 'x'.repeat(BODY_MAX_LENGTH) }, meta);
  assert.equal(atLimit.ok, true, 'exactly at the limit is valid');
});

test('a text experience requires a body; a voice experience does not', () => {
  const emptyText = createExperience({ ...base, bodyText: '   ' }, meta);
  assert.equal(emptyText.ok, false);
  if (!emptyText.ok) assert.equal(emptyText.error.code, 'body_required');

  const voiceNoBody = createExperience(
    { ...base, creationMode: 'voice', bodyText: undefined, visibility: 'anonymous' },
    meta,
  );
  assert.equal(voiceNoBody.ok, true, 'voice may carry no text at all');
  assert.equal(expect(voiceNoBody, 'voice').experience.bodyText, '');
});

test('the body is trimmed rather than stored with padding', () => {
  const change = expect(createExperience({ ...base, bodyText: '  padded  ' }, meta), 'trim');
  assert.equal(change.experience.bodyText, 'padded');
});

test('alias visibility requires an alias, and an alias requires alias visibility', () => {
  const missingAlias = createExperience({ ...base, visibility: 'alias' }, meta);
  assert.equal(missingAlias.ok, false);
  if (!missingAlias.ok) assert.equal(missingAlias.error.code, 'alias_required');

  const strayAlias = createExperience({ ...base, visibility: 'public', aliasId: 'alias_1' }, meta);
  assert.equal(strayAlias.ok, false);
  if (!strayAlias.ok) assert.equal(strayAlias.error.code, 'alias_not_permitted');

  const valid = createExperience({ ...base, visibility: 'alias', aliasId: 'alias_1' }, meta);
  assert.equal(valid.ok, true);
});

test('drafting emits exactly one ExperienceDrafted event carrying no body text', () => {
  const change = expect(createExperience(base, meta), 'draft');
  assert.equal(change.events.length, 1);
  const event = change.events[0];
  assert.equal(event?.eventName, 'ExperienceDrafted');
  assert.equal(JSON.stringify(event?.payload).includes('A short observation'), false, 'events carry no body text');
});

test('body edits are bounded the same way as creation', () => {
  const experience = expect(createExperience(base, meta), 'draft').experience;
  const tooLong = updateBody(experience, 'x'.repeat(BODY_MAX_LENGTH + 1), 2_000);
  assert.equal(tooLong.ok, false);
  const ok = expect(updateBody(experience, 'edited body', 2_000), 'edit');
  assert.equal(ok.experience.bodyText, 'edited body');
  assert.equal(ok.experience.version, experience.version + 1);
});

test('engagement mechanics are Ragers-native; generic social mechanics are not accepted', () => {
  assert.deepEqual([...REACTION_TYPES], ['been_there', 'same', 'fair_point', 'disagree']);
  for (const rejected of REJECTED_REACTION_TYPES) {
    assert.equal(isReactionType(rejected), false, `${rejected} must not be a valid reaction type`);
  }
});
