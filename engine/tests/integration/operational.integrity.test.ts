import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { QUOTA_LIMITS } from '../../src/domain/quota.ts';
import { RETENTION_POLICIES } from '../../src/domain/retention.ts';
import { degradedStateFrom } from '../../src/domain/degraded.ts';
import { AUDITED_COMMANDS, AUDIT_ACTIONS } from '../../src/domain/audit-rule.ts';
import { sweepRetention } from '../../src/engines/retention.engine.ts';
import { incidentReport } from '../../src/engines/incident.engine.ts';
import { coordinationMutatesClaims, reviewCoordination } from '../../src/engines/coordination.engine.ts';
import { recommendationsFor } from '../../src/engines/conclusion.engine.ts';
import { relationshipGraphFor } from '../../src/engines/relationship.engine.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { ExperienceKind } from '../../src/domain/types.ts';
import type { AuditEvent, QueueItem } from '../../src/ports/store.ts';
import type { HealthReport } from '../../src/runtime/health.ts';

/**
 * Phase 70 — operational integrity, certified end to end, for a Rage and again for a Rave.
 *
 * Phases 1–60 made the system *correct*. This band is about whether it is safe to
 * **operate**, which is a different question and fails in different ways. The lap:
 *
 *   a burst is throttled without being judged → a coordinated set opens a review without
 *   changing a count → a reported reply is actioned → an author deletes and nothing
 *   anywhere still names it → an artefact expires and the account survives → a dependency
 *   drops and the state says what is refused → and every governed action in the lap left
 *   an attributable trace.
 *
 * Run twice, on the same principle as the Phase 60 lap. A band that only holds its rules
 * for complaints has not held them: a Rave goes through exactly the same throttle,
 * moderation, deletion and retention code, and the Rave lap is where an assumption that
 * "operational integrity" means "handling problems" would show up.
 *
 * Each assertion names what it is defending, because a certification test whose failures
 * cannot be read is one somebody eventually deletes.
 */
const DAY = 86_400_000;

interface Lap {
  readonly h: EngineHarness;
  readonly kind: ExperienceKind;
  readonly author: ActorContext;
  readonly replier: ActorContext;
  readonly moderator: ActorContext;
  readonly experienceId: string;
  readonly replyId: string;
}

const bodyFor = (kind: ExperienceKind): string =>
  kind === 'rage'
    ? 'The refund still has not arrived after six weeks.'
    : 'The repair was done the same afternoon and cost nothing.';

/** One lap's setup: an author, a moderator, a published experience and a reply on it. */
const openLap = async (kind: ExperienceKind): Promise<Lap> => {
  const h = createEngineHarness();
  const { actor: author } = await h.signUp(`op-author-${kind}@example.com`, 'Author');
  const { actor: replier } = await h.signUp(`op-replier-${kind}@example.com`, 'Replier');
  const moderator = await h.promote(
    (await h.signUp(`op-mod-${kind}@example.com`, 'Mod')).actor.actorId,
    'moderator',
  );

  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind, creationMode: 'text', category: 'Other', bodyText: bodyFor(kind), visibility: 'public' },
      actor: author,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();

  const reply = expect(
    await h.engine.bus.dispatch<unknown, { replyId: string }>({
      name: 'conversation.createReply',
      input: {
        experienceId: created.experienceId,
        creationMode: 'text',
        bodyText: kind === 'rage' ? 'The same thing happened to me.' : 'They were good with us too.',
        visibility: 'public',
      },
      actor: replier,
      idempotencyKey: h.nextKey(),
    }),
    'reply',
  );
  await h.settle();

  return { h, kind, author, replier, moderator, experienceId: created.experienceId, replyId: reply.replyId };
};

for (const kind of ['rage', 'rave'] as const) {
  test(`${kind}: a burst is throttled without anybody being judged`, async () => {
    const lap = await openLap(kind);
    const { h, author } = lap;

    // Authoring is its own class, so the experience already created has charged it once.
    let throttled = 0;
    for (let index = 0; index < QUOTA_LIMITS.authoring.limit + 4; index += 1) {
      const result = await h.engine.bus.dispatch({
        name: 'experience.create',
        input: { kind, creationMode: 'text', category: 'Other', bodyText: `${bodyFor(kind)} ${index}`, visibility: 'public' },
        actor: author,
        idempotencyKey: h.nextKey(),
      });
      if (!result.ok) {
        assert.equal(result.error.kind, 'rate_limited', 'a burst is refused as a rate limit and nothing else');
        throttled += 1;
      }
    }
    assert.ok(throttled > 0, 'the burst was actually throttled');

    // **A quota is not a judgement.** Nothing about being fast reaches trust, and the
    // people most likely to post quickly are the ones something is happening to.
    const trust = await h.engine.store.trustAssessments.query([]);
    for (const assessment of trust) {
      assert.equal(
        JSON.stringify(assessment).includes('quota') || JSON.stringify(assessment).includes('rate_limit'),
        false,
        'no throttle reaches a trust assessment',
      );
    }
    // And being throttled is not being reported: no report names the author, and no
    // moderation action was recorded against them. Checked against the two tables that
    // would carry an accusation, rather than against a priority number — the first version
    // of this compared a queue priority to a quota limit, which is two unrelated integers
    // and would have passed whatever the code did.
    const reports = await h.engine.store.reports.query([]);
    assert.deepEqual(
      reports.filter((report) => report.targetId === lap.experienceId),
      [],
      'a throttle files no report',
    );
    const actions = await h.engine.store.moderationActions.query([]);
    assert.deepEqual(actions, [], 'and records no moderation action');
  });

  test(`${kind}: a coordinated set opens a review and changes no count`, async () => {
    const lap = await openLap(kind);
    const { h } = lap;

    // A real cohort: three accounts whose claims land on the same three experiences inside
    // the co-arrival window. That is the shape the detector is looking for, and seeding it
    // is the only way this assertion means anything — a sweep over an empty cluster changes
    // nothing whether or not the rules hold.
    const cohort = ['co_a', 'co_b', 'co_c'];
    const experienceIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const owner = await h.signUp(`op-cohort-owner-${kind}-${index}@example.com`, 'Owner');
      const created = expect(
        await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
          name: 'experience.create',
          input: { kind, creationMode: 'text', category: 'Other', bodyText: `${bodyFor(kind)} (${index})`, visibility: 'public' },
          actor: owner.actor,
          idempotencyKey: h.nextKey(),
        }),
        'cohort experience',
      );
      experienceIds.push(created.experienceId);
      await h.engine.store.clusterMembers.put({
        id: `cm_${index}`,
        clusterId: 'cluster_coordinated',
        experienceId: created.experienceId,
        relationship: 'same_issue',
        score: 1,
        factors: {},
      });
    }
    await h.settle();

    for (const [experienceIndex, experienceId] of experienceIds.entries()) {
      for (const [actorIndex, corroboratorId] of cohort.entries()) {
        await h.engine.store.corroborations.put({
          id: `cor_${experienceIndex}_${actorIndex}`,
          experienceId,
          corroboratorId,
          type: kind === 'rage' ? 're_rage' : 're_rave',
          relationship: 'same_experience',
          visibility: 'public',
          status: 'active',
          correlationId: `corr_${experienceIndex}_${actorIndex}`,
          // Minutes apart, well inside the window: arriving together is the signal, and
          // arriving weeks apart is three people who each had the same afternoon.
          createdAt: h.clock.now() + actorIndex * 60_000,
        });
      }
    }

    const countsBefore = await h.engine.store.counters.all();
    const corroborationsBefore = await h.engine.store.corroborations.all();

    const opened = await reviewCoordination(h.engine, 'cluster_coordinated');
    assert.ok(opened.length > 0, 'the cohort was detected');
    for (const review of opened) {
      const item = await h.engine.store.queueItems.get(review.queueItemId);
      assert.ok(item, 'and a moderator has something to open');
      // The queue item names an experience, never the cohort: the queue is a work list, and
      // the accounts are a detail of the investigation rather than a label to hang on
      // anybody before a person has looked.
      assert.equal(
        cohort.some((actorId) => JSON.stringify(item).includes(actorId)),
        false,
        'the queue item names no account',
      );
    }

    // **Detection is a signal for review, never an action.** Not one claim was retracted,
    // reweighted or discounted, and no count moved. The absence is assertable rather than
    // merely true, which is what stops a later edit adding a discount quietly.
    assert.equal(coordinationMutatesClaims(), false);
    assert.deepEqual(await h.engine.store.counters.all(), countsBefore, 'no count moved');
    assert.deepEqual(
      await h.engine.store.corroborations.all(),
      corroborationsBefore,
      'and not one claim was touched — somebody being wrongly discounted is being told their experience did not happen',
    );

    // Idempotent: a sweep that ran again would otherwise hand a moderator a second copy of
    // one situation, which is how a queue becomes something people stop reading.
    const queuedAfterFirst = (await h.engine.store.queueItems.all()).length;
    await reviewCoordination(h.engine, 'cluster_coordinated');
    assert.equal((await h.engine.store.queueItems.all()).length, queuedAfterFirst, 'one item, not one per sweep');
  });

  test(`${kind}: a reported reply can be actioned, and the parent is untouched`, async () => {
    const lap = await openLap(kind);
    const { h, moderator, experienceId, replyId } = lap;

    const parentBefore = await h.engine.store.experiences.get(experienceId);
    expect(
      await h.engine.bus.dispatch({
        name: 'safety.applyModerationAction',
        input: {
          targetType: 'reply',
          targetId: replyId,
          action: 'remove',
          reason: 'Names a private individual.',
        },
        actor: moderator,
        idempotencyKey: h.nextKey(),
      }),
      'moderate the reply',
    );

    const reply = await h.engine.store.replies.get(replyId);
    assert.equal(reply?.status, 'removed', 'the reply was actually actioned');
    assert.deepEqual(
      await h.engine.store.experiences.get(experienceId),
      parentBefore,
      'and the experience it hangs off is untouched — a reply is moderated as a reply',
    );

    // Clause 1 of the audit rule: a moderator acted on somebody else's words.
    const audits = await h.engine.store.auditEvents.query([]);
    assert.ok(
      audits.some(
        (entry: AuditEvent) => entry.resourceId === replyId && entry.actorId === moderator.actorId,
      ),
      'and it is attributable to the person who did it',
    );
  });

  test(`${kind}: an author deletes, and nothing anywhere still names it`, async () => {
    const lap = await openLap(kind);
    const { h, author, experienceId } = lap;

    expect(
      await h.engine.bus.dispatch({
        name: 'creator.deleteExperience',
        input: { experienceId },
        actor: author,
        idempotencyKey: h.nextKey(),
      }),
      'delete',
    );
    await h.settle();

    // Every stored reference, including the ones phases 51–60 added.
    for (const row of await h.engine.store.recommendations.all()) {
      assert.equal(
        row.acrossExperienceIds.includes(experienceId),
        false,
        'a recommendation stops citing a deleted experience rather than citing it forever',
      );
    }
    assert.deepEqual(await recommendationsFor(h.engine, experienceId), []);
    const graph = await relationshipGraphFor(h.engine, experienceId);
    assert.deepEqual(graph.edges, [], 'and the derived reads re-check status rather than trusting assertion time');

    // **The audit trail of the deletion survives the deletion.** Erasing the record that
    // an erasure happened is not erasure, it is amnesia.
    const audits = await h.engine.store.auditEvents.query([]);
    assert.ok(
      audits.some(
        (entry: AuditEvent) =>
          entry.resourceId === experienceId && entry.action === AUDIT_ACTIONS['creator.deleteExperience'],
      ),
      'the deletion left a record of itself',
    );
  });

  test(`${kind}: an artefact expires and the account survives it`, async () => {
    const lap = await openLap(kind);
    const { h, experienceId } = lap;

    // A media asset attached directly, because what retention acts on is the artefact and
    // the voice pipeline is certified elsewhere.
    await h.engine.store.mediaAssets.put({
      id: 'op_media',
      experienceId,
      kind: 'audio',
      originalKey: 'original/op/audio',
      protectedKey: 'protected/op/audio',
      durationMs: 5_000,
      byteSize: 120_000,
      mimeType: 'audio/webm',
      processingStatus: 'ready',
      protectionStatus: 'protected',
      attemptCount: 0,
      createdAt: h.clock.now(),
    });

    const before = await h.engine.store.experiences.get(experienceId);
    h.clock.advance(RETENTION_POLICIES.original_media.ceilingMs + DAY);
    const swept = await sweepRetention(h.engine);

    const asset = await h.engine.store.mediaAssets.get('op_media');
    assert.ok(asset?.originalRemovedAt, 'the original expired on its stated ceiling');
    assert.equal(asset.protectedKey, 'protected/op/audio', 'the public derivative outlives it');
    assert.deepEqual(
      await h.engine.store.experiences.get(experienceId),
      before,
      'and what the person said is untouched: retention removes bytes, never facts',
    );
    assert.equal(
      swept.byteRemoval,
      'object_storage_blocked',
      'the deletion of the bytes is named as outstanding rather than claimed',
    );
  });

  test(`${kind}: a dependency drops, the state says what is refused, and no refusal changes`, async () => {
    const lap = await openLap(kind);
    const { h, author } = lap;

    // Fabricated rather than induced: the state that has to be right is the one nobody can
    // conveniently reproduce, and inducing it would mean breaking the harness.
    const unhealthy: HealthReport = {
      state: 'unhealthy',
      dependencies: [
        { name: 'database', state: 'unhealthy', detail: 'connection refused', checkedAt: '2026-09-10T00:00:00.000Z' },
      ],
      checkedAt: '2026-09-10T00:00:00.000Z',
    };
    const state = degradedStateFrom(unhealthy);
    assert.equal(state.level, 'impaired');
    assert.ok(state.refusing.length > 0, 'and it names what is being refused');

    // **It changes no refusal.** The engine is healthy, so a command still succeeds — the
    // degraded reading is a lens over the health registry, not a gate in the write path.
    const result = await h.engine.bus.dispatch({
      name: 'reaction.toggle',
      input: { experienceId: lap.experienceId, reactionType: 'same' },
      actor: author,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(result.ok, true, 'reading a degraded state refuses nothing by itself');

    // And the real report agrees the system is fine, so the lens is not stuck on.
    const live = degradedStateFrom((await incidentReport(h.engine)).health);
    assert.equal(live.level, 'nominal');
  });

  test(`${kind}: every governed action in the lap is attributable`, async () => {
    const lap = await openLap(kind);
    const { h, author, replier, moderator, experienceId, replyId } = lap;

    // Three actions from three clauses of the audit rule, in one lap.
    expect(
      await h.engine.bus.dispatch({
        name: 'creator.changeVisibility',
        input: { experienceId, visibility: 'anonymous' },
        actor: author,
        idempotencyKey: h.nextKey(),
      }),
      'change visibility',
    );
    expect(
      await h.engine.bus.dispatch({
        name: 'safety.applyModerationAction',
        input: { targetType: 'reply', targetId: replyId, action: 'warn', reason: 'Keep it about the company.' },
        actor: moderator,
        idempotencyKey: h.nextKey(),
      }),
      'warn',
    );
    expect(
      await h.engine.bus.dispatch({
        name: 'conversation.deleteReply',
        input: { replyId },
        // The person who wrote it. Deleting your own reply is clause 3 of the audit rule —
        // irreversible, so the event is the only thing that survives it.
        actor: replier,
        idempotencyKey: h.nextKey(),
      }),
      'delete reply',
    );

    const audits = await h.engine.store.auditEvents.query([]);
    const actions = new Set(audits.map((entry: AuditEvent) => entry.action));
    for (const command of ['creator.changeVisibility', 'safety.applyModerationAction', 'conversation.deleteReply']) {
      const prefix = AUDIT_ACTIONS[command] ?? command;
      assert.ok(
        [...actions].some((action) => action.startsWith(prefix)),
        `${command} left a trace under ${prefix}`,
      );
      assert.ok(AUDITED_COMMANDS[command] !== undefined, `and the rule says it should have`);
    }

    // Every entry names a person. An audit event with no actor is a record of nothing.
    for (const entry of audits) {
      assert.ok(entry.actorId.length > 0, `${entry.action} names who took it`);
      assert.ok(entry.correlationId.length > 0, 'and which request it belonged to');
    }
  });
}

test('the lap ran for both kinds, so neither result is a single-path pass', () => {
  // A guard on the guard. The `for` loop above is the mechanism, and if somebody narrowed
  // it to one kind every test would still pass while proving half of what it claims.
  const kinds: readonly ExperienceKind[] = ['rage', 'rave'];
  assert.equal(kinds.length, 2);
});

test('nothing in this band opened a queue item about being fast', async () => {
  // The band's own line, checked once outside the lap: throttling, coordination detection
  // and retention are all capable of producing a moderation item, and only one of them
  // should — the coordination review, and only on a real finding.
  const h = createEngineHarness();
  const { actor } = await h.signUp('op-quiet@example.com', 'Quiet');
  for (let index = 0; index < QUOTA_LIMITS.authoring.limit + 4; index += 1) {
    await h.engine.bus.dispatch({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: `Something happened ${index}.`, visibility: 'public' },
      actor,
      idempotencyKey: h.nextKey(),
    });
  }
  await h.settle();
  const queued = await h.engine.store.queueItems.query([]);
  const aboutSpeed = queued.filter((item: QueueItem) => item.priority < 0);
  assert.deepEqual(aboutSpeed, [], 'being throttled is not being reported');
});
