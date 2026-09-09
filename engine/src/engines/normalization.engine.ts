import { err, ok } from '../runtime/result.ts';
import { notFoundError, preconditionError } from '../runtime/errors.ts';
import {
  confirmationToRecord,
  confirmFacts,
  extractFacts,
  extractionToRecord,
  recordToExtraction,
  worthConfirming,
  type NormalizableField,
  type Suggestion,
} from '../domain/normalization.ts';
import { eq } from '../ports/store.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type { ExperienceMetadata } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { experienceResource, loadExperience } from './support.ts';

/**
 * Normalization Engine — AI suggests, the person confirms, both are kept.
 *
 * Extraction runs as a consumer, so it never delays publication and never gates
 * it: an experience with nothing extracted is a perfectly valid experience.
 * Confirmation is a command, because it is an act by a person.
 */

/** Redacted text only. The raw body is never read for extraction. */
const redactedTextFor = async (deps: EngineDeps, experienceId: string): Promise<string> => {
  const experience = await deps.store.experiences.get(experienceId);
  if (!experience) return '';
  // Transcripts are keyed by media asset, not experience.
  const transcript = experience.mediaAssetId
    ? await deps.store.transcripts.queryOne([eq('mediaAssetId', experience.mediaAssetId)])
    : undefined;
  // A transcript's redacted form, never `rawText` — which is unreadable on every
  // path by design.
  return [experience.bodyText, transcript?.redactedText ?? '']
    .filter((part) => part.length > 0)
    .join(' ');
};

const taxonomyFor = async (
  deps: EngineDeps,
): Promise<{ aliases: Map<string, string>; categories: Map<string, string> }> => {
  const aliases = new Map<string, string>();
  for (const row of await deps.store.entityAliases.all()) aliases.set(row.alias.toLowerCase(), row.entityId);
  // An entity's own name is an alias for matching purposes.
  for (const row of await deps.store.entities.all()) aliases.set(row.name.toLowerCase(), row.id);

  const categories = new Map<string, string>();
  for (const row of await deps.store.categories.all()) categories.set(row.name.toLowerCase(), row.id);
  return { aliases, categories };
};

/**
 * Extraction, as a consumer.
 *
 * Writes only to `extracted`. Nothing here can reach `confirmed`, which is the
 * structural half of "never silently replace what the person actually said" —
 * the other half being that matching reads `confirmed` alone.
 */
export const createExtractionConsumer = (deps: EngineDeps): Consumer => ({
  name: 'normalization.extract',
  events: ['ExperiencePublished', 'TranscriptRedacted'],
  handle: async (event) => {
    const experienceId = String(event.payload['experienceId'] ?? '');
    if (!experienceId) return ok(undefined);
    const experience = await deps.store.experiences.get(experienceId);
    if (!experience) return ok(undefined);

    const text = await redactedTextFor(deps, experienceId);
    if (text.length === 0) return ok(undefined);

    const { aliases, categories } = await taxonomyFor(deps);
    const outcome = extractFacts({
      text,
      source: experience.creationMode === 'voice' ? 'voice' : 'text',
      aliases,
      categories,
      now: deps.clock.now(),
    });

    const existing = await deps.store.experienceMetadata.get(experienceId);
    const row: ExperienceMetadata = {
      id: experienceId,
      experienceId,
      extracted: extractionToRecord(outcome),
      // Confirmed is carried forward untouched. Re-extraction after a new
      // transcript must never disturb what a person already affirmed.
      confirmed: existing?.confirmed ?? {},
      extractionSource: outcome.source,
      ...(existing?.confirmedAt === undefined ? {} : { confirmedAt: existing.confirmedAt }),
      ...(existing?.confirmedBy === undefined ? {} : { confirmedBy: existing.confirmedBy }),
    };
    await deps.store.experienceMetadata.put(row);

    deps.metrics.increment('normalization.extracted', { source: outcome.source });
    return ok(undefined);
  },
});

export interface ConfirmNormalizationInput {
  readonly experienceId: string;
  /** Field → value the person affirmed. An omitted field stays unconfirmed. */
  readonly fields: Readonly<Partial<Record<NormalizableField, string>>>;
}

export interface ConfirmNormalizationResult {
  readonly confirmed: readonly { readonly field: NormalizableField; readonly edited: boolean }[];
  /** Fields still unconfirmed, which matching will treat as unknown. */
  readonly unconfirmed: readonly NormalizableField[];
}

export const registerNormalizationEngine = (deps: EngineDeps): void => {
  const confirm: CommandHandler<ConfirmNormalizationInput, ConfirmNormalizationResult> = {
    name: 'normalization.confirm',
    action: 'experience.confirm_metadata',
    resolveResource: async (input) => experienceResource(deps.store, input.experienceId),
    handle: async (input, ctx) => {
      const loaded = await loadExperience(deps.store, input.experienceId);
      if (!loaded.ok) return loaded;
      if (loaded.value.status === 'deleted' || loaded.value.status === 'removed') {
        return err(preconditionError('experience_not_available', 'that experience is no longer available'));
      }

      const existing = await deps.store.experienceMetadata.get(input.experienceId);
      const extracted = recordToExtraction(existing?.extracted ?? {});

      const confirmation = confirmFacts(
        { fields: input.fields, extracted },
        { actorId: ctx.actor.actorId, now: ctx.clock.now() },
      );
      if (!confirmation.ok) return confirmation;

      const record = confirmationToRecord(confirmation.value);
      await deps.store.experienceMetadata.put({
        id: input.experienceId,
        experienceId: input.experienceId,
        extracted: existing?.extracted ?? {},
        confirmed: record,
        extractionSource: existing?.extractionSource ?? 'none',
        confirmedAt: confirmation.value.confirmedAt,
        confirmedBy: confirmation.value.confirmedBy,
      });

      // The confirmed identifiers are copied onto the experience so matching and
      // the feed read one place. Only confirmed values are copied.
      const patch: Record<string, unknown> = {};
      for (const field of confirmation.value.fields) {
        if (field.field === 'entity') patch['entityId'] = field.value;
        if (field.field === 'category') patch['categoryId'] = field.value;
        if (field.field === 'issueType') patch['issueTypeId'] = field.value;
        if (field.field === 'location') patch['locationId'] = field.value;
        if (field.field === 'title') patch['title'] = field.value;
        if (field.field === 'occurredAt') patch['occurredAt'] = Number(field.value);
      }
      if (Object.keys(patch).length > 0) {
        await deps.store.experiences.put({ ...loaded.value, ...patch, updatedAt: ctx.clock.now() });
      }

      const confirmedFields = confirmation.value.fields.map((field) => field.field);
      const unconfirmed = worthConfirming(extracted)
        .map((suggestion: Suggestion) => suggestion.field)
        .filter((field) => !confirmedFields.includes(field));

      return ok({
        value: {
          confirmed: confirmation.value.fields.map((field) => ({ field: field.field, edited: field.edited })),
          unconfirmed: [...new Set(unconfirmed)],
        },
        events: [
          {
            aggregateType: 'experience',
            aggregateId: input.experienceId,
            eventName: 'ExperienceNormalizationConfirmed',
            payload: {
              experienceId: input.experienceId,
              fields: confirmedFields,
              // Recorded because it is evidence the person was shown a
              // suggestion and disagreed with it.
              editedFields: confirmation.value.fields.filter((f) => f.edited).map((f) => f.field),
            },
          },
        ],
      });
    },
  };

  deps.bus.register(confirm);
};

/** Suggestions a person has not yet acted on. Read by the confirmation UI. */
export const pendingSuggestions = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<readonly Suggestion[]> => {
  const row = await deps.store.experienceMetadata.get(experienceId);
  if (!row) return [];
  const confirmedFields = Object.keys(row.confirmed).filter((key) => key !== '_edited');
  return worthConfirming(recordToExtraction(row.extracted)).filter(
    (suggestion) => !confirmedFields.includes(suggestion.field),
  );
};

/** Confirmed metadata, or an empty record. The only fact-bearing accessor. */
export const confirmedMetadata = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<Readonly<Record<string, unknown>>> => (await deps.store.experienceMetadata.get(experienceId))?.confirmed ?? {};

export const metadataNotFound = () => err(notFoundError('metadata_not_found', 'no metadata for that experience'));
