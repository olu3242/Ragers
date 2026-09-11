import type { Experience } from './experience.ts';
import type { Alias } from './identity.ts';
import type { CreationMode, ExperienceKind, Visibility } from './types.ts';

/**
 * Public read projections.
 *
 * These types deliberately have no `actorId` field. Anonymity is therefore a
 * structural property of the read model rather than a filter someone has to
 * remember to apply: there is nowhere to put an actor identifier, so a leak
 * cannot be introduced by forgetting a `delete`.
 */
export interface PublicIdentity {
  /** What a viewer sees: a display name, an alias handle, or "Anonymous". */
  readonly label: string;
  readonly kind: Visibility;
}

export const ANONYMOUS_LABEL = 'Anonymous';

export const resolveIdentity = (
  visibility: Visibility,
  displayName: string | undefined,
  alias: Alias | undefined,
): PublicIdentity => {
  if (visibility === 'anonymous') return { label: ANONYMOUS_LABEL, kind: 'anonymous' };
  if (visibility === 'alias') return { label: alias ? `@${alias.aliasName}` : ANONYMOUS_LABEL, kind: 'alias' };
  return { label: displayName ?? ANONYMOUS_LABEL, kind: 'public' };
};

export interface PublicExperience {
  readonly id: string;
  readonly kind: ExperienceKind;
  readonly creationMode: CreationMode;
  readonly category: string;
  readonly bodyText: string;
  readonly identity: PublicIdentity;
  readonly hasVoice: boolean;
  readonly durationMs?: number;
  readonly mediaAssetId?: string;
  readonly publishedAt: number;
}

export interface ProjectionContext {
  readonly displayName?: string;
  readonly alias?: Alias;
  readonly durationMs?: number;
}

export const toPublicExperience = (
  experience: Experience,
  context: ProjectionContext = {},
): PublicExperience => ({
  id: experience.id,
  kind: experience.kind,
  creationMode: experience.creationMode,
  category: experience.category,
  bodyText: experience.bodyText,
  identity: resolveIdentity(
    experience.visibility,
    // A display name is only ever consulted for public visibility.
    experience.visibility === 'public' ? context.displayName : undefined,
    experience.visibility === 'alias' ? context.alias : undefined,
  ),
  hasVoice: experience.creationMode === 'voice',
  ...(context.durationMs === undefined ? {} : { durationMs: context.durationMs }),
  ...(experience.mediaAssetId === undefined ? {} : { mediaAssetId: experience.mediaAssetId }),
  publishedAt: experience.publishedAt ?? experience.createdAt,
});

/**
 * Keys that must never appear anywhere in a serialised public projection.
 * Used by the leakage sweeps so the guarantee is asserted, not assumed.
 */
export const FORBIDDEN_PROJECTION_KEYS: readonly string[] = [
  'actorId',
  'actor_id',
  'originalKey',
  'original_key',
  'rawText',
  'raw_text',
  'email',
  'aliasId',
  'alias_id',
];

/** Recursively collect every key present in a value — used by leakage sweeps. */
export const collectKeys = (value: unknown, into: Set<string> = new Set()): Set<string> => {
  if (value === null || typeof value !== 'object') return into;
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, into);
    return into;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    into.add(key);
    collectKeys(entry, into);
  }
  return into;
};

export const findForbiddenKeys = (value: unknown): readonly string[] => {
  const keys = collectKeys(value);
  return FORBIDDEN_PROJECTION_KEYS.filter((forbidden) => keys.has(forbidden));
};
