import { err, ok } from '../runtime/result.ts';
import { preconditionError } from '../runtime/errors.ts';
import {
  assertDimension,
  assertedValues,
  fingerprintOf,
  isSameContent,
  withDimension,
  type ExperienceEnrichment,
} from '../domain/enrichment.ts';
import { confirmedValue } from '../domain/normalization.ts';
import { redactedTextFor } from './normalization.engine.ts';
import { eq } from '../ports/store.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { EnrichmentRow } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { experienceResource, loadExperience } from './support.ts';

/**
 * Structured Experience Enrichment — Phase 31, E1.
 *
 * The engine's contribution over the domain module is where the *confirmed* structure
 * comes from. The fingerprint reads `experience_metadata.confirmed`, never `extracted`
 * — so an entity the person has not confirmed contributes an empty segment, and
 * extraction cannot become agreement by a second route.
 *
 * Near-duplicate detection returns matches and does nothing else. There is no path in
 * this file that hides, removes or blocks anything on a fingerprint match: somebody
 * re-posting a corrected account would otherwise vanish, and that is a worse failure
 * than a duplicate on a feed.
 */
export const enrichmentKey = (experienceId: string): string => `enr:${experienceId}`;

export interface AssertEnrichmentInput {
  readonly experienceId: string;
  readonly dimension: string;
  readonly amount?: number;
  readonly flag?: boolean;
  readonly currency?: string;
}

export interface AssertEnrichmentResult {
  readonly enrichmentId: string;
  readonly dimension: string;
  /** Dimensions asserted so far. Returned so a client need not re-read. */
  readonly asserted: readonly string[];
}

/** Confirmed structure for the fingerprint. Deliberately confirmed-only. */
const confirmedStructure = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<{ entityId?: string; issueTypeId?: string; city?: string }> => {
  const metadata = await deps.store.experienceMetadata.queryOne([eq('experienceId', experienceId)]);
  if (!metadata) return {};
  const entityId = confirmedValue(metadata.confirmed, 'entity');
  const issueTypeId = confirmedValue(metadata.confirmed, 'issueType');
  const city = confirmedValue(metadata.confirmed, 'location');
  return {
    ...(typeof entityId === 'string' ? { entityId } : {}),
    ...(typeof issueTypeId === 'string' ? { issueTypeId } : {}),
    ...(typeof city === 'string' ? { city } : {}),
  };
};

export const registerEnrichmentEngine = (deps: EngineDeps): void => {
  const assert: CommandHandler<AssertEnrichmentInput, AssertEnrichmentResult> = {
    name: 'enrichment.assert',
    action: 'enrichment.assert',
    resolveResource: async (input) => experienceResource(deps.store, input.experienceId),
    handle: async (input, ctx) => {
      const loaded = await loadExperience(deps.store, input.experienceId);
      if (!loaded.ok) return loaded;
      const experience = loaded.value;

      // Only the person it happened to may assert what it cost them. The policy
      // matrix enforces ownership; this is the domain reason, restated where a reader
      // of this file will see it.
      if (experience.actorId !== ctx.actor.actorId) {
        return err(
          preconditionError('not_your_experience', 'only the person this happened to can say what it cost'),
        );
      }

      const value = assertDimension(
        {
          dimension: input.dimension,
          ...(input.amount === undefined ? {} : { amount: input.amount }),
          ...(input.flag === undefined ? {} : { flag: input.flag }),
          ...(input.currency === undefined ? {} : { currency: input.currency }),
        },
        { assertedBy: ctx.actor.actorId, now: ctx.clock.now() },
      );
      if (!value.ok) return value;

      const id = enrichmentKey(input.experienceId);
      const existing = await deps.store.enrichments.get(id);
      const structure = await confirmedStructure(deps, input.experienceId);
      const fingerprint = fingerprintOf({
        kind: experience.kind,
        ...structure,
        // Redacted text, via the normalization engine's own helper — the raw body is
        // never read here either.
        text: await redactedTextFor(deps, input.experienceId),
      });

      const next: ExperienceEnrichment = {
        id,
        experienceId: input.experienceId,
        values: withDimension(existing?.values ?? [], value.value),
        fingerprint,
        correlationId: existing?.correlationId ?? ctx.correlationId,
        createdAt: existing?.createdAt ?? ctx.clock.now(),
        updatedAt: ctx.clock.now(),
      };
      await deps.store.enrichments.put(next);

      const asserted = assertedValues(next).map((entry) => entry.dimension);

      return ok({
        value: { enrichmentId: id, dimension: value.value.dimension, asserted },
        events: [
          {
            aggregateType: 'experience',
            aggregateId: input.experienceId,
            eventName: 'ExperienceEnriched',
            payload: {
              experienceId: input.experienceId,
              dimension: value.value.dimension,
              // The dimensions, never the amounts: an event payload is the widest
              // surface in the system and "lost £2,400" does not need to travel.
              assertedDimensions: asserted,
              provenance: value.value.provenance,
            },
          },
        ],
      });
    },
  };

  deps.bus.register(assert);
};

/** The enrichment for an experience, or undefined when nothing was asserted. */
export const enrichmentFor = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<EnrichmentRow | undefined> => deps.store.enrichments.get(enrichmentKey(experienceId));

/**
 * Experiences whose content fingerprint matches this one.
 *
 * Returns the matches and stops. Naming it `nearDuplicatesOf` rather than
 * `duplicatesToSuppress` is deliberate: the caller decides, and the only caller today
 * is a review surface.
 */
export const nearDuplicatesOf = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<readonly string[]> => {
  const own = await deps.store.enrichments.get(enrichmentKey(experienceId));
  if (!own) return [];
  const matches = await deps.store.enrichments.query([eq<EnrichmentRow>('fingerprint', own.fingerprint)]);
  return matches
    .filter((row) => row.experienceId !== experienceId && isSameContent(row.fingerprint, own.fingerprint))
    .map((row) => row.experienceId);
};
