import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { eq } from '../../src/ports/store.ts';
import { pendingSuggestions } from '../../src/engines/normalization.engine.ts';
import { clusterWithMembers } from '../../src/engines/matching.engine.ts';
import { publicSignalFor } from '../../src/engines/signal.engine.ts';
import { internalTrustFor } from '../../src/engines/trust.engine.ts';
import { evidenceSummaryFor } from '../../src/engines/evidence.engine.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { ClusterMember, ClusterRow, RiskEvent } from '../../src/ports/store.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { CorroborateResult } from '../../src/engines/corroboration.engine.ts';
import type { ConfirmNormalizationResult } from '../../src/engines/normalization.engine.ts';

/**
 * The intelligence chain: extract → confirm → cluster → measure.
 *
 * The property under test throughout is that structure comes from confirmation.
 * An experience nobody confirmed is not silently reassigned to whatever
 * extraction guessed, and no amount of similar wording pulls two experiences
 * about different companies into one cluster.
 */
const seedTaxonomy = async (h: EngineHarness): Promise<{ entityId: string; categoryId: string; issueId: string }> => {
  await h.engine.store.entities.put({
    id: 'ent_northwind',
    name: 'Northwind Air',
    slug: 'northwind-air',
    kind: 'organization',
  });
  await h.engine.store.entities.put({
    id: 'ent_southgale',
    name: 'Southgale Rail',
    slug: 'southgale-rail',
    kind: 'organization',
  });
  await h.engine.store.entityAliases.put({
    id: 'ali_1',
    entityId: 'ent_northwind',
    alias: 'Northwind Air',
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
  return { entityId: 'ent_northwind', categoryId: 'cat_shopping', issueId: 'iss_refund' };
};

const publish = async (
  h: EngineHarness,
  actor: ActorContext,
  bodyText: string,
  kind: 'rage' | 'rave' = 'rage',
): Promise<string> => {
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind, creationMode: 'text', category: 'Shopping & service', bodyText, visibility: 'public' },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();
  return created.experienceId;
};

const confirm = (h: EngineHarness, actor: ActorContext, experienceId: string, fields: Record<string, string>) =>
  h.engine.bus.dispatch<unknown, ConfirmNormalizationResult>({
    name: 'normalization.confirm',
    input: { experienceId, fields },
    actor,
    idempotencyKey: h.nextKey(),
  });

// ── Extraction proposes ──────────────────────────────────────────────────
test('extraction proposes an entity but does not assign one', async () => {
  const h = createEngineHarness();
  await seedTaxonomy(h);
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air lost my bag and the refund never arrived.');

  const suggestions = await pendingSuggestions(h.engine, experienceId);
  assert.ok(
    suggestions.some((suggestion) => suggestion.field === 'entity' && suggestion.value === 'ent_northwind'),
    'the entity was read from the text',
  );

  const experience = await h.engine.store.experiences.get(experienceId);
  assert.equal(
    experience?.entityId,
    undefined,
    'reading an entity is not assigning one — nothing is confirmed yet',
  );
  assert.equal(experience?.clusterId, undefined, 'and an unconfirmed experience is not clusterable');
});

test('an unconfirmed experience joins no cluster, however clear the wording', async () => {
  const h = createEngineHarness();
  await seedTaxonomy(h);
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');
  await publish(h, a.actor, 'Northwind Air lost my bag and the refund never arrived.');
  await publish(h, b.actor, 'Northwind Air lost my bag and the refund never arrived.');
  await h.settle();

  assert.equal(
    await h.engine.store.clusters.count(),
    0,
    'identical text is not agreement about which company it was',
  );
});

// ── Confirmation makes it a fact ─────────────────────────────────────────
test('confirming an entity assigns it and makes the experience clusterable', async () => {
  const h = createEngineHarness();
  const { entityId, categoryId, issueId } = await seedTaxonomy(h);
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air lost my bag and the refund never arrived.');

  const result = expect(
    await confirm(h, author.actor, experienceId, {
      entity: entityId,
      category: categoryId,
      issueType: issueId,
    }),
    'confirm',
  );
  assert.deepEqual(
    result.confirmed.map((field) => field.field).sort(),
    ['category', 'entity', 'issueType'],
  );
  await h.settle();

  const experience = await h.engine.store.experiences.get(experienceId);
  assert.equal(experience?.entityId, entityId);
  assert.ok(experience?.clusterId, 'confirming an entity is the moment it becomes clusterable');
});

test('a person who disagrees with the suggestion gets their answer, and the disagreement is recorded', async () => {
  const h = createEngineHarness();
  await seedTaxonomy(h);
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air lost my bag.');

  const result = expect(
    // Extraction said Northwind. The person says it was Southgale.
    await confirm(h, author.actor, experienceId, { entity: 'ent_southgale' }),
    'confirm',
  );
  assert.equal(result.confirmed[0]?.edited, true, 'the correction is recorded as a correction');

  const experience = await h.engine.store.experiences.get(experienceId);
  assert.equal(experience?.entityId, 'ent_southgale', 'the person’s answer wins, not the extraction');

  const metadata = await h.engine.store.experienceMetadata.get(experienceId);
  assert.deepEqual(metadata?.confirmed['_edited'], ['entity']);
  assert.ok(metadata?.extracted, 'and what extraction proposed is still on record');
});

test('re-extraction after a new transcript never disturbs a confirmation', async () => {
  const h = createEngineHarness();
  await seedTaxonomy(h);
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air lost my bag.');
  expect(await confirm(h, author.actor, experienceId, { entity: 'ent_southgale' }), 'confirm');

  // Force the extraction consumer to run again.
  await h.engine.outbox.append(
    [
      {
        aggregateType: 'experience',
        aggregateId: experienceId,
        eventName: 'TranscriptRedacted',
        payload: { experienceId },
      },
    ],
    'corr_reextract',
  );
  await h.settle();

  const metadata = await h.engine.store.experienceMetadata.get(experienceId);
  assert.equal(metadata?.confirmed['entity'], 'ent_southgale', 'the confirmation survived re-extraction');
});

// ── Clustering: deterministic agreement, not similarity ──────────────────
test('two confirmed experiences about the same entity and issue share one cluster', async () => {
  const h = createEngineHarness();
  const { entityId, categoryId, issueId } = await seedTaxonomy(h);
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');

  const first = await publish(h, a.actor, 'Northwind Air lost my bag and the refund never arrived.');
  const second = await publish(h, b.actor, 'Northwind Air never processed my refund after three weeks.');
  for (const [actor, id] of [[a.actor, first], [b.actor, second]] as const) {
    expect(await confirm(h, actor, id, { entity: entityId, category: categoryId, issueType: issueId }), 'confirm');
  }
  await h.settle();

  assert.equal(await h.engine.store.clusters.count(), 1, 'one pattern, one cluster');
  const clusterId = (await h.engine.store.experiences.get(first))?.clusterId ?? '';
  const view = await clusterWithMembers(h.engine, clusterId);
  assert.equal(view?.members.length, 2);
  assert.equal(view?.cluster.totalExperiences, 2);
  assert.equal(view?.cluster.uniqueExperiencers, 2, 'two different people');
});

test('the same wording about different entities never shares a cluster', async () => {
  const h = createEngineHarness();
  const { categoryId, issueId } = await seedTaxonomy(h);
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');

  const text = 'The refund never arrived after three weeks of chasing it.';
  const first = await publish(h, a.actor, text);
  const second = await publish(h, b.actor, text);
  expect(await confirm(h, a.actor, first, { entity: 'ent_northwind', category: categoryId, issueType: issueId }), 'a');
  expect(await confirm(h, b.actor, second, { entity: 'ent_southgale', category: categoryId, issueType: issueId }), 'b');
  await h.settle();

  assert.equal(await h.engine.store.clusters.count(), 2, 'identical text is not the same experience');
  const clusters = await h.engine.store.clusters.all();
  assert.notEqual(clusters[0]?.id, clusters[1]?.id);
});

test('a Rage and a Rave about the same entity are different patterns', async () => {
  const h = createEngineHarness();
  const { entityId, categoryId, issueId } = await seedTaxonomy(h);
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');

  const rage = await publish(h, a.actor, 'Northwind Air never processed my refund.', 'rage');
  const rave = await publish(h, b.actor, 'Northwind Air refunded me the same day.', 'rave');
  expect(await confirm(h, a.actor, rage, { entity: entityId, category: categoryId, issueType: issueId }), 'rage');
  expect(await confirm(h, b.actor, rave, { entity: entityId, category: categoryId, issueType: issueId }), 'rave');
  await h.settle();

  assert.equal(
    await h.engine.store.clusters.count(),
    2,
    'a thing going wrong and the same thing going right are not one pattern',
  );
});

test('cluster membership records why, in factors a person can check', async () => {
  const h = createEngineHarness();
  const { entityId, categoryId, issueId } = await seedTaxonomy(h);
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');
  const first = await publish(h, a.actor, 'Northwind Air never processed my refund after three weeks.');
  const second = await publish(h, b.actor, 'Northwind Air never processed my refund after three weeks.');
  for (const [actor, id] of [[a.actor, first], [b.actor, second]] as const) {
    expect(await confirm(h, actor, id, { entity: entityId, category: categoryId, issueType: issueId }), 'confirm');
  }
  await h.settle();

  const member = await h.engine.store.clusterMembers.queryOne([
    eq<ClusterMember>('experienceId', second),
  ]);
  assert.ok(member, 'the second experience is a member');
  assert.ok(
    ['same_experience', 'similar_experience', 'related_experience'].includes(member?.relationship ?? ''),
    'and its relationship is recorded',
  );
  assert.equal(member?.factors['entity'], 1, 'the entity factor shows the identifiers agreed');
});

// ── Signal ───────────────────────────────────────────────────────────────
test('the cluster signal counts people, and corroborations move it', async () => {
  const h = createEngineHarness();
  const { entityId, categoryId, issueId } = await seedTaxonomy(h);
  const author = await h.signUp('author@example.com');
  const claimant = await h.signUp('claimant@example.com');

  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  expect(await confirm(h, author.actor, experienceId, { entity: entityId, category: categoryId, issueType: issueId }), 'confirm');
  await h.settle();

  const clusterId = (await h.engine.store.experiences.get(experienceId))?.clusterId ?? '';
  const before = await publicSignalFor(h.engine, clusterId);
  assert.equal(before?.peopleAffected, 1, 'the author is one experiencer');
  assert.equal(before?.corroborations, 0);

  expect(
    await h.engine.bus.dispatch<unknown, CorroborateResult>({
      name: 'corroboration.create',
      input: { experienceId, type: 're_rage' },
      actor: claimant.actor,
      idempotencyKey: h.nextKey(),
    }),
    'corroborate',
  );
  await h.settle();

  const after = await publicSignalFor(h.engine, clusterId);
  assert.equal(after?.peopleAffected, 2, 'author plus corroborator');
  assert.equal(after?.corroborations, 1);
});

test('the public signal is named metrics, never a single score', async () => {
  const h = createEngineHarness();
  const { entityId, categoryId, issueId } = await seedTaxonomy(h);
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  expect(await confirm(h, author.actor, experienceId, { entity: entityId, category: categoryId, issueType: issueId }), 'confirm');
  await h.settle();

  const clusterId = (await h.engine.store.experiences.get(experienceId))?.clusterId ?? '';
  const signal = await publicSignalFor(h.engine, clusterId);
  assert.ok(signal);
  for (const forbidden of ['score', 'outrage', 'severity', 'rank']) {
    assert.equal(
      Object.keys(signal ?? {}).some((key) => key.toLowerCase().includes(forbidden)),
      false,
      `the public signal must not expose a ${forbidden}`,
    );
  }
  assert.ok(Object.keys(signal ?? {}).includes('peopleAffected'));
  assert.ok(Object.keys(signal ?? {}).includes('resolutionRate'));
});

// ── Evidence ─────────────────────────────────────────────────────────────
test('evidence is optional, deduplicated, and never labelled verified', async () => {
  const h = createEngineHarness();
  await seedTaxonomy(h);
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');

  const attach = (digest?: string) =>
    h.engine.bus.dispatch<unknown, { evidenceId: string; duplicate: boolean }>({
      name: 'evidence.attach',
      input: {
        experienceId,
        kind: 'receipt',
        originalKey: 'orig/receipt.png',
        byteSize: 2048,
        mimeType: 'image/png',
        ...(digest === undefined ? {} : { contentDigest: digest }),
      },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    });

  const first = expect(await attach('sha256:abc'), 'attach');
  assert.equal(first.duplicate, false);
  const again = expect(await attach('sha256:abc'), 'attach again');
  assert.equal(again.duplicate, true, 're-uploading the same artefact is not more evidence');
  assert.equal(again.evidenceId, first.evidenceId);

  const summary = await evidenceSummaryFor(h.engine, experienceId);
  assert.equal(summary.count, 1);
  assert.equal(summary.latestOutcome, 'unassessed', 'nothing is verified by being uploaded');
});

test('"verified" is refused as an assessment outcome', async () => {
  const h = createEngineHarness();
  await seedTaxonomy(h);
  const author = await h.signUp('author@example.com');
  const moderator = await h.signUp('mod@example.com');
  await h.promote(moderator.auth.actorId, 'moderator');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');

  const attached = expect(
    await h.engine.bus.dispatch<unknown, { evidenceId: string }>({
      name: 'evidence.attach',
      input: { experienceId, kind: 'receipt', originalKey: 'orig/r.png', byteSize: 100, mimeType: 'image/png' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'attach',
  );
  // Protection has to have run before an assessment can read the derivative.
  const row = await h.engine.store.evidence.get(attached.evidenceId);
  assert.ok(row);
  await h.engine.store.evidence.put({ ...row!, protectionStatus: 'protected', protectedKey: 'prot/r.png' });

  const refused = await h.engine.bus.dispatch({
    name: 'evidence.assess',
    input: { evidenceId: attached.evidenceId, outcome: 'verified' },
    actor: { actorId: moderator.auth.actorId, role: 'moderator', authenticated: true },
    idempotencyKey: h.nextKey(),
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.error.code, 'invalid_assessment_outcome');

  const allowed = await h.engine.bus.dispatch<unknown, { outcome: string }>({
    name: 'evidence.assess',
    input: { evidenceId: attached.evidenceId, outcome: 'consistent' },
    actor: { actorId: moderator.auth.actorId, role: 'moderator', authenticated: true },
    idempotencyKey: h.nextKey(),
  });
  assert.equal(allowed.ok, true, '"consistent" is what a reviewer can actually determine');
});

test('evidence cannot be assessed before it is protected', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const moderator = await h.signUp('mod@example.com');
  await h.promote(moderator.auth.actorId, 'moderator');
  const experienceId = await publish(h, author.actor, 'A thing happened.');

  const attached = expect(
    await h.engine.bus.dispatch<unknown, { evidenceId: string }>({
      name: 'evidence.attach',
      input: { experienceId, kind: 'photo', originalKey: 'orig/p.jpg', byteSize: 100, mimeType: 'image/jpeg' },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'attach',
  );

  const refused = await h.engine.bus.dispatch({
    name: 'evidence.assess',
    input: { evidenceId: attached.evidenceId, outcome: 'consistent' },
    actor: { actorId: moderator.auth.actorId, role: 'moderator', authenticated: true },
    idempotencyKey: h.nextKey(),
  });
  assert.equal(refused.ok === false && refused.error.code, 'evidence_not_protected');
});

// ── Trust: internal only ─────────────────────────────────────────────────
test('trust is computed for a contributor and is not on any public projection', async () => {
  const h = createEngineHarness();
  // Seeded so naming the company does not route the experience to human review:
  // a known entity's name is not a person's name.
  await seedTaxonomy(h);
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  await h.settle();

  const trust = await internalTrustFor(h.engine, author.auth.actorId);
  assert.ok(trust, 'an assessment exists internally');
  assert.ok(trust!.accountConfidence >= 0 && trust!.accountConfidence <= 1);

  const feedEntry = await h.engine.store.feedEntries.get(experienceId);
  assert.ok(feedEntry);
  for (const key of Object.keys(feedEntry ?? {})) {
    assert.equal(
      /trust|confidence/i.test(key),
      false,
      `the feed projection must carry no trust signal, found ${key}`,
    );
  }
});

test('a coordinated burst raises a flag and changes nobody’s claim', async () => {
  const h = createEngineHarness();
  await seedTaxonomy(h);
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');

  for (let index = 0; index < 6; index += 1) {
    const claimant = await h.signUp(`burst-${index}@example.com`);
    expect(
      await h.engine.bus.dispatch<unknown, CorroborateResult>({
        name: 'corroboration.create',
        input: { experienceId, type: 're_rage' },
        actor: claimant.actor,
        idempotencyKey: h.nextKey(),
      }),
      'corroborate',
    );
  }
  await h.settle();

  const risks = await h.engine.store.riskEvents.query([eq<RiskEvent>('kind', 'coordinated_corroboration')]);
  assert.equal(risks.length, 1, 'one finding for the window, not one per corroboration');
  assert.equal(risks[0]?.detail['distinctCorroborators'], 6);

  // The claims themselves are untouched: detection informs a human, it does not act.
  const counters = await h.engine.store.counters.get(experienceId);
  assert.equal(counters?.reRageCount, 6, 'no corroboration was removed or discounted');
  const active = await h.engine.store.corroborations.countWhere([
    eq('experienceId', experienceId),
    eq('status', 'active'),
  ]);
  assert.equal(active, 6);
});

test('a risk detail carries a summary, never the content that triggered it', async () => {
  const h = createEngineHarness();
  await seedTaxonomy(h);
  const author = await h.signUp('author@example.com');
  const secret = 'A very specific sentence that must never be copied into a risk row.';
  const experienceId = await publish(h, author.actor, secret);

  for (let index = 0; index < 6; index += 1) {
    const claimant = await h.signUp(`b-${index}@example.com`);
    await h.engine.bus.dispatch({
      name: 'corroboration.create',
      input: { experienceId, type: 're_rage', narrative: secret },
      actor: claimant.actor,
      idempotencyKey: h.nextKey(),
    });
  }
  await h.settle();

  for (const risk of await h.engine.store.riskEvents.all()) {
    assert.equal(
      JSON.stringify(risk.detail).includes(secret),
      false,
      'a risk row must summarise, not quote',
    );
  }
});

test('cluster counters converge under duplicated delivery', async () => {
  const h = createEngineHarness();
  const { entityId, categoryId, issueId } = await seedTaxonomy(h);
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  expect(await confirm(h, author.actor, experienceId, { entity: entityId, category: categoryId, issueType: issueId }), 'confirm');
  await h.settle();

  const clusterId = (await h.engine.store.experiences.get(experienceId))?.clusterId ?? '';
  const first = await h.engine.store.clusters.get(clusterId);

  // Re-deliver the same events. Consumers are idempotent, so nothing drifts.
  for (let round = 0; round < 3; round += 1) {
    await h.engine.outbox.append(
      [
        {
          aggregateType: 'experience',
          aggregateId: experienceId,
          eventName: 'ExperienceNormalizationConfirmed',
          payload: { experienceId, fields: ['entity'] },
        },
      ],
      `corr_dup_${round}`,
    );
    await h.settle();
  }

  const after = await h.engine.store.clusters.get(clusterId);
  assert.equal(after?.totalExperiences, first?.totalExperiences);
  assert.equal(await h.engine.store.clusters.count(), 1, 'no duplicate cluster was created');
  assert.equal(
    await h.engine.store.clusterMembers.countWhere([eq<ClusterMember>('clusterId', clusterId)]),
    1,
    'and no duplicate membership',
  );
});

test('a cluster headline is descriptive, not an accusation', async () => {
  const h = createEngineHarness();
  const { entityId, categoryId, issueId } = await seedTaxonomy(h);
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  expect(await confirm(h, author.actor, experienceId, { entity: entityId, category: categoryId, issueType: issueId }), 'confirm');
  await h.settle();

  const cluster = (await h.engine.store.clusters.all())[0] as ClusterRow | undefined;
  assert.equal(cluster?.headline, 'Northwind Air — Refund not processed');
  assert.equal(
    cluster?.headline.includes('never processed my refund'),
    false,
    'a headline is not a quote from the worst account in the cluster',
  );
});

// ── Naming a company is not naming a person ──────────────────────────────
test('an unknown capitalised name still routes to human review', async () => {
  const h = createEngineHarness();
  // Deliberately not seeded: with no entity by that name, the safest reading of
  // two capitalised words is that it might be a person.
  const author = await h.signUp('author@example.com');
  expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: {
        kind: 'rage',
        creationMode: 'text',
        category: 'Other',
        bodyText: 'Gregory Fenwick pushed in front of the whole queue.',
        visibility: 'public',
      },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();

  const experiences = await h.engine.store.experiences.query([eq('actorId', author.auth.actorId)]);
  assert.equal(
    experiences[0]?.status,
    'pending_moderation',
    'a possible person name must still stop publication',
  );
  const screening = await h.engine.store.screenings.queryOne([
    eq('targetId', experiences[0]?.id ?? ''),
  ]);
  assert.equal(screening?.outcome, 'needs_review');
});

test('a known entity name does not route to review, and other findings still do', async () => {
  const h = createEngineHarness();
  await seedTaxonomy(h);
  const author = await h.signUp('author@example.com');

  const clean = await publish(h, author.actor, 'Northwind Air never processed my refund.');
  assert.equal(
    (await h.engine.store.experiences.get(clean))?.status,
    'published',
    'naming a company must not bury the report in a queue',
  );

  // A phone number is still a finding, entity or not.
  expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: {
        kind: 'rage',
        creationMode: 'text',
        category: 'Other',
        bodyText: 'Northwind Air told me to call 555-123-4567 and then hung up.',
        visibility: 'public',
      },
      actor: author.actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();

  const withPhone = (await h.engine.store.experiences.query([eq('actorId', author.auth.actorId)])).find(
    (row) => row.bodyText.includes('555'),
  );
  assert.equal(withPhone?.status, 'pending_moderation', 'a phone number still stops publication');
});
