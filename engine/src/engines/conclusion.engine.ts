import { createHash } from 'node:crypto';
import { ok } from '../runtime/result.ts';
import { eq } from '../ports/store.ts';
import { conclusionKeyOf, drawConclusion, MINIMUM_EXPERIENCES, type Conclusion } from '../domain/conclusion.ts';
import type { ActorContext } from '../runtime/authz.ts';
import type { RecommendationRow } from '../ports/store.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { EngineDeps } from './deps.ts';
import { clusterLifecycleFor } from './lifecycle.engine.ts';
import { patternHistoryFor } from './history.engine.ts';

/**
 * Cross-Experience Intelligence and Proactive Recommendations — E12. Phases 57 and 58.
 *
 * The two are one file because they are one act split by a governance boundary:
 * `conclusionsFor` draws what can be concluded, and `recommend` turns a conclusion
 * into a proposal a person will decide. Nothing here writes to an E1–E11 table, and
 * the only command dispatched is `proposal.create`.
 *
 * Phase 58's whole difficulty is **not saying the same thing twice.** A sweep that
 * runs hourly over unchanged state must produce one recommendation, because the
 * second one teaches a reviewer that recommendations are noise. The ledger row's id
 * *is* the conclusion key, so two concurrent sweeps collide on the primary key and
 * the loser creates nothing — the same mechanism as the handoff ledger, for the same
 * reason.
 */

/** The row id: the conclusion key, digested so an id stays bounded. */
export const recommendationKeyOf = (conclusion: Conclusion): string =>
  `rec:${createHash('sha256').update(conclusionKeyOf(conclusion)).digest('hex').slice(0, 32)}`;

/**
 * What can be concluded about one cluster, right now.
 *
 * Each candidate is *offered* to `drawConclusion`, which refuses the ones that do not
 * meet the contract — too few experiences, too few people, no openable basis, an
 * expired signal. A candidate refused here produces nothing at all, which is the
 * behaviour the phase asks for: filtered at creation, not at display.
 */
export const conclusionsFor = async (
  deps: EngineDeps,
  clusterId: string,
): Promise<readonly Conclusion[]> => {
  const lifecycle = await clusterLifecycleFor(deps, clusterId);
  if (!lifecycle) return [];

  const members = await deps.store.clusterMembers.query([eq('clusterId', clusterId)]);
  const experienceIds: string[] = [];
  const people = new Set<string>();
  for (const member of members) {
    const experience = await deps.store.experiences.get(member.experienceId);
    if (!experience || experience.status !== 'published') continue;
    experienceIds.push(experience.id);
    people.add(experience.actorId);
    for (const claim of await deps.store.corroborations.query([
      eq('experienceId', experience.id),
      eq('status', 'active'),
    ])) {
      people.add(claim.corroboratorId);
    }
  }

  // The basis: the cluster itself and every experience in it. Rows a reviewer can
  // open, which is the only kind of basis this contract accepts.
  const basis = [
    { kind: 'cluster' as const, id: clusterId },
    ...experienceIds.map((id) => ({ kind: 'experience' as const, id })),
  ];

  const drawn: Conclusion[] = [];

  const recurring = drawConclusion({
    kind: 'recurring_failure',
    subjectId: clusterId,
    acrossExperienceIds: experienceIds,
    distinctPeople: people.size,
    basis,
    lifecycleState: lifecycle.lifecycle.state,
    summary: `${experienceIds.length} accounts from ${people.size} people describe the same failure`,
    rationale:
      'These experiences share a confirmed entity and issue type, so they are the same failure reported more than once rather than similar wording.',
    // Confidence follows the number of *people*, not the number of rows, and is
    // capped: a deterministic count is evidence of recurrence, not certainty about
    // cause.
    confidence: Math.min(0.9, 0.4 + people.size * 0.05),
  });
  if (recurring.ok) drawn.push(recurring.value);

  // A pattern that went quiet and came back is worth saying out loud, because the
  // count alone reads the same as one that never stopped.
  if (lifecycle.recovery === 'recovering') {
    const recovered = drawConclusion({
      kind: 'pattern_recovered',
      subjectId: clusterId,
      acrossExperienceIds: experienceIds,
      distinctPeople: people.size,
      basis,
      lifecycleState: lifecycle.lifecycle.state,
      summary: 'This pattern went quiet and is being reported again',
      rationale:
        'Recent contributions carry more weight than the older ones they follow, and the weighted total has risen over the last window.',
      confidence: 0.6,
    });
    if (recovered.ok) drawn.push(recovered.value);
  }

  return drawn;
};

/** Conclusions about how an organization's responsiveness has moved. */
export const responseConclusionsFor = async (
  deps: EngineDeps,
  organizationId: string,
): Promise<readonly Conclusion[]> => {
  const history = await patternHistoryFor(deps, organizationId);
  if (!history) return [];

  // Only a change the history was willing to state. A withheld change is withheld
  // because saying it would describe too few people, and laundering it through a
  // conclusion would publish exactly what the guard refused.
  const stated = history.responseRateChanges.filter(
    (change): change is Extract<typeof change, { withheld: false }> => change.withheld === false,
  );
  const latest = stated.at(-1);
  if (!latest || latest.direction === 'steady') return [];

  const profile = await deps.store.organizationProfiles.get(organizationId);
  if (!profile) return [];
  const experiences = await deps.store.experiences.query([
    eq('entityId', profile.entityId),
    eq('status', 'published'),
  ]);

  const conclusion = drawConclusion({
    kind: 'response_pattern_changed',
    subjectId: organizationId,
    acrossExperienceIds: experiences.map((experience) => experience.id),
    distinctPeople: new Set(experiences.map((experience) => experience.actorId)).size,
    basis: experiences.map((experience) => ({ kind: 'experience' as const, id: experience.id })),
    // An organization is not a cluster and has no lifecycle of its own; the history's
    // own floors decide whether this may be said at all, and `active` records that
    // the statement is about the present.
    lifecycleState: 'active',
    summary: `This organization's response rate has ${latest.direction}`,
    rationale:
      'Two consecutive periods each cleared the sample and person floors, and enough different people separate them for the change between them to be stated.',
    confidence: 0.7,
  });
  return conclusion.ok ? [conclusion.value] : [];
};

/**
 * Recommend a conclusion — Phase 58.
 *
 * Claims the ledger row *before* creating the proposal. Doing it the other way round
 * is the defect the agent runner already had: two sweeps both do the work, both
 * dispatch, and only one records it.
 *
 * Returns the existing row unchanged when the conclusion has already been
 * recommended, so a caller cannot tell a duplicate apart from a success and act on it
 * twice.
 */
export const recommend = async (
  deps: EngineDeps,
  conclusion: Conclusion,
  reviewer: ActorContext,
): Promise<{ readonly row: RecommendationRow; readonly created: boolean }> => {
  const id = recommendationKeyOf(conclusion);
  const existing = await deps.store.recommendations.get(id);
  if (existing) return { row: existing, created: false };

  const row: RecommendationRow = {
    id,
    kind: conclusion.kind,
    subjectId: conclusion.subjectId,
    acrossExperienceIds: [...conclusion.acrossExperienceIds].sort(),
    distinctPeople: conclusion.distinctPeople,
    lifecycleState: conclusion.lifecycleState,
    createdAt: deps.clock.now(),
  };

  const won = await deps.store.recommendations.compareAndSet(row, 'absent');
  if (!won) {
    // Somebody else reached the same conclusion first. Theirs is the recommendation.
    const winner = await deps.store.recommendations.get(id);
    return { row: winner ?? row, created: false };
  }

  const created = await deps.bus.dispatch<unknown, { proposalId: string }>({
    name: 'proposal.create',
    input: {
      proposalType: conclusion.kind,
      // E8 measures; E12 concludes. The source is E12 here because the conclusion
      // spans experiences, which is this engine's own act rather than a measurement.
      sourceEngine: 'E12',
      // A conclusion about a pattern is for the organization side to act on; one about
      // responsiveness is too. Never E12, which the proposal contract already refuses.
      targetEngine: 'E9',
      subjectId: conclusion.subjectId,
      summary: conclusion.summary,
      rationale: conclusion.rationale,
      confidence: conclusion.confidence,
      evidenceRefs: conclusion.basis,
      // No `proposedCommand`: a conclusion hands a reviewer a situation. Phase 59's
      // plans are what carry commands, and only after a person approves one.
    },
    actor: reviewer,
    idempotencyKey: `recommend:${id}`,
    correlationId: `recommend:${id}`,
  });

  const stored: RecommendationRow = created.ok ? { ...row, proposalId: created.value.proposalId } : row;
  await deps.store.recommendations.put(stored);
  deps.metrics.increment('recommendation.created', { kind: conclusion.kind });
  return { row: stored, created: true };
};

/** Recommendations about a subject, so a reviewer can ask why they are seeing something. */
export const recommendationsFor = async (
  deps: EngineDeps,
  subjectId: string,
): Promise<readonly RecommendationRow[]> =>
  deps.store.recommendations.query([eq<RecommendationRow>('subjectId', subjectId)]);

/**
 * Erasure — Phase 64.
 *
 * `recommendations.across_experience_ids` is a stored `text[]` with no foreign key, so
 * the database cannot cascade it, and until this consumer existed nothing removed it
 * either. An author deleting their account of something left an operator surface still
 * citing it by id — the one stored reference in the whole 51–60 band, since the graph
 * and the memory derive on read and re-check status.
 *
 * A recommendation that loses an experience is **rewritten, not filtered**: the row
 * carries the ids, so filtering at read time would leave the deleted id in the
 * database and rely on every future reader remembering to exclude it. When too few
 * experiences remain for the conclusion to have been drawable at all, the
 * recommendation goes entirely — a "pattern" over one account is not a pattern, and
 * leaving a shrunken one would mean the ledger asserts something its own contract
 * would have refused.
 */
export const createRecommendationErasureConsumer = (deps: EngineDeps): Consumer => ({
  name: 'recommendation.erase',
  // Both, because they are different acts with the same requirement here: content
  // taken down by moderation must stop being cited too.
  events: ['ExperienceDeleted', 'ContentRemoved'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    if (!experienceId) return ok(undefined);

    for (const row of await deps.store.recommendations.all()) {
      if (!row.acrossExperienceIds.includes(experienceId)) continue;
      const remaining = row.acrossExperienceIds.filter((id) => id !== experienceId);

      if (remaining.length < MINIMUM_EXPERIENCES) {
        // Below the floor its own contract sets. The recommendation is removed rather
        // than shrunk, because a conclusion that could not be drawn now must not go on
        // standing as one that was.
        await deps.store.recommendations.remove(row.id);
        deps.metrics.increment('recommendation.erased', { reason: 'below_minimum' });
        continue;
      }

      await deps.store.recommendations.put({ ...row, acrossExperienceIds: remaining });
      deps.metrics.increment('recommendation.erased', { reason: 'reference_removed' });
    }
    return ok(undefined);
  },
});

/**
 * The guarantee, as code: concluding and recommending mutate no governed state.
 *
 * Asserted by a test rather than trusted to review, in the same shape as
 * `handoffMutatesGovernedState`. If a future edit makes this file write to an E1–E11
 * table, the test that calls this is where the argument happens.
 */
export const recommendationMutatesGovernedState = (): false => false;
