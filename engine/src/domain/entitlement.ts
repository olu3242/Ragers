/**
 * Commercial entitlement — Phase 48, and the boundary it must never cross.
 *
 * The phase's non-negotiable is that payment never buys removal of legitimate Rage, ranking
 * manipulation, suppression, artificial Rave promotion, or preferential moderation. The
 * roadmap is explicit that this "is not a policy statement to be trusted — the integrity
 * layer must have no input for entitlement at all, so there is nothing to switch."
 *
 * That sentence is the design. An entitlement is a **feature flag for organization-facing
 * reads**, and nothing else. It gates who can see a benchmark or an export. It does not
 * appear in ranking, in moderation, in screening, in trust, in signal, in resolution or in
 * priority — and the way that stays true is the discovery-based guard below, which walks the
 * domain and the engines and holds every module it finds to the invariant unless that module is
 * an explicitly justified commercial surface.
 *
 * Note what is deliberately missing from `Entitlement`: there is no `priorityBoost`, no
 * `moderationTier`, no `visibilityMultiplier`, no `suppressionAllowance`. Not set to zero —
 * absent. A field that exists at zero is one edit away from being non-zero, and a code
 * review is a worse guard than a type that cannot express the thing.
 */
export type PlanTier = 'none' | 'basic' | 'professional';

export const PLAN_TIERS: readonly PlanTier[] = ['none', 'basic', 'professional'];

/**
 * What a plan may unlock. Every one of these is a **read** — a way to see governed state
 * that already exists, computed the same way for everybody.
 */
export type EntitledFeature =
  | 'benchmark_reports'
  | 'issue_alerts'
  | 'resolution_analytics'
  | 'data_export'
  | 'team_workflows';

export const ENTITLED_FEATURES: readonly EntitledFeature[] = [
  'benchmark_reports',
  'issue_alerts',
  'resolution_analytics',
  'data_export',
  'team_workflows',
];

const PLAN_FEATURES: Readonly<Record<PlanTier, readonly EntitledFeature[]>> = {
  none: [],
  basic: ['issue_alerts', 'resolution_analytics'],
  professional: ['issue_alerts', 'resolution_analytics', 'benchmark_reports', 'data_export', 'team_workflows'],
};

export interface Entitlement {
  readonly organizationId: string;
  readonly tier: PlanTier;
  readonly features: readonly EntitledFeature[];
  readonly updatedAt: number;
}

export const entitlementFor = (organizationId: string, tier: PlanTier, now: number): Entitlement => ({
  organizationId,
  tier,
  features: PLAN_FEATURES[tier],
  updatedAt: now,
});

export const mayUse = (entitlement: Entitlement | undefined, feature: EntitledFeature): boolean =>
  entitlement !== undefined && entitlement.features.includes(feature);

/**
 * Where the entitlement-blindness invariant applies, discovered rather than listed.
 *
 * This replaced a hand-maintained array of filenames, which had a hole big enough to matter:
 * it caught a module that *broke* the invariant, but a module added later simply escaped it,
 * and a rename silently dropped coverage. The invariant is only worth having if it holds for
 * code nobody has thought about yet.
 *
 * So coverage is now **default-in**. The test walks these directories and treats every module
 * it finds as integrity-critical unless the module itself carries an exemption marker. The
 * three failure modes the phase cares about all become test failures without anybody
 * remembering to do anything:
 *
 *   1. a module referencing entitlement — scanned, and it fails;
 *   2. a *new* module — covered by default, because it is in the directory;
 *   3. a renamed or moved module — still covered, because coverage comes from walking the
 *      tree rather than from a path somebody has to update.
 *
 * The roots are deliberately narrow: the domain and the engines, which are what decide what
 * gets published, ranked, moderated, scored and prioritised. Adapters, the host app and the
 * runtime are not scanned — broadening into them would produce noise that teaches people to
 * add exemptions, which is how a guard dies.
 */
export const INTEGRITY_SCAN_ROOTS: readonly string[] = ['src/domain', 'src/engines'];

/**
 * The commercial surfaces, and why each one is allowed to see entitlement.
 *
 * An exemption carries its reason in the map rather than in a comment somewhere, so a reader
 * asking "why is this one allowed?" gets an answer, and a reviewer adding a fourth entry has
 * to write one. A test asserts every key exists on disk — an exemption for a file that has
 * been renamed away is a hole wearing a justification.
 *
 * Note the second entry. `integration.ts` matches the word "subscription" in the *webhook*
 * sense, which has nothing to do with a commercial subscription. The honest fix is to record
 * that ambiguity here rather than to loosen the vocabulary — dropping the word would weaken
 * detection of a real commercial reference everywhere else.
 */
export const COMMERCIAL_SURFACES: Readonly<Record<string, string>> = {
  'src/domain/entitlement.ts':
    'This module defines entitlement. It is the boundary, not a crossing of it.',
  'src/domain/integration.ts':
    'Matches "subscription" in the webhook sense only. A webhook subscription is not a commercial subscription, and the vocabulary is deliberately left strict rather than loosened to accommodate the collision.',
  'src/engines/integration.engine.ts':
    'Reads an entitlement to decide whether an organization may hold a webhook subscription — a read capability, and the only place in the engines where a plan is consulted at all.',
};

export const isCommercialSurface = (relativePath: string): boolean =>
  Object.hasOwn(COMMERCIAL_SURFACES, relativePath.replaceAll('\\', '/'));

/**
 * The reason a file is exempt, or `undefined` when it is not exempt.
 *
 * Returned rather than a boolean so a test failure can quote the justification, and so an
 * empty justification is detectable.
 */
export const exemptionReason = (relativePath: string): string | undefined =>
  COMMERCIAL_SURFACES[relativePath.replaceAll('\\', '/')];

/** Vocabulary that must not appear in an integrity module, in any spelling. */
export const ENTITLEMENT_VOCABULARY: readonly string[] = [
  'entitlement',
  'planTier',
  'plan_tier',
  'subscription',
  'paidTier',
  'billing',
  'premium',
  'boost',
];

/**
 * The integrity inputs an entitlement contributes.
 *
 * `undefined`, always, and there is no branch. Written as a function so a test can call it
 * rather than reason about it, and so any future attempt to make it return something has to
 * change a signature that is asserted elsewhere.
 */
export const integrityInputsFor = (_entitlement: Entitlement | undefined): undefined => undefined;
