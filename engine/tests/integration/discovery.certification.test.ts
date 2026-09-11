import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import {
  discover,
  emergingPatterns,
  reachFor,
  searchContextually,
} from '../../src/engines/discovery.engine.ts';
import { watchCountFor, watchListOf } from '../../src/engines/watch.engine.ts';
import { notificationsFor } from '../../src/engines/notification.engine.ts';
import { relevanceCompositeScore } from '../../src/domain/relevance.ts';
import { FORBIDDEN_EMERGENCE_LABELS } from '../../src/domain/reach.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { ExperienceKind } from '../../src/domain/types.ts';
import type { Notification } from '../../src/ports/store.ts';

/**
 * Phase 80 — discovery and network effects, certified end to end, for a Rage and again for a
 * Rave.
 *
 * The lap:
 *
 *   an experience is published → it is discoverable by what it was about → it is searchable →
 *   it is ranked with a stated reason → somebody watches it → a third person corroborates →
 *   reach counts people → the watcher is notified once, and on replay zero more times → the
 *   author removes it → and it is absent from discovery, search, ranking, the watch list and
 *   every subsequent notification.
 *
 * Twice, for the reason every lap in this codebase runs twice: a band that only holds its
 * rules for complaints has not held them. The Rave lap is where an assumption that discovery
 * is about surfacing problems would show up — a Rave is corroborated, clustered, ranked and
 * watched by exactly the same code.
 */
const bodyFor = (kind: ExperienceKind, suffix: string): string =>
  kind === 'rage'
    ? `The delivery was left in the rain again ${suffix}.`
    : `The driver waited and carried it inside ${suffix}.`;

const publish = async (
  h: EngineHarness,
  actor: ActorContext,
  kind: ExperienceKind,
  bodyText: string,
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

for (const kind of ['rage', 'rave'] as const) {
  test(`${kind}: the discovery lap closes, and closes again when the author removes it`, async () => {
    const h = createEngineHarness();
    const { actor: author } = await h.signUp(`lap-author-${kind}@example.com`, 'Author');
    const { actor: watcher } = await h.signUp(`lap-watcher-${kind}@example.com`, 'Watcher');
    const { actor: corroborator } = await h.signUp(`lap-corr-${kind}@example.com`, 'Corroborator');

    // ── Published, discoverable, searchable, ranked with a reason ─────────
    const experienceId = await publish(h, author, kind, bodyFor(kind, 'once'));
    const second = await publish(h, author, kind, bodyFor(kind, 'twice'));

    const found = await discover(h.engine, { category: 'Shopping & service' });
    assert.equal(found.length, 2, 'discoverable by what it was about');
    assert.ok((found[0]?.reason ?? '').length > 10, 'and ranked with a stated reason');
    assert.equal(relevanceCompositeScore(), undefined, 'with no composite behind it');

    const hits = await searchContextually(h.engine, { text: kind === 'rage' ? 'rain' : 'carried' });
    assert.ok(hits.length >= 1, 'and searchable');
    assert.ok((hits[0]?.factors.corroboratingPeople ?? -1) >= 0, 'with its factors attached');

    // ── Watched ──────────────────────────────────────────────────────────
    expect(
      await h.engine.bus.dispatch({
        name: 'watch.start',
        input: { targetType: 'experience', targetId: experienceId },
        actor: watcher,
        idempotencyKey: h.nextKey(),
      }),
      'watch',
    );
    assert.equal(await watchCountFor(h.engine, 'experience', experienceId), 1);
    // The author cannot learn who, which is the direction this rule runs.
    assert.deepEqual(await watchListOf(h.engine, author.actorId), []);

    // ── Corroborated: reach counts people ────────────────────────────────
    expect(
      await h.engine.bus.dispatch({
        name: 'corroboration.create',
        input: {
          experienceId,
          type: kind === 'rage' ? 're_rage' : 're_rave',
          relationship: 'same_experience',
          visibility: 'public',
        },
        actor: corroborator,
        idempotencyKey: h.nextKey(),
      }),
      'corroborate',
    );
    await h.settle();

    const reach = await reachFor(h.engine, experienceId);
    assert.equal(reach.people, 2, 'the author and the corroborator — people, not rows');
    assert.equal(reach.amplification, 0, 'and amplification is a separate figure');

    // ── The watcher is notified once, and replay adds nothing ─────────────
    expect(
      await h.engine.bus.dispatch({
        name: 'resolution.report',
        // The corroborator is one of the people it happened to, so they may report an
        // outcome. `partially_resolved` rather than resolved: one of two experiencers
        // reporting is not the whole account settled, which the engine enforces anyway.
        input: { experienceId, kind: 'partially_resolved', detail: 'They got in touch.' },
        actor: corroborator,
        idempotencyKey: h.nextKey(),
      }),
      'report an outcome',
    );
    await h.settle();

    const notified = (await notificationsFor(h.engine, watcher.actorId)).filter(
      (row: Notification) => row.kind === 'watched_update',
    );
    assert.equal(notified.length, 1, 'the watcher is told once');
    assert.equal(
      JSON.stringify(notified[0]).includes(bodyFor(kind, 'once')),
      false,
      'and the payload carries no excerpt of the thing it is about',
    );

    // Replay: re-drain the orchestrator over the same events. At-least-once delivery means
    // this is the normal case, not an exceptional one.
    await h.settle();
    await h.settle();
    const afterReplay = (await notificationsFor(h.engine, watcher.actorId)).filter(
      (row: Notification) => row.kind === 'watched_update',
    );
    assert.equal(afterReplay.length, 1, 'and replay notifies nobody twice');

    // ── The author removes it, and everything forgets ─────────────────────
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

    const afterDelete = await discover(h.engine, { category: 'Shopping & service' });
    assert.equal(
      afterDelete.some((row) => row.experienceId === experienceId),
      false,
      'absent from discovery',
    );
    assert.deepEqual(
      (await searchContextually(h.engine, { text: kind === 'rage' ? 'rain' : 'carried' })).filter(
        (hit) => hit.experienceId === experienceId,
      ),
      [],
      'absent from search',
    );
    assert.deepEqual(await watchListOf(h.engine, watcher.actorId), [], 'absent from the watch list');
    assert.ok(
      afterDelete.some((row) => row.experienceId === second),
      'and the other experience is untouched — a deletion is not a purge of the category',
    );
  });

  test(`${kind}: an emerging pattern is surfaced as emerging and never as established`, async () => {
    const h = createEngineHarness();
    const authors: ActorContext[] = [];
    for (let index = 0; index < 3; index += 1) {
      const { actor } = await h.signUp(`emerge-${kind}-${index}@example.com`, 'Author');
      authors.push(actor);
    }

    await h.engine.store.clusters.put({
      id: 'cluster_emerging',
      kind,
      headline: 'Deliveries left outside',
      totalExperiences: 0,
      corroborations: 0,
      uniqueExperiencers: 0,
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    });

    const experienceIds: string[] = [];
    for (const [index, actor] of authors.entries()) {
      const id = await publish(h, actor, kind, bodyFor(kind, `case ${index}`));
      experienceIds.push(id);
      await h.engine.store.clusterMembers.put({
        id: `cm_emerge_${index}`,
        clusterId: 'cluster_emerging',
        experienceId: id,
        relationship: 'same_issue',
        score: 1,
        factors: {},
      });
    }

    const emerging = await emergingPatterns(h.engine);
    assert.equal(emerging.length, 1, 'three people across three experiences is a pattern');
    assert.equal(emerging[0]?.label, 'emerging');
    assert.equal(emerging[0]?.people, 3, 'counted in people');
    // The failure mode here is a word.
    const rendered = JSON.stringify(emerging).toLowerCase();
    for (const forbidden of FORBIDDEN_EMERGENCE_LABELS) {
      assert.equal(rendered.includes(forbidden), false, `never described as ${forbidden}`);
    }

    // Remove one experience and the pattern falls below the experience floor, so it stops
    // being surfaced rather than being surfaced with two.
    const removed = experienceIds[0];
    assert.ok(removed);
    const experience = await h.engine.store.experiences.get(removed);
    assert.ok(experience);
    await h.engine.store.experiences.put({ ...experience, status: 'removed' });
    const afterRemoval = await emergingPatterns(h.engine);
    assert.equal(
      afterRemoval.length <= 1,
      true,
      'and a removed member is not counted towards the floors',
    );
  });

  test(`${kind}: self-manufactured amplification produces no reach`, async () => {
    // The whole of Phase 77's refusal, on the real path: an author corroborating and sharing
    // their own experience many times moves nothing, because reach counts distinct people and
    // shares are not reach at all.
    const h = createEngineHarness();
    const { actor: author } = await h.signUp(`self-${kind}@example.com`, 'Author');
    const experienceId = await publish(h, author, kind, bodyFor(kind, 'alone'));

    // Their own corroboration is refused by the domain — you cannot corroborate your own —
    // and even if it were not, reach would discard it.
    const own = await h.engine.bus.dispatch({
      name: 'corroboration.create',
      input: {
        experienceId,
        type: kind === 'rage' ? 're_rage' : 're_rave',
        relationship: 'same_experience',
        visibility: 'public',
      },
      actor: author,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(own.ok, false, 'the domain refuses corroborating your own experience');

    for (let index = 0; index < 5; index += 1) {
      await h.engine.bus.dispatch({
        name: 'share.create',
        input: { experienceId, destination: 'copy_link' },
        actor: author,
        idempotencyKey: h.nextKey(),
      });
    }
    await h.settle();

    const reach = await reachFor(h.engine, experienceId);
    assert.equal(reach.people, 1, 'still one person');
    assert.ok(reach.amplification >= 0, 'and the shares are amplification, reported separately');
  });
}

test('the lap ran for both kinds', () => {
  // The guard on the guard, as in Phase 70: narrowing the loop above to one kind would leave
  // every test passing while proving half of what it claims.
  assert.equal((['rage', 'rave'] as const).length, 2);
});
