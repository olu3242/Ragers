import { eq } from '../ports/store.ts';
import { err, ok, type Result } from '../runtime/result.ts';
import { preconditionError, validationError, type EngineError } from '../runtime/errors.ts';
import type { RecommendationMemoryRow, RecommendationOutcome, RecommendationRow } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * What happened to a recommendation — E12, Phase 87.
 *
 * `recommendations` records what was concluded. Nothing recorded what happened to it, so an
 * operator surface re-offers a recommendation somebody dismissed last week, and nobody can tell
 * whether the ones acted on made any difference.
 *
 * ## The minimum that is necessary, and the omissions are the design
 *
 * The table (migration 0018) has **no free text and no actor column**, and both absences are
 * load-bearing rather than economical:
 *
 * A dismissal reason would become a record of one person's judgement about another person's
 * situation, written in a box nobody reviews and readable by every operator afterwards. Who
 * dismissed a recommendation is not needed to stop re-offering it, and storing it would make
 * this a log of individual operators' decisions — which is what `audit_events` is for, under a
 * rule (Phase 68) that governs what belongs there and why.
 *
 * **One row per recommendation, not per (recommendation, operator).** The question is whether
 * *this* recommendation is still live. Per-operator state would re-offer a dismissed
 * recommendation to somebody else, which is the behaviour the table exists to prevent.
 *
 * ## Why the outcomes are ordered
 *
 * `shown → dismissed` and `shown → accepted → acted_on`. A dismissal is terminal for this
 * recommendation — re-offering something somebody declined is the behaviour being fixed — and
 * `acted_on` requires an acceptance, enforced by a check constraint as well as here, because a
 * thing acted on without a decision is an effect nobody chose.
 */

/** The order outcomes may move in. Anything else is refused. */
const ALLOWED_TRANSITIONS: Readonly<Record<RecommendationOutcome, readonly RecommendationOutcome[]>> = {
  shown: ['dismissed', 'accepted'],
  // Terminal. Re-offering something somebody declined is exactly the behaviour this table
  // exists to prevent, so "un-dismiss" is not a transition — a genuinely new conclusion gets a
  // new recommendation with its own key.
  dismissed: [],
  accepted: ['acted_on'],
  acted_on: [],
};

/** The memory for one recommendation, or `undefined` when it has never been shown. */
export const memoryFor = async (
  deps: EngineDeps,
  recommendationId: string,
): Promise<RecommendationMemoryRow | undefined> => deps.store.recommendationMemory.get(recommendationId);

/**
 * Record that a recommendation was shown.
 *
 * Idempotent, and idempotent in the strong sense: showing something a second time must not
 * reset a dismissal, so an existing row is returned untouched rather than overwritten. Without
 * that, an operator surface that records a view on every render would silently revive
 * everything anybody had ever dismissed.
 */
export const recordShown = async (
  deps: EngineDeps,
  recommendationId: string,
): Promise<RecommendationMemoryRow> => {
  const existing = await deps.store.recommendationMemory.get(recommendationId);
  if (existing) return existing;

  const now = deps.clock.now();
  const row: RecommendationMemoryRow = {
    id: recommendationId,
    outcome: 'shown',
    shownAt: now,
    updatedAt: now,
  };
  const written = await deps.store.recommendationMemory.compareAndSet(row, 'absent');
  if (written) {
    deps.metrics.increment('recommendation.shown');
    return row;
  }
  // Somebody else wrote it between the read and the write. Theirs stands.
  return (await deps.store.recommendationMemory.get(recommendationId)) ?? row;
};

export interface RecordOutcomeInput {
  readonly recommendationId: string;
  readonly outcome: RecommendationOutcome;
  /** The plan an acceptance produced, when it produced one. */
  readonly planId?: string;
}

/**
 * Move a recommendation's outcome.
 *
 * Refuses a transition that is not in the table above, and refuses an outcome for a
 * recommendation that does not exist — a memory of something unrecommended is a row nothing
 * can explain.
 *
 * The timestamps are set alongside the outcome rather than derived later, because the check
 * constraints tie them together: a row saying `dismissed` with no `dismissedAt` would make a
 * series derived from the timestamps silently skip it.
 */
export const recordOutcome = async (
  deps: EngineDeps,
  input: RecordOutcomeInput,
): Promise<Result<RecommendationMemoryRow, EngineError>> => {
  if (input.outcome === 'shown') {
    return err(validationError('use_record_shown', 'showing something is recorded by recordShown'));
  }
  const recommendation = await deps.store.recommendations.get(input.recommendationId);
  if (!recommendation) {
    return err(
      validationError('no_such_recommendation', 'a memory of something unrecommended explains nothing'),
    );
  }

  const current = await recordShown(deps, input.recommendationId);
  const allowed = ALLOWED_TRANSITIONS[current.outcome];
  if (!allowed.includes(input.outcome)) {
    return err(
      preconditionError(
        'outcome_not_allowed',
        `a recommendation that is ${current.outcome} cannot become ${input.outcome}`,
      ),
    );
  }

  const now = deps.clock.now();
  const moved: RecommendationMemoryRow = {
    ...current,
    outcome: input.outcome,
    ...(input.outcome === 'dismissed' ? { dismissedAt: now } : {}),
    ...(input.outcome === 'accepted' ? { acceptedAt: now } : {}),
    ...(input.outcome === 'acted_on' ? { actedOnAt: now } : {}),
    ...(input.planId === undefined ? {} : { planId: input.planId }),
    updatedAt: now,
  };

  // Pinned to the outcome we read, so two operators acting at once cannot both move it.
  const won = await deps.store.recommendationMemory.compareAndSet(moved, [
    eq<RecommendationMemoryRow>('outcome', current.outcome),
  ]);
  if (!won) {
    return err(
      preconditionError('outcome_changed', 'somebody else moved this recommendation first'),
    );
  }
  deps.metrics.increment('recommendation.outcome', { outcome: input.outcome });
  return ok(moved);
};

/**
 * The recommendations still worth offering.
 *
 * A recommendation with no memory is live — the absence of a row means nobody has seen it, not
 * that something is wrong. Dismissed and acted-on ones are gone; `accepted` stays, because an
 * acceptance whose plan has not run yet is still outstanding work and hiding it would lose it.
 */
export const liveRecommendationsFor = async (
  deps: EngineDeps,
  subjectId: string,
): Promise<readonly RecommendationRow[]> => {
  const all = await deps.store.recommendations.query([eq<RecommendationRow>('subjectId', subjectId)]);
  const live: RecommendationRow[] = [];
  for (const row of all) {
    const memory = await deps.store.recommendationMemory.get(row.id);
    if (memory === undefined || memory.outcome === 'shown' || memory.outcome === 'accepted') {
      live.push(row);
    }
  }
  return live;
};

/**
 * Whether the recommendations acted on made any difference — as facts, not a verdict.
 *
 * Counts only. No rate, and deliberately: a "recommendation acceptance rate" per operator or
 * per organization is a performance metric about people doing judgement work, and the moment it
 * exists somebody optimises it by accepting more.
 */
export interface MemoryTally {
  readonly shown: number;
  readonly dismissed: number;
  readonly accepted: number;
  readonly actedOn: number;
  /** Acceptances whose plan refused every step. `decision != effect`, as a number. */
  readonly acceptedWithNoEffect: number;
}

export const tallyMemory = async (deps: EngineDeps): Promise<MemoryTally> => {
  const rows = await deps.store.recommendationMemory.query([]);
  let acceptedWithNoEffect = 0;
  for (const row of rows) {
    if (row.planId === undefined) continue;
    const plan = await deps.store.actionPlans.get(row.planId);
    // `failed` means every step was refused. The approval happened and nothing followed from
    // it, which is the shape this codebase means by `decision != effect`.
    if (plan?.status === 'failed') acceptedWithNoEffect += 1;
  }
  return {
    shown: rows.filter((row) => row.outcome === 'shown').length,
    dismissed: rows.filter((row) => row.outcome === 'dismissed').length,
    accepted: rows.filter((row) => row.outcome === 'accepted').length,
    actedOn: rows.filter((row) => row.outcome === 'acted_on').length,
    acceptedWithNoEffect,
  };
};

/**
 * The absences, as code.
 *
 * `memoryRecordsWhoDismissed` and `memoryRecordsWhy` are the two fields this table refuses,
 * stated as functions so the refusal is assertable rather than merely absent from a migration
 * somebody would have to read. `memoryRanksOperators` is the read that would follow from either
 * one existing.
 */
export const memoryRecordsWhoDismissed = (): false => false;
export const memoryRecordsWhy = (): false => false;
export const memoryRanksOperators = (): undefined => undefined;
