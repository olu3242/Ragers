import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guidanceFor, isBlocked } from '../../src/domain/language.ts';

/**
 * Language guidance offers an observation and never a substitution.
 *
 * The property that matters most here is what it does *not* do: it returns no
 * rewritten text, and it blocks nothing except a threat. A filter that rewrote an
 * account would put words in someone's mouth, and one that blocked on wording
 * would fall hardest on people writing in a second language or writing while
 * upset — which is most people when something has gone wrong.
 */
const draft = (text: string, namesPerson = false) =>
  guidanceFor({ text, kind: 'rage', namesPerson });

test('guidance never returns replacement text', () => {
  const guidance = draft('The staff were stupid and the refund never arrived after three weeks.');
  assert.ok(guidance.length > 0, 'there is something to say');
  for (const entry of guidance) {
    assert.equal(
      Object.keys(entry).some((key) => /replacement|rewrite|suggestedText|corrected/i.test(key)),
      false,
      'guidance carries no rewritten draft',
    );
  }
});

test('a threat blocks; nothing else does', () => {
  const threat = draft('I will find the manager who did this.');
  assert.equal(isBlocked(threat), true);
  assert.equal(threat[0]?.kind, 'threat', 'the blocking finding comes first');

  for (const text of [
    'The staff were stupid about the whole thing.',
    'They always lose bags, every single time.',
    'Bad.',
  ]) {
    assert.equal(isBlocked(draft(text)), false, `"${text}" is advised, not blocked`);
  }
});

test('an attack on the person is flagged as being about the person', () => {
  const guidance = draft('The agent was an idiot and refused to look up my booking.');
  const finding = guidance.find((entry) => entry.kind === 'attacks_the_person');
  assert.ok(finding, 'flagged');
  assert.match(finding?.message ?? '', /what they did/i, 'and it asks for the behaviour instead');
  assert.equal(finding?.blocking, false);
});

test('an ordinary account of bad behaviour is not flagged as an attack', () => {
  const guidance = draft(
    'The agent refused to look up my booking and told me to call a number that does not connect.',
  );
  assert.equal(
    guidance.some((entry) => entry.kind === 'attacks_the_person'),
    false,
    'describing genuinely bad behaviour plainly must not be treated as an attack',
  );
});

test('an absolute claim is questioned, and a specific account is not', () => {
  assert.ok(
    draft('They never answer the phone and every single time it is the same.').some(
      (entry) => entry.kind === 'absolute_claim',
    ),
  );
  assert.equal(
    draft('They did not answer the phone on Tuesday or on Wednesday morning.').some(
      (entry) => entry.kind === 'absolute_claim',
    ),
    false,
  );
});

test('a very short account is asked for detail, because recognition is what enables corroboration', () => {
  const guidance = draft('Bad service.');
  const finding = guidance.find((entry) => entry.kind === 'no_specifics');
  assert.ok(finding);
  assert.match(finding?.message ?? '', /recognise/i);
  assert.equal(finding?.blocking, false);
});

test('an empty draft produces no scolding', () => {
  assert.deepEqual(draft(''), [], 'nothing typed yet is not a mistake');
});

test('naming a person is advised here and enforced elsewhere', () => {
  const guidance = draft('Gregory Fenwick pushed in front of the whole queue.', true);
  const finding = guidance.find((entry) => entry.kind === 'names_a_person');
  assert.ok(finding);
  assert.equal(
    finding?.blocking,
    false,
    'the privacy layer routes this to review — guidance only explains why',
  );
});

test('a rave gets rave-appropriate wording, not a rage lecture', () => {
  const rave = guidanceFor({
    text: 'They always go out of their way, every single time.',
    kind: 'rave',
    namesPerson: false,
  });
  const finding = rave.find((entry) => entry.kind === 'absolute_claim');
  assert.ok(finding);
  assert.equal(
    /harder to argue with/.test(finding?.message ?? ''),
    false,
    'a positive experience is not something to be argued with',
  );
});
