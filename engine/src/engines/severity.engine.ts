import { ok } from '../runtime/result.ts';
import { assertedValues } from '../domain/enrichment.ts';
import { classifySeverity, type SeverityClassification } from '../domain/severity.ts';
import { eq } from '../ports/store.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { CorroborationRow, SeverityRow } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { enrichmentKey } from './enrichment.engine.ts';

/**
 * Severity Classification — Phase 32, E8.
 *
 * There is no command here, only a consumer. That is the design, not an omission:
 * nobody *sets* a severity band. It is derived from what the experiencer asserted, so
 * a `severity.set` command would be a way to overwrite their account with somebody
 * else's opinion — including a moderator's.
 *
 * The classifier is given asserted values and a count of independent experiencers. It
 * is never given text, and there is no parameter through which text could reach it.
 * That is the only version of "severity is not inferred from wording" that survives a
 * later edit made in a hurry.
 */
export const severityKey = (experienceId: string): string => `sev:${experienceId}`;

const classificationFor = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<SeverityClassification> => {
  const enrichment = await deps.store.enrichments.get(enrichmentKey(experienceId));
  const independent = await deps.store.corroborations.countWhere([
    eq<CorroborationRow>('experienceId', experienceId),
    eq<CorroborationRow>('status', 'active'),
  ]);
  return classifySeverity({
    asserted: enrichment ? assertedValues(enrichment) : [],
    independentExperiencers: independent,
  });
};

const persist = async (deps: EngineDeps, experienceId: string): Promise<SeverityRow> => {
  const classification = await classificationFor(deps, experienceId);
  const row: SeverityRow = {
    id: severityKey(experienceId),
    experienceId,
    band: classification.band,
    confidence: classification.confidence,
    basis: [...classification.basis],
    independentExperiencers: classification.independentExperiencers,
    unassessed: classification.unassessed,
    classifiedAt: deps.clock.now(),
  };
  await deps.store.severities.put(row);
  return row;
};

/**
 * Reclassify on any event that changes an input.
 *
 * Corroboration events are included because `independentExperiencers` is part of the
 * classification — but note what that count does *not* do: it is recorded alongside
 * the band and never multiplies it. Ten people reporting an inconvenience is ten
 * reports of an inconvenience, not a serious failure.
 */
export const createSeverityConsumer = (deps: EngineDeps): Consumer => ({
  name: 'severity.classify',
  events: ['ExperienceEnriched', 'ExperienceReRaged', 'ExperienceReRaved', 'CorroborationRetracted'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    if (!experienceId) return ok(undefined);
    const row = await persist(deps, experienceId);
    deps.metrics.increment('severity.classified', { band: row.band });
    return ok(undefined);
  },
});

export const severityFor = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<SeverityRow | undefined> => deps.store.severities.get(severityKey(experienceId));

/** Classify on demand, for a caller that cannot wait for the consumer. */
export const classifyNow = async (deps: EngineDeps, experienceId: string): Promise<SeverityRow> =>
  persist(deps, experienceId);
