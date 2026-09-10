import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { eq } from '../../src/ports/store.ts';
import {
  clusterConfidenceFor,
  confidenceAcceptsACommand,
  confidenceBoundaryFor,
  confidenceFor,
  confidenceHistoryFor,
  confidenceInputFor,
  deriveConfidenceSeries,
  recordConfidencePoint,
} from '../../src/engines/confidence.engine.ts';
import {
  qualityAcceptsACommand,
  recurrenceCountFor,
  reliabilityFor,
  reliabilityLeaderboard,
  resolutionQualityFor,
  responseQualityFor,
} from '../../src/engines/quality.engine.ts';
import { CONFIDENCE_PERSON_FLOOR } from '../../src/domain/confidence.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { ConfidencePointRow, CorroborationRow } from '../../src/ports/store.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { CorroborateResult } from '../../src/engines/corroboration.engine.ts';
import type { ReportResolutionResult } from '../../src/engines/resolution.engine.ts';
import type { RespondResult } from '../../src/engines/organization.engine.ts';

/**
 * Phases 81–85 through the store.
 *
 * The unit tests hold the band rules. What is here is everything that only exists once the
 * reads touch rows, and every one of these is a way the same rules could be true in the
 * domain module and false in practice:
 *
 *   - **people, not rows** — six claims from one account must move confidence exactly as
 *     far as one claim does, which the domain function cannot check because it is handed a
 *     count somebody else computed;
 *   - **a removed member supports nothing** — a cluster read must re-check each experience,
 *     not trust the membership row;
 *   - **a response that describes a fix is not the same as one that does not**, which needs
 *     the real `RESPONSE_KINDS` vocabulary rather than the one I first assumed;
 *   - **resolved and well-resolved are two facts** carried side by side out of a real
 *     resolution;
 *   - **the series is replay-safe** because nothing in it increments.
 */
const setUp = async (h: EngineHarness): Promise<void> => {
  await h.engine.store.entities.put({
    id: 'ent_northwind',
    name: 'Northwind Air',
    slug: 'northwind-air',
    kind: 'organization',
  });
  await h.engine.store.categories.put({
    id: 'cat_shopping',
    name: 'Shopping & service',
    slug: 'shopping-service',
  });
  await h.engine.store.issueTypes.put({
    id: 'iss_refund',
    categoryId: 'cat_shopping',
    name: 'Refund not processed',
    slug: 'refund-not-processed',
  });
};

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

const publish = async (
  h: EngineHarness,
  actor: ActorContext,
  bodyText: string,
  category = 'Shopping & service',
): Promise<string> => {
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'text', category, bodyText, visibility: 'public' },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();
  return created.experienceId;
};

const confirmEntity = async (
  h: EngineHarness,
  actor: ActorContext,
  experienceId: string,
): Promise<void> => {
  expect(
    await h.engine.bus.dispatch({
      name: 'normalization.confirm',
      input: {
        experienceId,
        fields: { entity: 'ent_northwind', category: 'cat_shopping', issueType: 'iss_refund' },
      },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'confirm',
  );
  await h.settle();
};

const corroborate = async (
  h: EngineHarness,
  actor: ActorContext,
  experienceId: string,
): Promise<void> => {
  expect(
    await h.engine.bus.dispatch<unknown, CorroborateResult>({
      name: 'corroboration.create',
      input: { experienceId, type: 're_rage' },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'corroborate',
  );
  await h.settle();
};

/**
 * Write a corroboration row directly, bypassing the one-per-person rule.
 *
 * Deliberately not through the bus: the command correctly refuses a second claim from the
 * same account, and what is under test is whether the *read* also refuses to be fooled by
 * rows that got there some other way — a backfill, a repaired duplicate, a bug. A read that
 * relies on a command's uniqueness check for its trust primitive is one migration away from
 * being wrong.
 */
const forceClaim = async (
  h: EngineHarness,
  experienceId: string,
  corroboratorId: string,
  id: string,
): Promise<void> => {
  await h.engine.store.corroborations.put({
    id,
    experienceId,
    corroboratorId,
    type: 're_rage',
    relationship: 'same_experience',
    visibility: 'public',
    status: 'active',
    correlationId: `cor-${id}`,
    createdAt: h.clock.now(),
  });
};

const report = async (
  h: EngineHarness,
  actor: ActorContext,
  experienceId: string,
  kind: string,
): Promise<void> => {
  expect(
    await h.engine.bus.dispatch<unknown, ReportResolutionResult>({
      name: 'resolution.report',
      input: { experienceId, kind },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    `report ${kind}`,
  );
  await h.settle();
};

const respond = async (
  h: EngineHarness,
  actor: ActorContext,
  experienceId: string,
  kind: string,
  body: string,
): Promise<void> => {
  expect(
    await h.engine.bus.dispatch<unknown, RespondResult>({
      name: 'organization.respond',
      input: { organizationId: 'org_northwind', experienceId, kind, body },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    `respond ${kind}`,
  );
  await h.settle();
};

// ── Phase 81: people, not rows ───────────────────────────────────────────
test('six claims from one account are one person, and the read says so', async () => {
  // **The defect this test exists for.** `counters.corroboratorCount` counts rows, and it is
  // the obvious field to reach for. If confidence read it, one determined account would
  // manufacture `strong` on its own — the single worst failure available to this phase,
  // because the number it corrupts is the one the whole product means by trust.
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const other = await h.signUp('other@example.com');
  const experienceId = await publish(h, author.actor, 'My bag was lost again on the same route.');

  await corroborate(h, other.actor, experienceId);
  for (let n = 0; n < 5; n += 1) {
    await forceClaim(h, experienceId, other.auth.actorId, `dupe-${n}`);
  }

  const input = await confidenceInputFor(h.engine, experienceId);
  assert.ok(input);
  assert.equal(input.independentPeople, 1, 'six rows, one person');
  assert.equal(input.duplicateRows, 5, 'and it says how many it discarded');

  const confidence = await confidenceFor(h.engine, experienceId);
  assert.equal(confidence?.band, 'insufficient', 'one person is below the floor');
  assert.equal(confidence?.discarded.duplicates, 5);
});

test('an author cannot corroborate their way to confidence', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'My bag was lost again on the same route.');
  for (let n = 0; n < 4; n += 1) {
    await forceClaim(h, experienceId, author.auth.actorId, `self-${n}`);
  }

  const input = await confidenceInputFor(h.engine, experienceId);
  assert.equal(input?.independentPeople, 0, 'the author is not an independent person');
  assert.equal(input?.selfContributions, 4, 'counted, and counted separately');
  assert.equal((await confidenceFor(h.engine, experienceId))?.band, 'insufficient');
});

test('the floor is the number of people, and clearing it is what moves the band', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'My bag was lost again on the same route.');

  for (let n = 0; n < CONFIDENCE_PERSON_FLOOR - 1; n += 1) {
    const person = await h.signUp(`p${n}@example.com`);
    await corroborate(h, person.actor, experienceId);
  }
  assert.equal(
    (await confidenceFor(h.engine, experienceId))?.band,
    'insufficient',
    'one short of the floor is still insufficient, not nearly-moderate',
  );

  const last = await h.signUp('last@example.com');
  await corroborate(h, last.actor, experienceId);
  const cleared = await confidenceFor(h.engine, experienceId);
  assert.equal(cleared?.independentPeople, CONFIDENCE_PERSON_FLOOR);
  assert.notEqual(cleared?.band, 'insufficient', 'and the floor is what moved it');
});

test('a corroboration that was retracted stops supporting confidence', async () => {
  // Retraction is somebody saying they were wrong. A read that counted retracted rows would
  // make a withdrawal cost nothing, which is the same as not offering one.
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'My bag was lost again on the same route.');
  const people = [];
  for (let n = 0; n < CONFIDENCE_PERSON_FLOOR; n += 1) {
    const person = await h.signUp(`p${n}@example.com`);
    await corroborate(h, person.actor, experienceId);
    people.push(person);
  }
  assert.equal((await confidenceFor(h.engine, experienceId))?.independentPeople, CONFIDENCE_PERSON_FLOOR);

  const claims = await h.engine.store.corroborations.query([
    eq<CorroborationRow>('experienceId', experienceId),
  ]);
  const first = claims[0];
  assert.ok(first);
  await h.engine.store.corroborations.put({ ...first, status: 'retracted' });

  const after = await confidenceFor(h.engine, experienceId);
  assert.equal(after?.independentPeople, CONFIDENCE_PERSON_FLOOR - 1);
  assert.equal(after?.band, 'insufficient', 'and the band falls back below the floor');
});

test('a cluster member whose experience was removed supports no confidence', async () => {
  // Phase 71's rule, applied to trust rather than to discovery: a membership row is a cache.
  // Here the consumer deliberately does not run, so the row still says the member is there.
  const h = createEngineHarness();
  const first = await h.signUp('first@example.com');
  const second = await h.signUp('second@example.com');
  const third = await h.signUp('third@example.com');
  const a = await publish(h, first.actor, 'My bag was lost again on the same route.');
  const b = await publish(h, second.actor, 'My bag was lost again on the same route.');
  const c = await publish(h, third.actor, 'My bag was lost again on the same route.');

  await h.engine.store.clusters.put({
    id: 'clu_1',
    kind: 'rage',
    entityId: 'ent_northwind',
    issueTypeId: 'iss_refund',
    headline: 'Refunds not processed',
    totalExperiences: 3,
    corroborations: 0,
    uniqueExperiencers: 3,
    createdAt: h.clock.now(),
    updatedAt: h.clock.now(),
  });
  for (const [index, experienceId] of [a, b, c].entries()) {
    await h.engine.store.clusterMembers.put({
      id: `mem-${index}`,
      clusterId: 'clu_1',
      experienceId,
      relationship: 'same_experience',
      score: 1,
      factors: {},
    });
  }

  const before = await clusterConfidenceFor(h.engine, 'clu_1');
  assert.equal(before?.independentPeople, 3, 'three authors, three people');

  const removed = await h.engine.store.experiences.get(c);
  assert.ok(removed);
  await h.engine.store.experiences.put({ ...removed, status: 'removed' });
  // No settle(): the membership row is untouched, which is the point.
  assert.equal(
    (await h.engine.store.clusterMembers.query([eq('clusterId', 'clu_1')])).length,
    3,
    'the membership row still says three',
  );

  const after = await clusterConfidenceFor(h.engine, 'clu_1');
  assert.equal(after?.independentPeople, 2, 'and the read counts two anyway');
});

// ── Phase 82: the series ─────────────────────────────────────────────────
test('a confidence point is written once, and a replay writes nothing', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'My bag was lost again on the same route.');
  const confidence = await confidenceFor(h.engine, experienceId);
  assert.ok(confidence);

  const at = h.clock.now();
  assert.equal(await recordConfidencePoint(h.engine, { id: experienceId, kind: 'experience' }, confidence, at), true);
  assert.equal(
    await recordConfidencePoint(h.engine, { id: experienceId, kind: 'experience' }, confidence, at),
    false,
    'the same boundary a second time is absorbed, not duplicated',
  );
  assert.equal((await confidenceHistoryFor(h.engine, experienceId)).length, 1);
});

test('the series is derivable in any order and comes out the same', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'My bag was lost again on the same route.');
  for (let n = 0; n < CONFIDENCE_PERSON_FLOOR; n += 1) {
    const person = await h.signUp(`p${n}@example.com`);
    await corroborate(h, person.actor, experienceId);
  }

  const now = h.clock.now();
  const boundaries = [now - 20_000, now - 10_000, now];
  const forwards = await deriveConfidenceSeries(h.engine, experienceId, boundaries);
  const backwards = await deriveConfidenceSeries(h.engine, experienceId, [...boundaries].reverse());
  assert.deepEqual(forwards, backwards, 'each point is computed from the whole set as of its boundary');
  assert.equal(forwards.length, 3);
});

test('the recorded series carries the band and the deciding reason, and no actor', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'My bag was lost again on the same route.');
  const confidence = await confidenceFor(h.engine, experienceId);
  assert.ok(confidence);
  await recordConfidencePoint(h.engine, { id: experienceId, kind: 'experience' }, confidence, h.clock.now());

  const [point] = await confidenceHistoryFor(h.engine, experienceId);
  assert.ok(point);
  assert.equal(point.band, confidence.band);
  assert.ok(point.deciding.length > 0, 'why it landed there, in words');
  assert.equal(point.independentPeople, confidence.independentPeople, 'people, carried through');
  const keys = Object.keys(point satisfies ConfidencePointRow);
  assert.equal(
    keys.some((key) => /actor|corroborator|author/i.test(key)),
    false,
    'a series keyed to people would be a reputation history under another name',
  );
});

test('a corroboration writes the day into the series, and a replay writes nothing more', async () => {
  // The consumer is what makes the table alive rather than theoretical. Without it
  // `confidence_points` would only ever be written by a test.
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const other = await h.signUp('other@example.com');
  const experienceId = await publish(h, author.actor, 'My bag was lost again on the same route.');
  assert.deepEqual(await confidenceHistoryFor(h.engine, experienceId), [], 'nothing yet');

  await corroborate(h, other.actor, experienceId);
  const [first] = await confidenceHistoryFor(h.engine, experienceId);
  assert.ok(first, 'the claim wrote a point');
  assert.equal(first.at, confidenceBoundaryFor(h.clock.now()), 'bucketed to the day');
  assert.equal(first.independentPeople, 1);

  // A second person the same day: the boundary is the same, so the day's point is already
  // there and `compareAndSet` on absence absorbs the write rather than rewriting history.
  const third = await h.signUp('third@example.com');
  await corroborate(h, third.actor, experienceId);
  const sameDay = await confidenceHistoryFor(h.engine, experienceId);
  assert.equal(sameDay.length, 1, 'one point per day, not one per claim');
  assert.equal(sameDay[0]?.independentPeople, 1, 'and the first write stands — append-only');

  // The next day is a new boundary, so the movement becomes visible.
  h.clock.advance(2 * 24 * 60 * 60 * 1000);
  const fourth = await h.signUp('fourth@example.com');
  await corroborate(h, fourth.actor, experienceId);
  const series = await confidenceHistoryFor(h.engine, experienceId);
  assert.equal(series.length, 2);
  assert.equal(series[1]?.independentPeople, 3, 'three people by then');
  assert.equal(series[0]!.at < series[1]!.at, true, 'oldest first');
});

test('a share moves nothing in the series, because a share is not a claim', async () => {
  // `ExperienceShared` is delivered to the corroboration consumer, which maintains a share
  // count. Subscribing to it here would have made amplification move a trust figure.
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const sharer = await h.signUp('sharer@example.com');
  const experienceId = await publish(h, author.actor, 'My bag was lost again on the same route.');

  expect(
    await h.engine.bus.dispatch({
      name: 'share.create',
      input: { experienceId, destination: 'copy_link' },
      actor: sharer.actor,
      idempotencyKey: h.nextKey(),
    }),
    'share',
  );
  await h.settle();
  assert.deepEqual(
    await confidenceHistoryFor(h.engine, experienceId),
    [],
    'no point, because nothing about the claims changed',
  );
});

// ── Phase 83: reliability ────────────────────────────────────────────────
test('reliability is withheld below the floor rather than reading as unreliable', async () => {
  // `INSUFFICIENT_DATA` and "unreliable" are opposite statements and the second is
  // defamatory. This is the same rule as every other measure in the codebase, applied to the
  // one subject where getting it wrong is a claim about a person.
  const h = createEngineHarness();
  const newcomer = await h.signUp('newcomer@example.com');
  const reliability = await reliabilityFor(h.engine, newcomer.auth.actorId);
  assert.equal(reliability.contributions, 0);
  assert.equal(reliability.band.withheld, true);
});

test('reliability reads what happened to a contribution, never a trust score', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  await publish(h, author.actor, 'My bag was lost again on the same route.');
  // Three of somebody else's accounts, corroborated by the author. Corroborating your own is
  // refused by the command, correctly, so the contributions have to be somebody else's.
  for (let n = 0; n < 3; n += 1) {
    const other = await h.signUp(`p${n}@example.com`);
    const theirs = await publish(h, other.actor, `Account ${n} of the same thing.`);
    await corroborate(h, author.actor, theirs);
  }

  // A trust assessment exists and says something unflattering. Reliability must not see it.
  await h.engine.store.trustAssessments.put({
    id: `trust-${author.auth.actorId}`,
    actorId: author.auth.actorId,
    // Deliberately the worst figures the row can hold. If reliability read any of them, this
    // contributor would not come out `good`.
    accountConfidence: 0,
    contributionConfidence: 0,
    evidenceConfidence: 0,
    riskFlags: ['suspected_coordination'],
    updatedAt: h.clock.now(),
  });
  for (let n = 0; n < 4; n += 1) {
    await publish(h, author.actor, `Another account ${n}.`);
  }

  const reliability = await reliabilityFor(h.engine, author.auth.actorId);
  assert.equal(reliability.contributions, 8, 'five published, three corroborated');
  assert.equal(reliability.band.withheld, false, 'eight contributions clears the floor');
  assert.equal(
    reliability.band.withheld === false && reliability.band.value,
    'good',
    'nothing they contributed was overturned, and the low trust band did not reach this',
  );
  assert.equal(reliability.overturned, 0);
  assert.deepEqual(reliability.reasons, ['nothing they have contributed has been overturned']);
});

test('a removal and an upheld dispute are what "did not hold up" means', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const ids: string[] = [];
  for (let n = 0; n < 6; n += 1) ids.push(await publish(h, author.actor, `Account ${n}.`));

  const first = await h.engine.store.experiences.get(ids[0] as string);
  assert.ok(first);
  await h.engine.store.experiences.put({ ...first, status: 'removed' });
  await h.engine.store.disputes.put({
    id: 'dis_1',
    experienceId: ids[1] as string,
    origin: 'organization',
    raisedBy: 'org-staff',
    organizationId: 'org_northwind',
    reason: 'account_inaccurate',
    detail: 'This is not what happened.',
    status: 'upheld',
    correlationId: 'cor-dis',
    createdAt: h.clock.now(),
    updatedAt: h.clock.now(),
  });

  const reliability = await reliabilityFor(h.engine, author.auth.actorId);
  assert.equal(reliability.overturned, 2);
  assert.equal(reliability.reasons.length, 2, 'and it names both');
  assert.equal(
    reliability.band.withheld === false && reliability.band.value,
    'mixed',
    'two overturned outcomes is mixed, not poor',
  );
});

test('there is no way to order contributors against each other', () => {
  assert.equal(reliabilityLeaderboard(), undefined);
});

// ── Phase 84: response quality ───────────────────────────────────────────
test('an acknowledgement is not an action, and the real response vocabulary decides which', async () => {
  // **The defect this test exists for.** I first wrote `actionDescribed` against response
  // kinds — `fix_described`, `resolution_published` — that do not exist in `RESPONSE_KINDS`,
  // so the count would have been permanently zero and no organization could ever have read
  // as `good`. It now reuses `PROPOSAL_RESPONSE_KINDS`, and this asserts both directions.
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const staff = await h.signUp('staff@northwind.example');
  await claimedOrganization(h, staff.auth.actorId);

  const acknowledgedOnly = await publish(h, author.actor, 'My refund was never processed.');
  await confirmEntity(h, author.actor, acknowledgedOnly);
  await h.engine.store.organizationCases.put({
    id: 'case_1',
    organizationId: 'org_northwind',
    experienceId: acknowledgedOnly,
    state: 'in_progress',
    openedAt: h.clock.now(),
    updatedAt: h.clock.now(),
    correlationId: 'cor-case-1',
  });
  await respond(h, staff.actor, acknowledgedOnly, 'acknowledge', 'We have received this.');

  const positionOnly = await responseQualityFor(h.engine, 'org_northwind');
  assert.equal(positionOnly.sampleSize, 1);
  assert.notEqual(positionOnly.band, 'good', 'acknowledged and nothing done is never good');

  const fixed = await publish(h, author.actor, 'My second refund was never processed either.');
  await confirmEntity(h, author.actor, fixed);
  await h.engine.store.organizationCases.put({
    id: 'case_2',
    organizationId: 'org_northwind',
    experienceId: fixed,
    state: 'closed',
    openedAt: h.clock.now(),
    updatedAt: h.clock.now(),
    closedAt: h.clock.now(),
    closureNote: 'Refund issued.',
    correlationId: 'cor-case-2',
  });
  await respond(h, staff.actor, fixed, 'publish_resolution', 'The refund has been issued.');

  const withAction = await responseQualityFor(h.engine, 'org_northwind');
  assert.equal(withAction.sampleSize, 2);
  assert.equal(
    withAction.reasons.some(
      (reason) => reason.dimension === 'action_described' && reason.direction === 'raises',
    ),
    true,
    'and a described fix is recognised as one',
  );
});

test('a recurrence after a claimed resolution is counted, and a removed one is not', async () => {
  // The most informative quality signal available, and the one an organization's own
  // reporting cannot contain: it did not work.
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const laterOne = await h.signUp('later@example.com');
  const laterTwo = await h.signUp('later2@example.com');
  const original = await publish(h, author.actor, 'My refund was never processed.');

  await report(h, author.actor, original, 'resolved_for_me');
  h.clock.advance(60_000);
  const again = await publish(h, laterOne.actor, 'My refund was never processed.');
  const alsoAgain = await publish(h, laterTwo.actor, 'My refund was never processed.');

  await h.engine.store.clusters.put({
    id: 'clu_1',
    kind: 'rage',
    entityId: 'ent_northwind',
    issueTypeId: 'iss_refund',
    headline: 'Refunds not processed',
    totalExperiences: 3,
    corroborations: 0,
    uniqueExperiencers: 3,
    createdAt: h.clock.now(),
    updatedAt: h.clock.now(),
  });
  for (const [index, experienceId] of [original, again, alsoAgain].entries()) {
    await h.engine.store.clusterMembers.put({
      id: `mem-${index}`,
      clusterId: 'clu_1',
      experienceId,
      relationship: 'same_experience',
      score: 1,
      factors: {},
    });
  }

  assert.equal(await recurrenceCountFor(h.engine, original), 2, 'two accounts arrived after');

  const removed = await h.engine.store.experiences.get(alsoAgain);
  assert.ok(removed);
  await h.engine.store.experiences.put({ ...removed, status: 'removed' });
  assert.equal(
    await recurrenceCountFor(h.engine, original),
    1,
    'a recurrence whose account was removed is not evidence of anything',
  );
});

test('a case with no resolution claimed has no recurrences, however many siblings it has', async () => {
  // Guards a plausible wrong version: counting every cluster sibling as a recurrence would
  // make a busy pattern look like a repeatedly-failed fix, with no fix ever claimed.
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const other = await h.signUp('other@example.com');
  const original = await publish(h, author.actor, 'My refund was never processed.');
  const sibling = await publish(h, other.actor, 'My refund was never processed.');
  await h.engine.store.clusters.put({
    id: 'clu_1',
    kind: 'rage',
    entityId: 'ent_northwind',
    issueTypeId: 'iss_refund',
    headline: 'Refunds not processed',
    totalExperiences: 2,
    corroborations: 0,
    uniqueExperiencers: 2,
    createdAt: h.clock.now(),
    updatedAt: h.clock.now(),
  });
  for (const [index, experienceId] of [original, sibling].entries()) {
    await h.engine.store.clusterMembers.put({
      id: `mem-${index}`,
      clusterId: 'clu_1',
      experienceId,
      relationship: 'same_experience',
      score: 1,
      factors: {},
    });
  }
  assert.equal(await recurrenceCountFor(h.engine, original), 0, 'nothing was claimed fixed');
});

// ── Phase 85: resolved != well resolved ──────────────────────────────────
test('a resolution with an upheld dispute reads resolved and poor, both at once', async () => {
  // The shape a single status field cannot express, which is the whole reason this phase
  // exists. `statusResolved` travels beside the band rather than being replaced by it.
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'My refund was never processed.');
  await report(h, author.actor, experienceId, 'resolved_for_me');

  const clean = await resolutionQualityFor(h.engine, experienceId);
  assert.equal(clean?.statusResolved, true);

  await h.engine.store.disputes.put({
    id: 'dis_1',
    experienceId,
    origin: 'organization',
    raisedBy: 'org-staff',
    organizationId: 'org_northwind',
    reason: 'already_resolved',
    detail: 'The refund was issued in full.',
    status: 'upheld',
    correlationId: 'cor-dis',
    createdAt: h.clock.now(),
    updatedAt: h.clock.now(),
  });

  const disputed = await resolutionQualityFor(h.engine, experienceId);
  assert.equal(disputed?.statusResolved, true, 'still resolved — nobody withdrew their report');
  assert.notEqual(disputed?.band, 'good', 'and not well resolved');
});

test('resolution quality is undefined for an experience that does not exist', async () => {
  const h = createEngineHarness();
  assert.equal(await resolutionQualityFor(h.engine, 'exp_nope'), undefined);
  assert.equal(await confidenceFor(h.engine, 'exp_nope'), undefined);
  assert.equal(await clusterConfidenceFor(h.engine, 'clu_nope'), undefined);
});

test('a partial resolution is not a resolution, through real reports', async () => {
  const h = createEngineHarness();
  await setUp(h);
  const author = await h.signUp('author@example.com');
  const other = await h.signUp('other@example.com');
  const experienceId = await publish(h, author.actor, 'My refund was never processed.');
  await corroborate(h, other.actor, experienceId);
  await report(h, author.actor, experienceId, 'resolved_for_me');
  await report(h, other.actor, experienceId, 'still_unresolved');

  const quality = await resolutionQualityFor(h.engine, experienceId);
  assert.equal(quality?.statusResolved, false, 'satisfying one person is not fixing the pattern');
  assert.notEqual(quality?.band, 'good');
  assert.equal(quality?.sampleSize, 2);
});

// ── the absences ─────────────────────────────────────────────────────────
test('neither confidence nor quality accepts a command', async () => {
  const h = createEngineHarness();
  assert.equal(confidenceAcceptsACommand(), false);
  assert.equal(qualityAcceptsACommand(), false);
  const registered = h.engine.bus.registeredCommands();
  for (const name of registered) {
    assert.equal(
      /^(confidence|quality|reliability)\./.test(name),
      false,
      `${name} would let one party declare how much other people's accounts are worth`,
    );
  }
});
