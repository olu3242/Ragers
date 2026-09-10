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
 * priority — and the way that stays true is `INTEGRITY_MODULES` below, which a static test
 * checks for any reference to this module at all.
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
 * The modules where entitlement must never appear.
 *
 * Checked by a static test that reads each file and asserts it contains no reference to this
 * module, to a plan tier, or to any entitlement vocabulary. That is a stronger guarantee
 * than "we would notice in review", and it is the one the phase actually asks for.
 *
 * The list is the integrity layer as it stands: what gets published, what gets ranked, what
 * gets moderated, how trust and signal are computed, and where something sits in a queue.
 */
export const INTEGRITY_MODULES: readonly string[] = [
  'src/engines/ranking.engine.ts',
  'src/engines/safety.engine.ts',
  'src/engines/trust.engine.ts',
  'src/engines/signal.engine.ts',
  'src/engines/resolution.engine.ts',
  'src/engines/priority.engine.ts',
  'src/engines/severity.engine.ts',
  'src/engines/escalation.engine.ts',
  'src/engines/matching.engine.ts',
  'src/engines/feed.engine.ts',
  'src/domain/trust.ts',
  'src/domain/signal.ts',
  'src/domain/severity.ts',
  'src/domain/priority.ts',
  'src/domain/urgency.ts',
  'src/domain/matching.ts',
  'src/domain/resolution.ts',
  'src/domain/aggregation.ts',
  'src/domain/sampling.ts',
];

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
