import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptsCorroboration,
  corroborationTypeFor,
  createCorroboration,
  createShare,
  NARRATIVE_MAX_LENGTH,
  retractCorroboration,
  type Corroboration,
} from '../../src/domain/corroboration.ts';
import { expect } from '../../src/runtime/result.ts';

/**
 * The product contract, at the domain layer.
 *
 * RAGE / RE-RAGE / RAVE / RE-RAVE / SHARE have to mean distinct things, and the
 * distinctions have to be enforced rather than described. These tests are the
 * enforcement.
 */
const meta = { id: 'cor_1', correlationId: 'corr_1', now: 2_000 };

const base = {
  experienceId: 'exp_1',
  corroboratorId: 'actor_other',
  experienceKind: 'rage' as const,
  experienceAuthorId: 'actor_author',
  type: 're_rage' as const,
};

test('a rage accepts only a re-rage, and a rave only a re-rave', () => {
  assert.equal(corroborationTypeFor('rage'), 're_rage');
  assert.equal(corroborationTypeFor('rave'), 're_rave');

  assert.ok(acceptsCorroboration('rage', 're_rage'));
  assert.ok(acceptsCorroboration('rave', 're_rave'));
  assert.equal(acceptsCorroboration('rage', 're_rave'), false, 'a rage must not take a re-rave');
  assert.equal(acceptsCorroboration('rave', 're_rage'), false, 'a rave must not take a re-rage');
});

test('corroborating a rage with a re-rave is refused', () => {
  const result = createCorroboration({ ...base, type: 're_rave' }, meta);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'corroboration_kind_mismatch');
});

test('corroborating a rave with a re-rage is refused', () => {
  const result = createCorroboration(
    { ...base, experienceKind: 'rave', type: 're_rage' },
    meta,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'corroboration_kind_mismatch');
});

test('an author cannot corroborate their own experience', () => {
  const result = createCorroboration({ ...base, corroboratorId: 'actor_author' }, meta);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'no_self_corroboration');
});

test('a corroboration needs nothing beyond the claim itself', () => {
  const corroboration = expect(createCorroboration(base, meta), 'minimal');
  assert.equal(corroboration.type, 're_rage');
  assert.equal(corroboration.relationship, 'same_experience', 'the default is the same experience');
  assert.equal(corroboration.status, 'active');
  assert.equal(corroboration.narrative, undefined, 'context is optional');
  assert.equal(corroboration.occurredAt, undefined);
  assert.equal(corroboration.mediaAssetId, undefined);
});

test('optional context, time, place and voice all attach', () => {
  const corroboration = expect(
    createCorroboration(
      {
        ...base,
        narrative: '  Same refund delay, three weeks.  ',
        occurredAt: 1_500,
        locationId: 'loc_dfw',
        mediaAssetId: 'media_1',
        relationship: 'similar_experience',
      },
      meta,
    ),
    'full',
  );
  assert.equal(corroboration.narrative, 'Same refund delay, three weeks.', 'trimmed');
  assert.equal(corroboration.occurredAt, 1_500);
  assert.equal(corroboration.locationId, 'loc_dfw');
  assert.equal(corroboration.mediaAssetId, 'media_1');
  assert.equal(corroboration.relationship, 'similar_experience');
});

test('a corroboration cannot claim a future occurrence', () => {
  const result = createCorroboration({ ...base, occurredAt: meta.now + 1 }, meta);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'occurred_in_future');
});

test('context length is bounded', () => {
  const tooLong = createCorroboration({ ...base, narrative: 'x'.repeat(NARRATIVE_MAX_LENGTH + 1) }, meta);
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.error.code, 'narrative_too_long');
  assert.ok(createCorroboration({ ...base, narrative: 'x'.repeat(NARRATIVE_MAX_LENGTH) }, meta).ok);
});

test('a corroboration can be anonymous or aliased, with the same coupling rules as an experience', () => {
  const anonymous = expect(createCorroboration({ ...base, visibility: 'anonymous' }, meta), 'anon');
  assert.equal(anonymous.visibility, 'anonymous');
  assert.equal(anonymous.aliasId, undefined);

  const missingAlias = createCorroboration({ ...base, visibility: 'alias' }, meta);
  assert.equal(missingAlias.ok, false);
  if (!missingAlias.ok) assert.equal(missingAlias.error.code, 'alias_required');

  const strayAlias = createCorroboration({ ...base, visibility: 'public', aliasId: 'alias_1' }, meta);
  assert.equal(strayAlias.ok, false);
  if (!strayAlias.ok) assert.equal(strayAlias.error.code, 'alias_not_permitted');
});

test('no_match is not a relationship a person can claim', () => {
  const result = createCorroboration({ ...base, relationship: 'no_match' }, meta);
  assert.equal(result.ok, false, 'no_match is a matching outcome, not a claim');
  if (!result.ok) assert.equal(result.error.code, 'invalid_relationship');
});

test('retraction withdraws the claim without destroying the record', () => {
  const corroboration = expect(createCorroboration(base, meta), 'create');
  const retracted = expect(retractCorroboration(corroboration, 3_000), 'retract');

  assert.equal(retracted.status, 'retracted');
  assert.equal(retracted.retractedAt, 3_000);
  assert.equal(retracted.id, corroboration.id, 'the record survives so aggregates recompute');

  // Retracting twice is a no-op, so a retry cannot corrupt the count.
  assert.deepEqual(expect(retractCorroboration(retracted, 4_000), 'again'), retracted);
});

test('a removed corroboration cannot be retracted', () => {
  const removed: Corroboration = { ...expect(createCorroboration(base, meta), 'c'), status: 'removed' };
  const result = retractCorroboration(removed, 3_000);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'already_removed');
});

// ── Share is a different thing entirely ─────────────────────────────────
test('a share carries no claim and has its own type', () => {
  const share = expect(
    createShare({ experienceId: 'exp_1', actorId: 'actor_other', destination: 'copy_link' }, { id: 'shr_1', now: 5_000 }),
    'share',
  );
  assert.equal(share.experienceId, 'exp_1');
  assert.equal(share.destination, 'copy_link');
  // The share shape has no corroboration vocabulary at all.
  assert.equal('type' in share, false, 'a share has no corroboration type');
  assert.equal('relationship' in share, false, 'a share makes no claim about the experience');
  assert.equal('narrative' in share, false);
});

test('a share may be anonymous, and may be repeated', () => {
  const first = expect(createShare({ experienceId: 'exp_1' }, { id: 'shr_1', now: 1 }), 'anon share');
  assert.equal(first.actorId, undefined, 'a visitor can share without an account');

  const again = expect(createShare({ experienceId: 'exp_1', actorId: 'a' }, { id: 'shr_2', now: 2 }), 'again');
  assert.notEqual(again.id, first.id, 'sharing repeatedly is legitimate');
});

test('an unsupported share destination is refused', () => {
  const result = createShare(
    { experienceId: 'exp_1', destination: 'carrier_pigeon' },
    { id: 'shr_1', now: 1 },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'invalid_share_destination');
});
