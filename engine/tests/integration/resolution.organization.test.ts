import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { eq } from '../../src/ports/store.ts';
import { resolutionSummaryFor } from '../../src/engines/resolution.engine.ts';
import { publicResponsesFor } from '../../src/engines/organization.engine.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { CorroborateResult } from '../../src/engines/corroboration.engine.ts';
import type { ReportResolutionResult } from '../../src/engines/resolution.engine.ts';
import type { RespondResult } from '../../src/engines/organization.engine.ts';

/**
 * Resolution and organization responses.
 *
 * Two constraints are the point of this file, and both are about who gets to say
 * what happened:
 *
 *   1. **A response is not a resolution.** An organization can acknowledge,
 *      answer or dispute. Only the people it happened to can say it was fixed.
 *   2. **`resolved` needs everyone.** Satisfying one complainant is not fixing the
 *      pattern.
 */
const setUp = async (h: EngineHarness) => {
  await h.engine.store.entities.put({
    id: 'ent_northwind',
    name: 'Northwind Air',
    slug: 'northwind-air',
    kind: 'organization',
  });
  await h.engine.store.entityAliases.put({ id: 'ali_1', entityId: 'ent_northwind', alias: 'Northwind Air' });
  await h.engine.store.categories.put({ id: 'cat_shopping', name: 'Shopping & service', slug: 'shopping-service' });
  await h.engine.store.issueTypes.put({
    id: 'iss_refund',
    categoryId: 'cat_shopping',
    name: 'Refund not processed',
    slug: 'refund-not-processed',
  });
};

/** A claimed organization with one member who may answer for it. */
const claimedOrganization = async (h: EngineHarness, actorId: string): Promise<string> => {
  await h.engine.store.organizationProfiles.put({
    id: 'org_northwind',
    entityId: 'ent_northwind',
    displayName: 'Northwind Air',
    claimedBy: actorId,
    claimedAt: h.clock.now(),
    status: 'claimed',
  });
  await h.engine.store.organizationMemberships.put({
    id: 'mem_1',
    organizationId: 'org_northwind',
    actorId,
    role: 'admin',
    grantedAt: h.clock.now(),
  });
  return 'org_northwind';
};

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

const confirmEntity = async (h: EngineHarness, actor: ActorContext, experienceId: string): Promise<void> => {
  expect(
    await h.engine.bus.dispatch({
      name: 'normalization.confirm',
      input: { experienceId, fields: { entity: 'ent_northwind', category: 'cat_shopping', issueType: 'iss_refund' } },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'confirm',
  );
  await h.settle();
};

const corroborate = (h: EngineHarness, actor: ActorContext, experienceId: string) =>
  h.engine.bus.dispatch<unknown, CorroborateResult>({
    name: 'corroboration.create',
    input: { experienceId, type: 're_rage' },
    actor,
    idempotencyKey: h.nextKey(),
  });

const report = (h: EngineHarness, actor: ActorContext, experienceId: string, kind: string) =>
  h.engine.bus.dispatch<unknown, ReportResolutionResult>({
    name: 'resolution.report',
    input: { experienceId, kind },
    actor,
    idempotencyKey: h.nextKey(),
  });

const respond = (h: EngineHarness, actor: ActorContext, input: Record<string, unknown>) =>
  h.engine.bus.dispatch<unknown, RespondResult>({
    name: 'organization.respond',
    input: { organizationId: 'org_northwind', ...input },
    actor,
    idempotencyKey: h.nextKey(),
  });

// ── A response is not a resolution ───────────────────────────────────────
test('an organization can respond, and responding resolves nothing', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const staff = await h.signUp('staff@northwind.example');
  await claimedOrganization(h, staff.auth.actorId);

  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  await confirmEntity(h, author.actor, experienceId);

  const result = expect(await respond(h, staff.actor, { experienceId, kind: 'respond', body: 'We are looking into this.' }), 'respond');
  await h.settle();

  const summary = await resolutionSummaryFor(h.engine, experienceId);
  assert.equal(summary?.organizationResponded, true, 'the response is recorded');
  assert.notEqual(summary?.status, 'resolved', 'and it did not resolve anything');
  assert.equal(summary?.reporters, 0, 'nobody has said whether it was fixed');
  assert.notEqual(result.resolutionStatus, 'resolved');
});

test('publish_resolution records the organization’s account without resolving', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const staff = await h.signUp('staff@northwind.example');
  await claimedOrganization(h, staff.auth.actorId);
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  await confirmEntity(h, author.actor, experienceId);

  const result = expect(
    await respond(h, staff.actor, {
      experienceId,
      kind: 'publish_resolution',
      body: 'The refund was issued on Tuesday and the process has been changed.',
    }),
    'respond',
  );
  await h.settle();

  assert.notEqual(
    result.resolutionStatus,
    'resolved',
    'an organization saying it fixed something is not the same as it being fixed',
  );
  const summary = await resolutionSummaryFor(h.engine, experienceId);
  assert.notEqual(summary?.status, 'resolved');
  // But the account itself is published, so a viewer can read it.
  const responses = await publicResponsesFor(h.engine, { experienceId });
  assert.equal(responses.length, 1);
  assert.match(responses[0]?.body ?? '', /refund was issued/);
});

test('an organization may acknowledge, review and dispute — and nothing further', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const staff = await h.signUp('staff@northwind.example');
  await claimedOrganization(h, staff.auth.actorId);

  for (const [kind, expected] of [
    ['acknowledge', 'acknowledged'],
    ['dispute', 'disputed'],
  ] as const) {
    const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
    await confirmEntity(h, author.actor, experienceId);
    const result = expect(await respond(h, staff.actor, { experienceId, kind, body: 'Our position on this.' }), kind);
    assert.equal(result.resolutionStatus, expected, `${kind} moves the outcome to ${expected}`);
  }
});

test('a dispute records the organization’s account beside the experience, never over it', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const staff = await h.signUp('staff@northwind.example');
  await claimedOrganization(h, staff.auth.actorId);
  const body = 'Northwind Air never processed my refund.';
  const experienceId = await publish(h, author.actor, body);
  await confirmEntity(h, author.actor, experienceId);

  expect(await respond(h, staff.actor, { experienceId, kind: 'dispute', body: 'Our records show a refund was sent.' }), 'dispute');
  await h.settle();

  const experience = await h.engine.store.experiences.get(experienceId);
  assert.equal(experience?.bodyText, body, 'the experience text is untouched');
  assert.equal(experience?.status, 'published', 'and it is still published');
  const feedEntry = await h.engine.store.feedEntries.get(experienceId);
  assert.ok(feedEntry, 'and still on the feed');
  assert.equal(feedEntry?.suppressed, false, 'a dispute is not a suppression');
});

test('an organization has no path to hide, remove or edit an experience', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const staff = await h.signUp('staff@northwind.example');
  await claimedOrganization(h, staff.auth.actorId);
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  await confirmEntity(h, author.actor, experienceId);

  const commands: readonly { name: string; input: Record<string, unknown> }[] = [
    { name: 'experience.hide', input: { experienceId } },
    { name: 'creator.deleteExperience', input: { experienceId } },
    { name: 'experience.update', input: { experienceId, bodyText: 'Nothing happened.' } },
  ];
  for (const command of commands) {
    const refused = await h.engine.bus.dispatch({
      ...command,
      actor: staff.actor,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(refused.ok, false, `${command.name} must be refused for an organization`);
  }

  const experience = await h.engine.store.experiences.get(experienceId);
  assert.equal(experience?.status, 'published');
  assert.match(experience?.bodyText ?? '', /never processed my refund/);
});

test('an organization cannot answer an experience about somebody else', async () => {
  const h = createEngineHarness();
  await setUp(h);
  await h.engine.store.entities.put({
    id: 'ent_southgale',
    name: 'Southgale Rail',
    slug: 'southgale-rail',
    kind: 'organization',
  });
  const author = await h.signUp('author@example.com');
  const staff = await h.signUp('staff@northwind.example');
  await claimedOrganization(h, staff.auth.actorId);

  const experienceId = await publish(h, author.actor, 'The refund never arrived after three weeks.');
  expect(
    await h.engine.bus.dispatch({
      name: 'normalization.confirm',
      input: { experienceId, fields: { entity: 'ent_southgale' } },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'confirm',
  );

  const refused = await respond(h, staff.actor, { experienceId, kind: 'respond', body: 'Not ours.' });
  assert.equal(refused.ok === false && refused.error.code, 'not_your_entity');
});

test('a pending claim confers no right to respond', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const claimant = await h.signUp('claimant@northwind.example');

  const claimed = expect(
    await h.engine.bus.dispatch<unknown, { organizationId: string; status: string }>({
      name: 'organization.claim',
      input: { entityId: 'ent_northwind', displayName: 'Northwind Air' },
      actor: claimant.actor,
      idempotencyKey: h.nextKey(),
    }),
    'claim',
  );
  assert.equal(claimed.status, 'pending', 'claiming is a request, not a grant');

  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  await confirmEntity(h, author.actor, experienceId);

  const refused = await h.engine.bus.dispatch({
    name: 'organization.respond',
    input: { organizationId: claimed.organizationId, experienceId, kind: 'respond', body: 'Hello.' },
    actor: claimant.actor,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(refused.ok === false && refused.error.code, 'not_an_organization_member');
});

test('a request for information is private; other responses are public', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const staff = await h.signUp('staff@northwind.example');
  await claimedOrganization(h, staff.auth.actorId);
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  await confirmEntity(h, author.actor, experienceId);

  const priv = expect(
    await respond(h, staff.actor, { experienceId, kind: 'request_information', body: 'What was the booking reference?' }),
    'private',
  );
  assert.equal(priv.isPublic, false);
  expect(await respond(h, staff.actor, { experienceId, kind: 'respond', body: 'We have refunded this.' }), 'public');

  const responses = await publicResponsesFor(h.engine, { experienceId });
  assert.equal(responses.length, 1, 'only the public response is shown');
  assert.match(responses[0]?.body ?? '', /refunded/);
});

// ── Only experiencers report, and `resolved` needs all of them ───────────
test('only the author or an active corroborator may report resolution', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const claimant = await h.signUp('claimant@example.com');
  const bystander = await h.signUp('bystander@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');

  const refused = await report(h, bystander.actor, experienceId, 'resolved_for_me');
  assert.equal(refused.ok === false && refused.error.code, 'not_an_experiencer');

  expect(await report(h, author.actor, experienceId, 'still_unresolved'), 'author may report');

  expect(await corroborate(h, claimant.actor, experienceId), 'corroborate');
  expect(await report(h, claimant.actor, experienceId, 'still_unresolved'), 'a corroborator may report');
});

test('someone who retracted their corroboration can no longer report', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const claimant = await h.signUp('claimant@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');

  const claim = expect(await corroborate(h, claimant.actor, experienceId), 'corroborate');
  expect(
    await h.engine.bus.dispatch({
      name: 'corroboration.retract',
      input: { corroborationId: claim.corroborationId },
      actor: claimant.actor,
      idempotencyKey: h.nextKey(),
    }),
    'retract',
  );

  const refused = await report(h, claimant.actor, experienceId, 'resolved_for_me');
  assert.equal(refused.ok === false && refused.error.code, 'not_an_experiencer');
});

test('one person being made whole is not the experience being resolved', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  expect(await corroborate(h, a.actor, experienceId), 'a');
  expect(await corroborate(h, b.actor, experienceId), 'b');

  const first = expect(await report(h, a.actor, experienceId, 'resolved_for_me'), 'a reports resolved');
  assert.equal(
    first.status,
    'partially_resolved',
    'one satisfied person makes it partial, not resolved',
  );

  expect(await report(h, b.actor, experienceId, 'still_unresolved'), 'b reports unresolved');
  const summary = await resolutionSummaryFor(h.engine, experienceId);
  assert.equal(summary?.status, 'partially_resolved');
  assert.equal(summary?.unresolved, 1, 'and the disagreement is visible');
});

test('resolved requires every reporter to say it was resolved for them', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const a = await h.signUp('a@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  expect(await corroborate(h, a.actor, experienceId), 'a');

  expect(await report(h, author.actor, experienceId, 'resolved_for_me'), 'author');
  const second = expect(await report(h, a.actor, experienceId, 'resolved_for_me'), 'corroborator');
  assert.equal(second.status, 'resolved');
  assert.equal(second.resolvedShare, 1);
});

test('changing your mind updates your report rather than adding one', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');

  expect(await report(h, author.actor, experienceId, 'resolved_for_me'), 'first');
  const second = expect(await report(h, author.actor, experienceId, 'still_unresolved'), 'changed mind');
  assert.equal(second.reporters, 1, 'one person, one report');
  assert.equal(second.resolvedShare, 0);

  const summary = await resolutionSummaryFor(h.engine, experienceId);
  assert.equal(summary?.unresolved, 1);
});

test('an experience can be reopened, because no outcome is final', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');

  expect(await report(h, author.actor, experienceId, 'resolved_for_me'), 'resolved');
  assert.equal((await resolutionSummaryFor(h.engine, experienceId))?.status, 'resolved');

  // It happened again.
  expect(await report(h, author.actor, experienceId, 'still_unresolved'), 'unresolved again');
  const summary = await resolutionSummaryFor(h.engine, experienceId);
  assert.notEqual(summary?.status, 'resolved', 'a resolution that stopped holding is not a resolution');
  assert.ok(summary!.history.length >= 1, 'and the history records the sequence');
});

// ── Volume is not an outcome ─────────────────────────────────────────────
test('corroboration volume moves an experience to gaining_signal and no further', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');

  for (let index = 0; index < 4; index += 1) {
    const claimant = await h.signUp(`c-${index}@example.com`);
    expect(await corroborate(h, claimant.actor, experienceId), 'corroborate');
  }
  await h.settle();

  const summary = await resolutionSummaryFor(h.engine, experienceId);
  assert.equal(summary?.status, 'gaining_signal', 'many people saying it happened is a signal');
  assert.equal(summary?.reporters, 0, 'and says nothing about whether it was fixed');
});

test('the two status axes stay independent: publication and outcome', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  expect(await report(h, author.actor, experienceId, 'resolved_for_me'), 'resolved');

  const experience = await h.engine.store.experiences.get(experienceId);
  assert.equal(experience?.status, 'published', 'publication state is unchanged by an outcome');
  assert.equal(experience?.resolutionStatus, 'resolved');
  assert.notEqual(
    experience?.status,
    experience?.resolutionStatus,
    'the two axes are separate columns and must never be read interchangeably',
  );
});

test('resolution history records who moved it and how', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const staff = await h.signUp('staff@northwind.example');
  await claimedOrganization(h, staff.auth.actorId);
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  await confirmEntity(h, author.actor, experienceId);

  expect(await respond(h, staff.actor, { experienceId, kind: 'acknowledge', body: 'We see this.' }), 'ack');
  expect(await report(h, author.actor, experienceId, 'resolved_for_me'), 'resolved');
  await h.settle();

  const summary = await resolutionSummaryFor(h.engine, experienceId);
  const sources = summary?.history.map((entry) => `${entry.source}:${entry.toStatus}`) ?? [];
  assert.ok(sources.includes('organization:acknowledged'), 'the organization acknowledged');
  assert.ok(sources.includes('experiencer:resolved'), 'and the experiencer resolved it');
  assert.equal(
    sources.some((entry) => entry.startsWith('organization:resolved')),
    false,
    'no organization-sourced resolution exists anywhere in the history',
  );
});

test('resolution reports and counters converge under duplicated delivery', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  expect(await report(h, author.actor, experienceId, 'resolved_for_me'), 'report');

  for (let round = 0; round < 3; round += 1) {
    await h.engine.outbox.append(
      [
        {
          aggregateType: 'experience',
          aggregateId: experienceId,
          eventName: 'ResolutionReported',
          payload: { experienceId, kind: 'resolved_for_me' },
        },
      ],
      `corr_dup_${round}`,
    );
    await h.settle();
  }

  assert.equal(
    await h.engine.store.resolutionReports.countWhere([eq('experienceId', experienceId)]),
    1,
    'one person, one report, however often the event is delivered',
  );
});
