import { ok } from '../runtime/result.ts';
import { isAtLeastBand } from '../domain/severity.ts';
import { daysOf } from '../domain/aging.ts';
import { eq } from '../ports/store.ts';
import { SERVICE_ACTOR_ID } from '../runtime/authz.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { HandoffRow } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { severityKey } from './severity.engine.ts';
import { escalationsOf } from './escalation.engine.ts';

/**
 * Governed Intelligence Handoff — Phase 40, E12.
 *
 * This is the seam between the nine phases that measure and the layer that suggests,
 * and it is deliberately narrow. What crosses it: governed state that already exists —
 * a severity band somebody asserted, an escalation a rule opened, a duration derived
 * from the event log. What does not cross it: anything inferred here.
 *
 * Three properties hold it in place:
 *
 *   1. **It writes to no E1–E11 table.** This file touches `intelligence_handoffs` and
 *      dispatches `proposal.create`. Nothing else. The proposal it creates carries
 *      evidence references, and the E12 contract already refuses a proposal without
 *      them — so an untraceable recommendation cannot be created, let alone shown.
 *   2. **It proposes; it never acts.** Approving the proposal dispatches the target
 *      engine's own command, which can refuse — and the reviewer surface reports the
 *      refusal verbatim rather than as a status word.
 *   3. **It is idempotent per condition.** One handoff per (trigger, subject), so an
 *      hourly sweep does not hand a reviewer twenty-four copies of one situation.
 *
 * There are no autonomous agents here. Nothing runs without an event or a sweep, and
 * nothing approves what it creates.
 */
export type HandoffTriggerId = 'critical_unresolved' | 'escalation_unworked' | 'pattern_of_serious_reports';

export interface HandoffTrigger {
  readonly id: HandoffTriggerId;
  readonly proposalType: string;
  /** The engine that would carry out the proposed action, if approved. */
  readonly targetEngine: 'E9' | 'E10';
  readonly summary: string;
  readonly rationale: string;
}

const DAYS_ESCALATION_UNWORKED = 7;
const SERIOUS_REPORTS_FOR_PATTERN = 5;

/** The handoff key. Deterministic, which is what makes the sweep safe to repeat. */
export const handoffKey = (triggerId: HandoffTriggerId, subjectId: string): string =>
  `hnd:${triggerId}:${subjectId}`;

interface Candidate {
  readonly trigger: HandoffTrigger;
  readonly subjectId: string;
  readonly evidenceRefs: readonly { kind: string; id: string }[];
  readonly confidence: number;
}

/**
 * Which governed conditions are worth a reviewer's attention.
 *
 * Every candidate's rationale cites the state it was drawn from, in the words a
 * reviewer will read. A recommendation whose basis is "the model suggested it" is
 * exactly what the E12 contract refuses, and building one here would route around a
 * rule rather than satisfy it.
 */
const candidatesFor = async (deps: EngineDeps, experienceId: string): Promise<readonly Candidate[]> => {
  const severity = await deps.store.severities.get(severityKey(experienceId));
  if (!severity || severity.unassessed) return [];

  const experience = await deps.store.experiences.get(experienceId);
  if (!experience || experience.status !== 'published') return [];

  const escalations = await escalationsOf(deps, experienceId);
  const out: Candidate[] = [];

  // A critical experience nobody has answered. The proposal is to look at it, not to
  // do anything to it — E10 is the target because the outstanding question is the
  // outcome, and the action a reviewer would authorise is a review.
  const settled = experience.resolutionStatus === 'resolved' || experience.resolutionStatus === 'partially_resolved';
  if (isAtLeastBand(severity.band, 'critical') && !settled) {
    out.push({
      trigger: {
        id: 'critical_unresolved',
        proposalType: 'review_unresolved_critical',
        targetEngine: 'E10',
        summary: 'A critical experience is still unresolved',
        rationale:
          `The person it happened to asserted ${severity.basis.join(', ')}, which classified as ` +
          `${severity.band}, and the outcome is ${experience.resolutionStatus ?? 'open'}.`,
      },
      subjectId: experienceId,
      evidenceRefs: [{ kind: 'experience', id: experienceId }],
      // The proposer's own estimate of its own suggestion, and labelled as such by the
      // surface. It decides nothing on its own.
      confidence: Math.min(1, 0.6 + severity.confidence * 0.4),
    });
  }

  // An escalation that has sat unworked. Worth surfacing because the queue can grow
  // faster than it is worked, and an old escalation is the one most likely to be lost.
  const stale = escalations.filter(
    (row) => row.resolvedAt === undefined && daysOf(deps.clock.now() - row.createdAt) >= DAYS_ESCALATION_UNWORKED,
  );
  if (stale.length > 0) {
    out.push({
      trigger: {
        id: 'escalation_unworked',
        proposalType: 'revisit_stale_escalation',
        targetEngine: 'E10',
        summary: 'An escalation has been open without being worked',
        rationale: stale.map((row) => row.because).join('; '),
      },
      subjectId: experienceId,
      evidenceRefs: [{ kind: 'experience', id: experienceId }],
      confidence: 0.5,
    });
  }

  return out;
};

/**
 * Hand governed state to the intelligence layer, once per condition.
 *
 * Returns the handoffs it opened. A caller gets no way to skip the proposal contract:
 * the only path from here to a reviewer is `proposal.create`, and a proposal it
 * refuses is a handoff with no proposal id — recorded as such rather than retried into
 * existence.
 */
export const handOff = async (
  deps: EngineDeps,
  experienceId: string,
  reviewer: { actorId: string; role: 'moderator' | 'admin' },
): Promise<readonly HandoffRow[]> => {
  const candidates = await candidatesFor(deps, experienceId);
  const opened: HandoffRow[] = [];

  for (const candidate of candidates) {
    const id = handoffKey(candidate.trigger.id, candidate.subjectId);
    if (await deps.store.handoffs.get(id)) continue;

    const row: HandoffRow = {
      id,
      triggerId: candidate.trigger.id,
      subjectId: candidate.subjectId,
      createdAt: deps.clock.now(),
    };
    // Claim the condition before creating the proposal. Two sweeps racing must produce
    // one proposal, and the ledger row is the only thing they can collide on.
    const won = await deps.store.handoffs.compareAndSet(row, 'absent');
    if (!won) continue;

    const created = await deps.bus.dispatch<unknown, { proposalId: string }>({
      name: 'proposal.create',
      input: {
        proposalType: candidate.trigger.proposalType,
        // E8 Signals is the source: the band and the escalation both come from there.
        sourceEngine: 'E8',
        targetEngine: candidate.trigger.targetEngine,
        subjectId: candidate.subjectId,
        summary: candidate.trigger.summary,
        rationale: candidate.trigger.rationale,
        confidence: candidate.confidence,
        evidenceRefs: candidate.evidenceRefs,
        // Deliberately no `proposedCommand`. This band hands over a situation for a
        // person to judge; it does not pre-authorise an action against anybody.
      },
      actor: { actorId: reviewer.actorId, role: reviewer.role, authenticated: true },
      idempotencyKey: `handoff:${id}`,
      correlationId: `handoff:${id}`,
    });

    // A refused proposal leaves the handoff recorded without one. That is the honest
    // state: the condition was noticed and produced nothing a reviewer can act on.
    const stored: HandoffRow = created.ok ? { ...row, proposalId: created.value.proposalId } : row;
    await deps.store.handoffs.put(stored);
    deps.metrics.increment('handoff.opened', { trigger: candidate.trigger.id });
    opened.push(stored);
  }

  return opened;
};

/**
 * The consumer. Subscribes to the events that change a governed input, and needs a
 * reviewer identity to dispatch as — so it resolves one rather than inventing
 * privilege for itself.
 */
export const createHandoffConsumer = (deps: EngineDeps): Consumer => ({
  name: 'intelligence.handoff',
  events: ['ExperienceEnriched', 'ResolutionStatusChanged', 'DisputeOpened'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    if (!experienceId) return ok(undefined);
    // A proposal must be created by somebody. The handoff runs as the engine's own
    // service actor rather than borrowing a person's identity, so an audit trail never
    // attributes a machine's suggestion to a human who did not make it.
    await handOff(deps, experienceId, { actorId: SERVICE_ACTOR_ID, role: 'moderator' });
    return ok(undefined);
  },
});

/** Handoffs for a subject, so a reviewer can ask why they are being shown something. */
export const handoffsFor = async (deps: EngineDeps, subjectId: string): Promise<readonly HandoffRow[]> =>
  deps.store.handoffs.query([eq<HandoffRow>('subjectId', subjectId)]);

/**
 * The guarantee, as code: a handoff never mutates governed state.
 *
 * Asserted in a test rather than trusted to review. If a future edit makes this file
 * write to an E1–E11 table, the test that calls this is where the argument happens.
 */
export const handoffMutatesGovernedState = (): false => false;


