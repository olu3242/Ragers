import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { eq } from '../../src/ports/store.ts';
import { discover, eligibleForViewer, searchContextually } from '../../src/engines/discovery.engine.ts';
import { discoverForActor, profileFor } from '../../src/engines/relevance.engine.ts';
import { profileIsEmpty } from '../../src/domain/relevance-profile.ts';
import {
  ELIGIBILITY_INPUTS,
  PERSONALIZATION_INPUTS,
  PERSONALIZATION_STAGES,
  decideEligibility,
  eligibilityReadsTheProfile,
  explainEligibility,
  personalizationBypassesEligibility,
  relevanceIsAPermission,
} from '../../src/domain/personalization.ts';
import {
  liveRecommendationsFor,
  memoryFor,
  memoryRanksOperators,
  memoryRecordsWhoDismissed,
  memoryRecordsWhy,
  recordOutcome,
  recordShown,
  tallyMemory,
} from '../../src/engines/memory.recommendation.ts';
import { qualityConclusionsFor, recommend } from '../../src/engines/conclusion.engine.ts';
import { confidenceFor } from '../../src/engines/confidence.engine.ts';
import { reliabilityFor, resolutionQualityFor } from '../../src/engines/quality.engine.ts';
import { createPlan, executePlan } from '../../src/engines/plan.engine.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { ExperienceKind } from '../../src/domain/types.ts';
import type { ProposalRow, RecommendationRow } from '../../src/ports/store.ts';

/**
 * Phases 86–90 — safe personalization, memory, quality recommendations, governed follow-up.
 *
 * The question this band is certified against is stronger than "does personalization work":
 * **can Ragers become personally relevant without learning to reward outrage, expose trust
 * internals, or construct hidden profiles?**
 *
 * The lap runs twice, for a Rage and again for a Rave. A system that only holds its rules for
 * complaints has not held them, and the Rave lap is where an assumption that "quality" means
 * "how badly it went" would show.
 */
interface World {
  readonly h: EngineHarness;
  readonly organizationId: string;
  readonly staff: { readonly actor: ActorContext; readonly actorId: string };
  readonly admin: ActorContext;
  readonly authors: readonly { readonly actor: ActorContext; readonly actorId: string }[];
  readonly experienceIds: readonly string[];
}

const seed = async (kind: ExperienceKind = 'rage'): Promise<World> => {
  const h = createEngineHarness();
  await h.engine.store.entities.put({ id: 'ent_1', name: 'Northwind Air', slug: 'northwind-air', kind: 'organization' });
  await h.engine.store.entityAliases.put({ id: 'ali_e1', entityId: 'ent_1', alias: 'Northwind Air' });
  await h.engine.store.categories.put({ id: 'cat_1', name: 'Shopping & service', slug: 'shopping-service' });
  await h.engine.store.issueTypes.put({
    id: 'iss_1',
    categoryId: 'cat_1',
    name: 'Refund not processed',
    slug: 'refund-not-processed',
  });

  const staffSignUp = await h.signUp('staff@example.com', 'Staff');
  const admin = await h.promote((await h.signUp('admin@example.com')).auth.actorId, 'admin');
  await h.engine.store.organizationProfiles.put({
    id: 'org_1',
    entityId: 'ent_1',
    displayName: 'Northwind Air',
    claimedBy: staffSignUp.auth.actorId,
    claimedAt: h.clock.now(),
    status: 'claimed',
  });
  await h.engine.store.organizationMemberships.put({
    id: 'mem_1',
    organizationId: 'org_1',
    actorId: staffSignUp.auth.actorId,
    role: 'admin',
    grantedAt: h.clock.now(),
  });

  const authors: { actor: ActorContext; actorId: string }[] = [];
  const experienceIds: string[] = [];
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    const person = await h.signUp(`${name}@example.com`, name);
    authors.push({ actor: person.actor, actorId: person.auth.actorId });
    const created = expect(
      await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
        name: 'experience.create',
        input: {
          kind,
          creationMode: 'text',
          category: 'Shopping & service',
          // The organization is attached by confirmation below, never named in the body:
          // the PII detector reads two capitalised words as a person name and routes the
          // experience to review, and structure comes from confirmation regardless.
          bodyText:
            kind === 'rage'
              ? `Account ${name}: the refund never arrived`
              : `Account ${name}: they fixed it the same day`,
          visibility: 'public',
        },
        actor: person.actor,
        idempotencyKey: h.nextKey(),
      }),
      'create',
    );
    await h.settle();
    expect(
      await h.engine.bus.dispatch({
        name: 'normalization.confirm',
        input: {
          experienceId: created.experienceId,
          fields: { entity: 'ent_1', category: 'cat_1', issueType: 'iss_1' },
        },
        actor: person.actor,
        idempotencyKey: h.nextKey(),
      }),
      'confirm',
    );
    await h.settle();
    experienceIds.push(created.experienceId);
  }

  return { h, organizationId: 'org_1', staff: { actor: staffSignUp.actor, actorId: staffSignUp.auth.actorId }, admin, authors, experienceIds };
};

const block = async (h: EngineHarness, actor: ActorContext, targetId: string): Promise<void> => {
  expect(
    await h.engine.bus.dispatch({
      name: 'graph.block',
      input: { targetRef: 'actor', targetId },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'block',
  );
  await h.settle();
};

// ── Phase 86: eligibility first, personalization second ──────────────────
test('a blocked author does not reach a personalized feed, or a search hit', async () => {
  // **The defect this phase found.** `isBlockedBetween` carried the comment "Consulted on
  // every read path" and was consulted on exactly one — notifications. Discovery had no viewer
  // at all, so it could ask whether an experience was published and not whether *this* person
  // was permitted to see it. Every signed-in reader who had ever blocked somebody was being
  // served that person's accounts.
  const world = await seed();
  const { h } = world;
  const viewer = world.authors[0]!;
  const blocked = world.authors[1]!;

  const before = await discoverForActor(h.engine, viewer.actorId);
  const authorsBefore = new Set<string>();
  for (const result of before) {
    authorsBefore.add((await h.engine.store.experiences.get(result.experienceId))!.actorId);
  }
  assert.equal(authorsBefore.has(blocked.actorId), true, 'visible before the block');

  await block(h, viewer.actor, blocked.actorId);

  for (const result of await discoverForActor(h.engine, viewer.actorId)) {
    const experience = await h.engine.store.experiences.get(result.experienceId);
    assert.notEqual(experience?.actorId, blocked.actorId, 'and absent after it');
  }

  // Search runs the same stage. A block honoured in the feed and not in search is a block
  // that fails the moment somebody types.
  for (const hit of await searchContextually(h.engine, { text: 'refund', viewerId: viewer.actorId })) {
    const experience = await h.engine.store.experiences.get(hit.experienceId);
    assert.notEqual(experience?.actorId, blocked.actorId, 'search too');
  }
});

test('the block runs both ways, so blocking does not become a way to be unseen selectively', async () => {
  const world = await seed();
  const { h } = world;
  const blocker = world.authors[0]!;
  const blockedPerson = world.authors[1]!;
  await block(h, blocker.actor, blockedPerson.actorId);

  // The person who was blocked also stops seeing the blocker. Symmetric as a consequence even
  // though the act was one-sided: if you blocked me, you do not want me reading your accounts.
  for (const result of await discoverForActor(h.engine, blockedPerson.actorId)) {
    const experience = await h.engine.store.experiences.get(result.experienceId);
    assert.notEqual(experience?.actorId, blocker.actorId);
  }
});

test('a guest sees the public feed, because a guest has blocked nobody', async () => {
  const world = await seed();
  const { h } = world;
  await block(h, world.authors[0]!.actor, world.authors[1]!.actorId);
  // The public read is unchanged: one person's block is not a moderation decision, and
  // applying it to everybody would let anybody hide anybody.
  assert.equal((await discover(h.engine)).length, 5, 'all five still public');
});

test('personalization cannot make an unpublished experience visible', async () => {
  const world = await seed();
  const { h } = world;
  const viewer = world.authors[0]!;
  const target = world.experienceIds[1]!;

  const experience = await h.engine.store.experiences.get(target);
  assert.ok(experience);
  await h.engine.store.experiences.put({ ...experience, status: 'removed' });
  // Deliberately no settle(): the projection still says published, so this asserts the
  // eligibility stage rather than eventual consistency.
  assert.equal(await eligibleForViewer(h.engine, viewer.actorId, { ...experience, status: 'removed' }), false);
  for (const result of await discoverForActor(h.engine, viewer.actorId)) {
    assert.notEqual(result.experienceId, target);
  }
});

test('an empty profile yields everything permitted, never nothing', async () => {
  const world = await seed();
  const { h } = world;
  const newcomer = await h.signUp('newcomer@example.com');
  const profile = await profileFor(h.engine, newcomer.auth.actorId);
  assert.equal(profileIsEmpty(profile), true);
  assert.equal(
    (await discoverForActor(h.engine, newcomer.auth.actorId)).length,
    5,
    'an empty profile is not a reason to show nothing',
  );

  // And the empty-profile path still applies the floor. This is the arm most people take, so
  // a fallback that dropped the viewer would leak for almost everybody.
  await block(h, newcomer.actor, world.authors[0]!.actorId);
  assert.equal((await discoverForActor(h.engine, newcomer.auth.actorId)).length, 4);
});

test('the two stages take disjoint inputs, so a preference is never a permission', () => {
  // If eligibility could read the profile, a person could widen their own access by declaring
  // an interest, or lose access by not declaring one. Neither is a thing a preference does.
  const overlap = ELIGIBILITY_INPUTS.filter((input) =>
    (PERSONALIZATION_INPUTS as readonly string[]).includes(input),
  );
  assert.deepEqual(overlap, []);
  assert.deepEqual(PERSONALIZATION_STAGES, ['eligibility', 'personalization', 'ordering']);
  assert.equal(personalizationBypassesEligibility(), false);
  assert.equal(eligibilityReadsTheProfile(), false);
  assert.equal(relevanceIsAPermission(), false);
});

test('an author reads their own unpublished experience, and cannot read past a block', () => {
  // The exemption is narrow on purpose: it applies to status and not to blocks.
  assert.equal(
    decideEligibility({ published: false, viewerIsAuthor: true, blockedEitherWay: false }).permitted,
    true,
  );
  const blockedAuthor = decideEligibility({
    published: true,
    viewerIsAuthor: true,
    blockedEitherWay: true,
  });
  assert.equal(blockedAuthor.permitted, false);
  assert.equal(blockedAuthor.refusedBy, 'blocked');
  assert.equal(explainEligibility(blockedAuthor), 'one of the two people has blocked the other');
});

// ── Phase 87: the memory ─────────────────────────────────────────────────
const seedRecommendation = async (h: EngineHarness, id = 'rec_1'): Promise<RecommendationRow> => {
  const row: RecommendationRow = {
    id,
    kind: 'recurring_failure',
    subjectId: 'clu_1',
    acrossExperienceIds: ['exp_a', 'exp_b'],
    distinctPeople: 3,
    lifecycleState: 'active',
    createdAt: h.clock.now(),
  };
  await h.engine.store.recommendations.put(row);
  return row;
};

test('showing a recommendation twice does not revive a dismissal', async () => {
  // The failure this guards: an operator surface that records a view on every render would
  // silently revive everything anybody had ever dismissed.
  const h = createEngineHarness();
  await seedRecommendation(h);
  await recordShown(h.engine, 'rec_1');
  expect(await recordOutcome(h.engine, { recommendationId: 'rec_1', outcome: 'dismissed' }), 'dismiss');

  await recordShown(h.engine, 'rec_1');
  assert.equal((await memoryFor(h.engine, 'rec_1'))?.outcome, 'dismissed', 'still dismissed');
  assert.equal(await h.engine.store.recommendationMemory.count(), 1, 'and still one row');
});

test('a dismissal is terminal, and acting on something requires accepting it', async () => {
  const h = createEngineHarness();
  await seedRecommendation(h);
  expect(await recordOutcome(h.engine, { recommendationId: 'rec_1', outcome: 'dismissed' }), 'dismiss');
  const revived = await recordOutcome(h.engine, { recommendationId: 'rec_1', outcome: 'accepted' });
  assert.equal(revived.ok, false, 're-offering something somebody declined is the behaviour being fixed');
  assert.equal(!revived.ok && revived.error.code, 'outcome_not_allowed');

  await seedRecommendation(h, 'rec_2');
  const unaccepted = await recordOutcome(h.engine, { recommendationId: 'rec_2', outcome: 'acted_on' });
  assert.equal(unaccepted.ok, false, 'acted on without a decision is an effect nobody chose');
});

test('a memory of something unrecommended is refused', async () => {
  const h = createEngineHarness();
  const orphan = await recordOutcome(h.engine, { recommendationId: 'rec_nope', outcome: 'dismissed' });
  assert.equal(orphan.ok, false);
  assert.equal(!orphan.ok && orphan.error.code, 'no_such_recommendation');
});

test('the memory records no operator and no reason, and offers no ranking', async () => {
  const h = createEngineHarness();
  await seedRecommendation(h);
  expect(await recordOutcome(h.engine, { recommendationId: 'rec_1', outcome: 'dismissed' }), 'dismiss');
  const row = await memoryFor(h.engine, 'rec_1');
  assert.ok(row);
  for (const key of Object.keys(row)) {
    assert.equal(/actor|operator|reviewer|by$|note|reason|why/i.test(key), false, `${key} does not belong here`);
  }
  assert.equal(memoryRecordsWhoDismissed(), false);
  assert.equal(memoryRecordsWhy(), false);
  assert.equal(memoryRanksOperators(), undefined);
});

test('a dismissed recommendation stops being offered and an accepted one keeps being', async () => {
  const h = createEngineHarness();
  await seedRecommendation(h, 'rec_1');
  await seedRecommendation(h, 'rec_2');
  await seedRecommendation(h, 'rec_3');
  assert.equal((await liveRecommendationsFor(h.engine, 'clu_1')).length, 3, 'no memory means live');

  expect(await recordOutcome(h.engine, { recommendationId: 'rec_1', outcome: 'dismissed' }), 'dismiss');
  expect(await recordOutcome(h.engine, { recommendationId: 'rec_2', outcome: 'accepted' }), 'accept');
  const live = (await liveRecommendationsFor(h.engine, 'clu_1')).map((row) => row.id).sort();
  assert.deepEqual(live, ['rec_2', 'rec_3'], 'an acceptance whose plan has not run is outstanding work');
});

// ── Phase 88: quality as an input to the existing proposal contract ──────
test('a poor response record produces a proposal, never a mutation', async () => {
  const world = await seed();
  const { h } = world;

  // Cases with responses that say nothing was done, and one aging open.
  for (const [index, experienceId] of world.experienceIds.entries()) {
    await h.engine.store.organizationCases.put({
      id: `case_${index}`,
      organizationId: 'org_1',
      experienceId,
      state: index === 0 ? 'in_progress' : 'closed',
      openedAt: h.clock.now() - 60 * 24 * 60 * 60 * 1000,
      updatedAt: h.clock.now(),
      correlationId: `cor-case-${index}`,
    });
    expect(
      await h.engine.bus.dispatch({
        name: 'organization.respond',
        input: { organizationId: 'org_1', experienceId, kind: 'acknowledge', body: 'We have received this.' },
        actor: world.staff.actor,
        idempotencyKey: h.nextKey(),
      }),
      'respond',
    );
    await h.settle();
  }

  const conclusions = await qualityConclusionsFor(h.engine, 'org_1');
  const low = conclusions.find((conclusion) => conclusion.kind === 'response_quality_low');
  assert.ok(low, 'acknowledged five times with nothing done is a conclusion worth drawing');
  assert.ok(low.basis.length > 0, 'and it points at rows a reviewer can open');
  assert.ok(low.rationale.length > 0, 'with the dimensions in words, not a score');

  const before = await h.engine.store.organizationResponses.count();
  const { row } = await recommend(h.engine, low, world.admin);
  await h.settle();
  assert.ok(row.proposalId, 'the output is a proposal');
  const proposal = await h.engine.store.proposals.get(row.proposalId);
  assert.equal(proposal?.status, 'proposed', 'awaiting a person');
  assert.equal(proposal?.proposedCommand, undefined, 'a conclusion hands a reviewer a situation');
  assert.equal(
    await h.engine.store.organizationResponses.count(),
    before,
    'and nothing in E9 changed',
  );
});

test('a quality conclusion is not drawn on a withheld measure', async () => {
  // Two cases is below the response-quality floor, so the band is withheld — and a withheld
  // band laundered through a conclusion would publish exactly what the floor refused.
  const world = await seed();
  const { h } = world;
  await h.engine.store.organizationCases.put({
    id: 'case_0',
    organizationId: 'org_1',
    experienceId: world.experienceIds[0]!,
    state: 'in_progress',
    openedAt: h.clock.now(),
    updatedAt: h.clock.now(),
    correlationId: 'cor-case-0',
  });

  const conclusions = await qualityConclusionsFor(h.engine, 'org_1');
  assert.equal(
    conclusions.some((conclusion) => conclusion.kind === 'response_quality_low'),
    false,
    'too few cases to say anything about how they were handled',
  );
});

test('one recurrence is not a pattern, and two are', async () => {
  const world = await seed();
  const { h } = world;

  // The cluster the confirmations already produced, not a second one. A competing membership
  // row is exactly what `recurrenceCountFor`'s `queryOne` would pick up arbitrarily — which is
  // how the first version of this test failed, and a fair warning about seeding a cluster by
  // hand when the pipeline has already built one.
  const cluster = (await h.engine.store.experiences.get(world.experienceIds[0]!))?.clusterId;
  assert.ok(cluster, 'the confirmations clustered these together');

  const resolveFirst = async (index: number): Promise<void> => {
    expect(
      await h.engine.bus.dispatch({
        name: 'resolution.report',
        input: { experienceId: world.experienceIds[index], kind: 'resolved_for_me' },
        actor: world.authors[index]!.actor,
        idempotencyKey: h.nextKey(),
      }),
      'report',
    );
    await h.settle();
  };

  await resolveFirst(0);
  h.clock.advance(60_000);
  // One experience with recurrences after it is one failure, not a pattern.
  assert.equal(
    (await qualityConclusionsFor(h.engine, 'org_1')).some((c) => c.kind === 'fix_did_not_hold'),
    false,
    'MINIMUM_EXPERIENCES is what tells one failure from a pattern',
  );

  await resolveFirst(1);
  h.clock.advance(60_000);
  const later = await h.signUp('later@example.com');
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: {
        kind: 'rage',
        creationMode: 'text',
        category: 'Shopping & service',
        bodyText: 'It happened again after they said it was fixed',
        visibility: 'public',
      },
      actor: later.actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();
  // Confirmed into the same cluster, the way a real recurrence arrives.
  expect(
    await h.engine.bus.dispatch({
      name: 'normalization.confirm',
      input: {
        experienceId: created.experienceId,
        fields: { entity: 'ent_1', category: 'cat_1', issueType: 'iss_1' },
      },
      actor: later.actor,
      idempotencyKey: h.nextKey(),
    }),
    'confirm the recurrence',
  );
  await h.settle();
  assert.equal(
    (await h.engine.store.experiences.get(created.experienceId))?.clusterId,
    cluster,
    'and it landed in the same cluster',
  );

  const drawn = await qualityConclusionsFor(h.engine, 'org_1');
  const held = drawn.find((conclusion) => conclusion.kind === 'fix_did_not_hold');
  assert.ok(held, 'two resolved experiences each followed by further accounts is a pattern');
  assert.equal(held.acrossExperienceIds.length >= 2, true);
});

// ── Phase 90: the lap, twice, with decision != effect asserted ───────────
for (const kind of ['rage', 'rave'] as const) {
  test(`the whole 81–90 lap holds for a ${kind}`, async () => {
    const world = await seed(kind);
    const { h } = world;
    const viewer = world.authors[0]!;

    // 1. corroboration → confidence, counting people
    for (const person of world.authors.slice(1)) {
      expect(
        await h.engine.bus.dispatch({
          name: 'corroboration.create',
          input: { experienceId: world.experienceIds[0], type: kind === 'rage' ? 're_rage' : 're_rave' },
          actor: person.actor,
          idempotencyKey: h.nextKey(),
        }),
        'corroborate',
      );
      await h.settle();
    }
    const confidence = await confidenceFor(h.engine, world.experienceIds[0]!);
    assert.equal(confidence?.independentPeople, 4, 'people, not rows');
    assert.notEqual(confidence?.band, 'insufficient', 'four people clears the floor');

    // 2. the series recorded itself, on the day boundary
    const series = await h.engine.store.confidencePoints.query([
      eq('subjectId', world.experienceIds[0]!),
    ]);
    assert.equal(series.length, 1, 'one point per day, however many claims arrived');

    // 3. a response, then the people it happened to report an outcome
    expect(
      await h.engine.bus.dispatch({
        name: 'organization.respond',
        input: {
          organizationId: 'org_1',
          experienceId: world.experienceIds[0],
          kind: 'publish_resolution',
          body: 'The refund has been issued.',
        },
        actor: world.staff.actor,
        idempotencyKey: h.nextKey(),
      }),
      'respond',
    );
    await h.settle();
    for (const person of world.authors.slice(0, 4)) {
      const isAuthorOrCorroborator = true;
      if (!isAuthorOrCorroborator) continue;
      await h.engine.bus.dispatch({
        name: 'resolution.report',
        input: { experienceId: world.experienceIds[0], kind: 'resolved_for_me' },
        actor: person.actor,
        idempotencyKey: h.nextKey(),
      });
      await h.settle();
    }

    // 4. resolved and well-resolved stay two facts
    const quality = await resolutionQualityFor(h.engine, world.experienceIds[0]!);
    assert.ok(quality);
    assert.equal(typeof quality.statusResolved, 'boolean');
    assert.equal(
      Object.hasOwn(quality, 'band') && Object.hasOwn(quality, 'statusResolved'),
      true,
      'both carried, so a surface cannot show one as the other',
    );

    // 5. reliability says something about the author, and no trust figure
    const reliability = await reliabilityFor(h.engine, viewer.actorId);
    assert.equal(reliability.contributions >= 1, true);
    for (const key of Object.keys(reliability)) {
      assert.equal(/trust|score/i.test(key), false, `${key} would be the trust score with a coat on`);
    }

    // 6. personalized discovery, eligibility first
    const personalized = await discoverForActor(h.engine, viewer.actorId);
    assert.equal(personalized.length > 0, true, 'somebody with a profile still gets a feed');
    for (const result of personalized) {
      const experience = await h.engine.store.experiences.get(result.experienceId);
      assert.equal(experience?.status, 'published', 'nothing unpublished reached the ordering');
      assert.ok(result.factors, 'and every position states its factors');
    }

    // 7. a recommendation, remembered
    const recommendation = await seedRecommendation(h, `rec_${kind}`);
    await recordShown(h.engine, recommendation.id);
    assert.equal((await memoryFor(h.engine, recommendation.id))?.outcome, 'shown');

    // 8. **decision != effect.** A plan approved by a reviewer whose steps the governed
    //    engine then refuses. The approval is real, the effect is not, and both are visible.
    const proposalCreated = expect(
      await h.engine.bus.dispatch<unknown, { proposalId: string }>({
        name: 'proposal.create',
        input: {
          proposalType: 'recurring_failure',
          sourceEngine: 'E12',
          targetEngine: 'E9',
          subjectId: 'org_1',
          summary: 'A pattern worth answering',
          rationale: 'Several people describe the same failure.',
          confidence: 0.7,
          evidenceRefs: world.experienceIds.map((id) => ({ kind: 'experience', id })),
        },
        actor: world.admin,
        idempotencyKey: h.nextKey(),
      }),
      'propose',
    );
    expect(
      await h.engine.bus.dispatch({
        name: 'proposal.decide',
        input: { proposalId: proposalCreated.proposalId, outcome: 'approved' },
        actor: world.admin,
        idempotencyKey: h.nextKey(),
      }),
      'approve',
    );
    await h.settle();

    const plan = expect(
      await createPlan(
        h.engine,
        {
          proposalId: proposalCreated.proposalId,
          steps: [
            // A case against an organization the *admin* is not a member of. Authorization is
            // evaluated per step at execution time, so this is refused with their name on it.
            { command: 'organization.respond', targetEngine: 'E9', input: { organizationId: 'org_1', experienceId: world.experienceIds[0], kind: 'acknowledge', body: 'From a plan.' } },
          ],
        },
        world.admin,
      ),
      'plan',
    );

    const executed = expect(await executePlan(h.engine, plan.id, world.admin), 'execute');
    assert.equal(executed.plan.status, 'failed', 'every step refused');
    assert.equal(executed.plan.dispatchedCount, 0);
    assert.equal(executed.outcomes[0]?.dispatched, false);
    assert.ok(executed.outcomes[0]?.error, 'and the refusal is recorded with its reason');

    const decided = await h.engine.store.proposals.get(proposalCreated.proposalId);
    assert.equal((decided as ProposalRow | undefined)?.status, 'approved', 'the decision stands');

    // The memory carries the plan, so the acceptance and the absent effect sit side by side.
    expect(
      await recordOutcome(h.engine, {
        recommendationId: recommendation.id,
        outcome: 'accepted',
        planId: plan.id,
      }),
      'accept',
    );
    const tally = await tallyMemory(h.engine);
    assert.equal(tally.accepted, 1);
    assert.equal(tally.acceptedWithNoEffect, 1, 'decision != effect, as a number');

    // 9. and a step appended after the approval is refused whole
    await h.engine.store.actionPlanSteps.put({
      id: `${plan.id}:9`,
      planId: plan.id,
      stepOrder: 9,
      command: 'organization.respond',
      input: { organizationId: 'org_1', experienceId: world.experienceIds[0], kind: 'acknowledge', body: 'Appended.' },
      targetEngine: 'E9',
      dispatched: false,
    });
    const replayed = await executePlan(h.engine, plan.id, world.admin);
    assert.equal(replayed.ok, false, 'approval is not a standing authorization');
  });
}
