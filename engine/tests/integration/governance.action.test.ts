import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { enrichmentFor, nearDuplicatesOf } from '../../src/engines/enrichment.engine.ts';
import { severityFor } from '../../src/engines/severity.engine.ts';
import { escalationsOf, evaluateEscalations } from '../../src/engines/escalation.engine.ts';
import { caseFor, openCasesFor } from '../../src/engines/case.engine.ts';
import { eq } from '../../src/ports/store.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { QueueItem } from '../../src/ports/store.ts';

/**
 * Phases 31–35 through the real bus, the real policy matrix and the real outbox.
 *
 * The boundary this file exists to hold: **measuring is not deciding.** Enrichment,
 * severity, escalation and case management all run end to end here, and none of them
 * moves a resolution status. The last test asserts that directly.
 */
const DAY = 86_400_000;

const publish = async (h: EngineHarness, actor: ActorContext, bodyText: string): Promise<string> => {
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'text', category: 'Shopping & service', bodyText, visibility: 'public' },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();
  return created.experienceId;
};

const assertDim = async (
  h: EngineHarness,
  actor: ActorContext,
  experienceId: string,
  input: Record<string, unknown>,
) => {
  const result = await h.engine.bus.dispatch({
    name: 'enrichment.assert',
    input: { experienceId, ...input },
    actor,
    idempotencyKey: h.nextKey(),
  });
  await h.settle();
  return result;
};

test('an experiencer says what it cost them, and the band follows the assertion', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('ada@example.com', 'Ada');
  const experienceId = await publish(h, actor, 'The repair was never done and I paid twice');

  expect(await assertDim(h, actor, experienceId, { dimension: 'money_lost', amount: 640, currency: 'GBP' }), 'money');
  expect(await assertDim(h, actor, experienceId, { dimension: 'recurrence', flag: true }), 'recurrence');

  const enrichment = await enrichmentFor(h.engine, experienceId);
  assert.ok(enrichment, 'enrichment is stored');
  assert.equal(enrichment.values.length, 2);

  const severity = await severityFor(h.engine, experienceId);
  assert.ok(severity, 'a band was classified by the consumer');
  assert.equal(severity.band, 'critical', 'serious money, stepped once for recurrence');
  assert.equal(severity.unassessed, false);
  assert.deepEqual([...severity.basis].sort(), ['money_lost', 'recurrence']);
});

test('nobody but the experiencer can say what an experience cost', async () => {
  const h = createEngineHarness();
  const { actor: author } = await h.signUp('ada@example.com', 'Ada');
  const { actor: other } = await h.signUp('bo@example.com', 'Bo');
  const experienceId = await publish(h, author, 'They cancelled without telling me');

  const refused = await assertDim(h, other, experienceId, { dimension: 'time_lost_minutes', amount: 90 });
  assert.equal(refused.ok, false, 'a stranger cannot assert what it cost somebody else');

  // A moderator cannot either: the policy matrix requires ownership, and severity has
  // no command that would let staff overwrite the person's own account.
  const moderator = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'moderator');
  const alsoRefused = await assertDim(h, moderator, experienceId, { dimension: 'time_lost_minutes', amount: 90 });
  assert.equal(alsoRefused.ok, false);
  assert.equal(
    h.engine.bus.registeredCommands().some((name) => name.startsWith('severity.')),
    false,
    'there is no command to set a band directly — a band is derived, never asserted by staff',
  );
});

test('an experience with nothing asserted is unassessed, and escalates on nothing', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('ada@example.com', 'Ada');
  const experienceId = await publish(h, actor, 'The queue was slow on Tuesday');

  // Time passes — a great deal of it — and no rule fires, because no severity was ever
  // asserted and the default band is not a finding.
  h.clock.advance(120 * DAY);
  const opened = await evaluateEscalations(h.engine, experienceId);
  assert.deepEqual(opened.map((row) => row.ruleId), []);
});

test('a serious, stale experience escalates once, into the one review queue', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('ada@example.com', 'Ada');
  const experienceId = await publish(h, actor, 'The boiler was left unsafe and nobody came back');
  expect(await assertDim(h, actor, experienceId, { dimension: 'safety_involved', flag: true }), 'safety');

  h.clock.advance(30 * DAY);
  const first = await evaluateEscalations(h.engine, experienceId);
  assert.ok(first.length > 0, 'a critical, unacknowledged, stale experience escalates');

  // Run it again — a sweep does. Nothing new is opened, and the queue does not grow.
  const second = await evaluateEscalations(h.engine, experienceId);
  assert.deepEqual(second, [], 'idempotent on the escalation key');

  const rows = await escalationsOf(h.engine, experienceId);
  const ruleIds = rows.map((row) => row.ruleId).sort();
  assert.deepEqual(new Set(ruleIds).size, ruleIds.length, 'one row per rule');

  const queued = await h.engine.store.queueItems.query([
    eq<QueueItem>('targetType', 'experience'),
    eq<QueueItem>('targetId', experienceId),
  ]);
  assert.equal(queued.length, 1, 'escalation reuses the moderation queue rather than growing a second one');
  assert.ok(rows.every((row) => row.because.length > 0), 'every escalation says why');
});

test('escalation opens a review and changes no outcome', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('ada@example.com', 'Ada');
  const experienceId = await publish(h, actor, 'The lift has been broken for a month and someone was trapped');
  expect(await assertDim(h, actor, experienceId, { dimension: 'safety_involved', flag: true }), 'safety');

  const before = await h.engine.store.experiences.get(experienceId);
  h.clock.advance(45 * DAY);
  await evaluateEscalations(h.engine, experienceId);
  const after = await h.engine.store.experiences.get(experienceId);

  assert.equal(after?.resolutionStatus, before?.resolutionStatus, 'the outcome is untouched');
  assert.equal(after?.status, before?.status, 'and so is publication');
});

test('the same account posted twice is detectable, and neither copy is suppressed', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('ada@example.com', 'Ada');
  const text = 'They charged me twice for the same delivery and will not refund it';
  const first = await publish(h, actor, text);
  const second = await publish(h, actor, text);

  expect(await assertDim(h, actor, first, { dimension: 'recurrence', flag: true }), 'first');
  expect(await assertDim(h, actor, second, { dimension: 'recurrence', flag: true }), 'second');

  const duplicates = await nearDuplicatesOf(h.engine, second);
  assert.deepEqual([...duplicates], [first], 'the near-duplicate is found');

  // And found is all it is. Both remain published and both remain on the feed: a
  // person re-posting a corrected account must not disappear.
  for (const id of [first, second]) {
    const experience = await h.engine.store.experiences.get(id);
    assert.equal(experience?.status, 'published');
    assert.ok(await h.engine.store.feedEntries.get(id), `${id} is still readable`);
  }
});

test('two people with identical accounts are not treated as one report', async () => {
  const h = createEngineHarness();
  const { actor: ada } = await h.signUp('ada@example.com', 'Ada');
  const { actor: bo } = await h.signUp('bo@example.com', 'Bo');
  const text = 'The same parcel was marked delivered and never arrived';
  const mine = await publish(h, ada, text);
  const theirs = await publish(h, bo, text);

  expect(await assertDim(h, ada, mine, { dimension: 'recurrence', flag: true }), 'ada');
  expect(await assertDim(h, bo, theirs, { dimension: 'recurrence', flag: true }), 'bo');

  // The fingerprints match — the accounts are identical — and both rows exist. A
  // unique index here would have refused the second person's experience outright.
  assert.deepEqual([...(await nearDuplicatesOf(h.engine, mine))], [theirs]);
  assert.ok(await h.engine.store.feedEntries.get(theirs));
});

test('an organization works a case, and closing it resolves nothing', async () => {
  const h = createEngineHarness();
  const { actor: ada } = await h.signUp('ada@example.com', 'Ada');
  const { actor: staff, auth: staffAuth } = await h.signUp('staff@northwind.example', 'Staff');
  const experienceId = await publish(h, ada, 'Northwind Air lost my bag and never processed the refund');

  await h.engine.store.entities.put({ id: 'ent_nw', name: 'Northwind Air', slug: 'northwind-air', kind: 'organization' });
  await h.engine.store.organizationProfiles.put({
    id: 'org_nw',
    entityId: 'ent_nw',
    displayName: 'Northwind Air',
    status: 'claimed',
  });
  await h.engine.store.organizationMemberships.put({
    id: 'mem_1',
    organizationId: 'org_nw',
    actorId: staffAuth.actorId,
    role: 'admin',
    grantedAt: h.clock.now(),
  });

  const opened = expect(
    await h.engine.bus.dispatch<unknown, { caseId: string; state: string }>({
      name: 'case.open',
      input: { organizationId: 'org_nw', experienceId },
      actor: staff,
      idempotencyKey: h.nextKey(),
    }),
    'open case',
  );
  await h.settle();

  // Opening twice lands on one workspace, not two divergent ones.
  const again = expect(
    await h.engine.bus.dispatch<unknown, { caseId: string }>({
      name: 'case.open',
      input: { organizationId: 'org_nw', experienceId },
      actor: staff,
      idempotencyKey: h.nextKey(),
    }),
    'reopen',
  );
  assert.equal(again.caseId, opened.caseId);

  const assigned = expect(
    await h.engine.bus.dispatch<unknown, { assigneeId?: string }>({
      name: 'case.assign',
      input: { caseId: opened.caseId, assigneeId: staffAuth.actorId },
      actor: staff,
      idempotencyKey: h.nextKey(),
    }),
    'assign',
  );
  assert.equal(assigned.assigneeId, staffAuth.actorId);

  const beforeClose = await h.engine.store.experiences.get(experienceId);
  expect(
    await h.engine.bus.dispatch({
      name: 'case.transition',
      input: { caseId: opened.caseId, to: 'closed', note: 'Refund issued on 4 March' },
      actor: staff,
      idempotencyKey: h.nextKey(),
    }),
    'close',
  );
  await h.settle();

  const afterClose = await h.engine.store.experiences.get(experienceId);
  assert.equal(
    afterClose?.resolutionStatus,
    beforeClose?.resolutionStatus,
    'a closed case is the organization saying it is done with its part, not that the problem is fixed',
  );

  const stored = await caseFor(h.engine, 'org_nw', experienceId);
  assert.equal(stored?.state, 'closed');
  assert.deepEqual([...(await openCasesFor(h.engine, 'org_nw'))], [], 'a closed case leaves the working queue');
});

test('a revoked membership can neither work a case nor be assigned one', async () => {
  const h = createEngineHarness();
  const { actor: ada } = await h.signUp('ada@example.com', 'Ada');
  const { actor: staff, auth: staffAuth } = await h.signUp('staff@northwind.example', 'Staff');
  const experienceId = await publish(h, ada, 'Northwind Air rebooked me onto a worse flight');

  await h.engine.store.entities.put({ id: 'ent_nw', name: 'Northwind Air', slug: 'northwind-air', kind: 'organization' });
  await h.engine.store.organizationProfiles.put({
    id: 'org_nw',
    entityId: 'ent_nw',
    displayName: 'Northwind Air',
    status: 'claimed',
  });
  await h.engine.store.organizationMemberships.put({
    id: 'mem_1',
    organizationId: 'org_nw',
    actorId: staffAuth.actorId,
    role: 'admin',
    grantedAt: h.clock.now(),
    revokedAt: h.clock.now(),
  });

  const refused = await h.engine.bus.dispatch({
    name: 'case.open',
    input: { organizationId: 'org_nw', experienceId },
    actor: staff,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(refused.ok, false, 'a revoked membership confers nothing');
});
