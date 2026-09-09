import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExperience, publishExperience, beginValidation } from '../../src/domain/experience.ts';
import {
  ANONYMOUS_LABEL,
  findForbiddenKeys,
  resolveIdentity,
  toPublicExperience,
} from '../../src/domain/projection.ts';
import type { Alias } from '../../src/domain/identity.ts';
import { expect } from '../../src/runtime/result.ts';
import { VISIBILITIES } from '../../src/domain/types.ts';

const alias: Alias = {
  id: 'alias_1',
  actorId: 'actor_1',
  aliasName: 'quietcommuter',
  isActive: true,
  createdAt: 1_000,
};

const publish = (visibility: 'public' | 'alias' | 'anonymous') => {
  const draft = expect(
    createExperience(
      {
        actorId: 'actor_1',
        kind: 'rage',
        creationMode: 'text',
        category: 'Driving & transit',
        bodyText: 'Blocked the crosswalk.',
        visibility,
        ...(visibility === 'alias' ? { aliasId: alias.id } : {}),
      },
      { id: 'exp_1', correlationId: 'c', now: 1_000 },
    ),
    'draft',
  ).experience;
  const validated = expect(beginValidation(draft, 2_000), 'validate').experience;
  return expect(publishExperience(validated, 3_000), 'publish').experience;
};

test('no public projection contains an actor identifier, in any visibility mode', () => {
  for (const visibility of VISIBILITIES) {
    const experience = publish(visibility);
    const projection = toPublicExperience(experience, { displayName: 'Ada Lovelace', alias });
    const leaked = findForbiddenKeys(projection);
    assert.deepEqual(leaked, [], `${visibility} projection leaked ${leaked.join(', ')}`);
    assert.equal(
      JSON.stringify(projection).includes('actor_1'),
      false,
      `${visibility} projection must not contain the actor id`,
    );
  }
});

test('an anonymous experience exposes neither a name nor an alias', () => {
  const projection = toPublicExperience(publish('anonymous'), { displayName: 'Ada Lovelace', alias });
  assert.equal(projection.identity.label, ANONYMOUS_LABEL);
  assert.equal(projection.identity.kind, 'anonymous');
  const serialised = JSON.stringify(projection);
  assert.equal(serialised.includes('Ada Lovelace'), false, 'the display name must not leak');
  assert.equal(serialised.includes('quietcommuter'), false, 'the alias must not leak');
});

test('an alias experience exposes the alias handle but never the display name', () => {
  const projection = toPublicExperience(publish('alias'), { displayName: 'Ada Lovelace', alias });
  assert.equal(projection.identity.label, '@quietcommuter');
  assert.equal(JSON.stringify(projection).includes('Ada Lovelace'), false);
});

test('a public experience exposes the display name only', () => {
  const projection = toPublicExperience(publish('public'), { displayName: 'Ada Lovelace', alias });
  assert.equal(projection.identity.label, 'Ada Lovelace');
  assert.equal(JSON.stringify(projection).includes('quietcommuter'), false);
});

test('a missing alias degrades to Anonymous rather than falling back to a real name', () => {
  const identity = resolveIdentity('alias', 'Ada Lovelace', undefined);
  assert.equal(identity.label, ANONYMOUS_LABEL, 'a broken alias lookup must fail safe');
});

test('a missing display name degrades to Anonymous', () => {
  assert.equal(resolveIdentity('public', undefined, undefined).label, ANONYMOUS_LABEL);
});

test('projection ignores identity context that does not match the visibility mode', () => {
  // Passing every context field for an anonymous post must change nothing.
  const anonymous = toPublicExperience(publish('anonymous'), { displayName: 'Ada', alias, durationMs: 4_000 });
  assert.equal(anonymous.identity.label, ANONYMOUS_LABEL);
  assert.equal(anonymous.durationMs, 4_000, 'non-identity context is still projected');
});
