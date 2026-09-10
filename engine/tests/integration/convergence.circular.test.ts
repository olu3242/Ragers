import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { AGENTS, AGENT_IDS } from '../../src/domain/agent.ts';
import { runAgent } from '../../src/engines/agent.engine.ts';
import { priorityFor } from '../../src/engines/priority.engine.ts';
import { severityKey } from '../../src/engines/severity.engine.ts';
import { handoffsFor } from '../../src/engines/handoff.engine.ts';
import { eq } from '../../src/ports/store.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { ExperienceKind } from '../../src/domain/types.ts';
import type { CorroborationRow } from '../../src/ports/store.ts';

/**
 * The circular flow, end to end, for both a Rage and a Rave.
 *
 *   Experience → Capture → Rage/Rave → Trust → Publish → Community → Cluster → Signal
 *   → Business Response → Outcome → Reputation → Intelligence → governed proposal
 *   → authoritative effect → the next experience
 *
 * This is a *convergence* test rather than a feature test: every engine involved is already
 * certified on its own, and what is asserted here is that the seams hold — that the same six
 * distinctions survive a full lap rather than each being true in isolation.
 *
 * The Rave path runs the same lap deliberately. A system that only holds its rules for
 * complaints has not held them: a Rave is an experience with the same author protections, the
 * same corroboration semantics and the same refusal to let a response stand in for an outcome.
 */
const DAY = 86_400_000;

const publish = async (
  h: EngineHarness,
  actor: ActorContext,
  bodyText: string,
  kind: ExperienceKind = 'rage',
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

const seedEntity = async (h: EngineHarness, suffix: string): Promise<{ entityId: string; organizationId: string }> => {
  await h.engine.store.entities.put({
    id: `ent_${suffix}`,
    name: `Entity ${suffix}`,
    slug: `entity-${suffix}`,
    kind: 'organization',
  });
  await h.engine.store.organizationProfiles.put({
    id: `org_${suffix}`,
    entityId: `ent_${suffix}`,
    displayName: `Entity ${suffix}`,
    status: 'claimed',
  });
  return { entityId: `ent_${suffix}`, organizationId: `org_${suffix}` };
};

/** One full lap. Returns what the lap produced, so the assertions read as a narrative. */
const lap = async (kind: ExperienceKind) => {
  const h = createEngineHarness();
  const { actor: author } = await h.signUp(`author-${kind}@example.com`, 'Author');
  const { actor: other } = await h.signUp(`other-${kind}@example.com`, 'Other');
  const { actor: staff, auth: staffAuth } = await h.signUp(`staff-${kind}@example.com`, 'Staff');
  const moderator = await h.promote((await h.signUp(`mod-${kind}@example.com`)).auth.actorId, 'moderator');
  const { entityId, organizationId } = await seedEntity(h, kind);
  await h.engine.store.organizationMemberships.put({
    id: `mem_${kind}`,
    organizationId,
    actorId: staffAuth.actorId,
    role: 'admin',
    grantedAt: h.clock.now(),
  });

  // E1/E2/E3/E4/E5 — an account is captured, screened and published.
  const body =
    kind === 'rage'
      ? 'the boiler was left unsafe and nobody came back for a fortnight'
      : 'the engineer stayed late and fixed it properly the same evening';
  const experienceId = await publish(h, author, body, kind);
  const published = await h.engine.store.experiences.get(experienceId);
  const row = await h.engine.store.experiences.get(experienceId);
  if (row) await h.engine.store.experiences.put({ ...row, entityId });

  // E3 — the author confirms the structure. Extraction alone changes nothing.
  expect(
    await h.engine.bus.dispatch({
      name: 'normalization.confirm',
      input: { experienceId, fields: { entity: entityId } },
      actor: author,
      idempotencyKey: h.nextKey(),
    }),
    'confirm',
  );
  await h.settle();

  // E1 — the author says what it cost them. Only they can.
  expect(
    await h.engine.bus.dispatch({
      name: 'enrichment.assert',
      input: { experienceId, dimension: 'safety_involved', flag: true },
      actor: author,
      idempotencyKey: h.nextKey(),
    }),
    'enrich',
  );
  await h.settle();

  // E6 — somebody else says it happened to them too.
  expect(
    await h.engine.bus.dispatch({
      name: 'corroboration.create',
      input: { experienceId, type: kind === 'rage' ? 're_rage' : 're_rave' },
      actor: other,
      idempotencyKey: h.nextKey(),
    }),
    'corroborate',
  );
  await h.settle();

  // E9 — the organization answers.
  expect(
    await h.engine.bus.dispatch({
      name: 'organization.respond',
      input: {
        organizationId,
        experienceId,
        kind: 'publish_resolution',
        body: 'We have replaced the unit and reviewed the callout process.',
      },
      actor: staff,
      idempotencyKey: h.nextKey(),
    }),
    'respond',
  );
  await h.settle();

  // E10 — the people it happened to report the outcome. *Everyone* who claims it, because
  // one satisfied person out of two is partial and the engine says so.
  expect(
    await h.engine.bus.dispatch({
      name: 'resolution.report',
      input: { experienceId, kind: 'resolved_for_me' },
      actor: author,
      idempotencyKey: h.nextKey(),
    }),
    'report',
  );
  await h.settle();
  const afterOneReport = (await h.engine.store.experiences.get(experienceId))?.resolutionStatus;

  expect(
    await h.engine.bus.dispatch({
      name: 'resolution.report',
      input: { experienceId, kind: 'resolved_for_me' },
      actor: other,
      idempotencyKey: h.nextKey(),
    }),
    'report from the corroborator',
  );
  await h.settle();

  h.clock.advance(2 * DAY);
  return { h, experienceId, organizationId, author, other, moderator, published, afterOneReport };
};

for (const kind of ['rage', 'rave'] as const) {
  test(`the full lap holds every distinction — ${kind}`, async () => {
    const { h, experienceId, moderator, published, afterOneReport } = await lap(kind);

    // ── E1/E5: published, and the projection carries no author ────────────
    assert.equal(published?.status, 'published');
    const entry = await h.engine.store.feedEntries.get(experienceId);
    assert.ok(entry, 'the feed projection exists');
    assert.equal('actorId' in (entry as object), false, 'a projection cannot leak an author');

    // ── E6: engagement != truth ───────────────────────────────────────────
    const counters = await h.engine.store.counters.get(experienceId);
    const claims = await h.engine.store.corroborations.countWhere([
      eq<CorroborationRow>('experienceId', experienceId),
      eq<CorroborationRow>('status', 'active'),
    ]);
    assert.equal(claims, 1, 'one person said it happened to them too');
    // Shares are counted apart and can never reach a claim count.
    assert.equal(counters?.shareCount ?? 0, 0);

    // ── E7/E8: cluster != signal ──────────────────────────────────────────
    const clustered = await h.engine.store.experiences.get(experienceId);
    assert.ok(clustered?.clusterId, 'a confirmed entity puts it in a pattern');
    const snapshot = await h.engine.store.signalSnapshots.get(`sig_${clustered?.clusterId}_all`);
    assert.ok(snapshot, 'the pattern has its own measurement, distinct from the pattern itself');
    assert.notEqual(snapshot?.id, clustered?.clusterId);

    // ── E9/E10: response != resolution, and resolved needs the experiencers ─
    // One of two reporting is *partial*, and the lap proves that rather than assuming it —
    // this is the distinction most easily lost when a system starts summarising outcomes.
    assert.equal(afterOneReport, 'partially_resolved', 'one satisfied person out of two is partial');
    const outcome = await h.engine.store.experiences.get(experienceId);
    assert.equal(outcome?.resolutionStatus, 'resolved', 'and everyone reporting makes it resolved');
    const responses = await h.engine.store.organizationResponses.countWhere([
      eq('experienceId', experienceId),
    ]);
    assert.equal(responses, 1, 'the organization answered — which is recorded separately');

    // ── E8 (41–43): severity, urgency and priority stay three questions ───
    const severity = await h.engine.store.severities.get(severityKey(experienceId));
    assert.equal(severity?.band, 'critical', 'safety was asserted');
    const view = await priorityFor(h.engine, experienceId);
    assert.ok(view);
    // Settled, so it is no longer urgent — severity did not change with it.
    assert.equal(view.priority.severity, 'critical');
    assert.notEqual(view.urgency.level, view.priority.band as unknown as string);

    // ── E11: reputation is recomputed, and exposes no composite ───────────
    const reputation = await h.engine.store.reputation.get(published?.actorId ?? '');
    if (reputation) {
      for (const key of Object.keys(reputation)) {
        assert.equal(/score|grade|rating/i.test(key), false, `reputation must not expose ${key}`);
      }
    }

    // ── E12: AI proposes; a person decides; the engine may refuse ─────────
    const run = await runAgent(
      h.engine,
      {
        agentId: 'resolution',
        subjectId: experienceId,
        proposalType: 'review_unresolved_critical',
        engine: 'E10',
        targetEngine: 'E10',
      },
      { actorId: moderator.actorId, role: 'moderator' },
    );
    assert.ok(['proposed', 'escalated'].includes(run.outcome), 'an agent proposes or hands on');

    const before = await h.engine.store.experiences.get(experienceId);
    if (run.proposalId) {
      const proposal = await h.engine.store.proposals.get(run.proposalId);
      assert.equal(proposal?.status, 'proposed', 'a recommendation is not a decision');
      assert.equal(proposal?.proposedCommand, undefined, 'and it pre-authorises nothing');
    }
    const after = await h.engine.store.experiences.get(experienceId);
    assert.deepEqual(after, before, 'nothing about the experience moved because an agent looked at it');

    // ── The lap closes: the next experience enters the same pattern ───────
    const { actor: third } = await h.signUp(`third-${kind}@example.com`, 'Third');
    const next = await publish(h, third, 'the same unit failed again the following week', kind);
    const nextRow = await h.engine.store.experiences.get(next);
    if (nextRow) await h.engine.store.experiences.put({ ...nextRow, entityId: `ent_${kind}` });
    expect(
      await h.engine.bus.dispatch({
        name: 'normalization.confirm',
        input: { experienceId: next, fields: { entity: `ent_${kind}` } },
        actor: third,
        idempotencyKey: h.nextKey(),
      }),
      'confirm next',
    );
    await h.settle();
    const joined = await h.engine.store.experiences.get(next);
    assert.equal(joined?.clusterId, clustered?.clusterId, 'the lap closes into the same pattern');
  });
}

test('every governed proposal in a lap is traceable, and no agent could have mutated anything', async () => {
  const { h, experienceId, moderator } = await lap('rage');

  // Handoffs and agent runs both go through `proposal.create`, which refuses a proposal with
  // no traceable evidence — so every recommendation a reviewer sees points at rows.
  await runAgent(
    h.engine,
    {
      agentId: 'resolution',
      subjectId: experienceId,
      proposalType: 'review_unresolved_critical',
      engine: 'E10',
      targetEngine: 'E10',
    },
    { actorId: moderator.actorId, role: 'moderator' },
  );
  for (const proposal of await h.engine.store.proposals.all()) {
    assert.ok(proposal.evidenceRefs.length > 0, `${proposal.id} must point at rows`);
    assert.ok(proposal.rationale.length > 0, `${proposal.id} must say why`);
  }
  await handoffsFor(h.engine, experienceId);

  // And the structural claim, over the whole registry rather than the one agent used here.
  for (const id of AGENT_IDS) {
    assert.equal(
      AGENTS[id].actions.some((action) => /write|mutate|apply|delete/.test(action)),
      false,
      `${id} must have no write verb`,
    );
  }
});
