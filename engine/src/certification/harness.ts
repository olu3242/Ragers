import { readDimensions, type DimensionReading } from './release.ts';
import type { FailureSummary, GateCounts } from './evidence.ts';

/**
 * P20 Certification harness.
 *
 * A gate is either runnable in this environment or blocked by an external
 * dependency that is not provisioned. Blocked gates are never counted as
 * passing — they are named, with the specific reason, and they hold the status
 * down to READY_WITH_EXTERNAL_BLOCKERS.
 */
export type GateStatus = 'passed' | 'failed' | 'blocked';

export type CertificationStatus =
  | 'RAGERS_ENGINE_E2E_READY'
  | 'RAGERS_ENGINE_E2E_READY_WITH_EXTERNAL_BLOCKERS'
  | 'RAGERS_ENGINE_E2E_NO_GO';

/**
 * The Experience Signal Engine's own status, reported alongside the engine's
 * rather than replacing it. They answer different questions: the engine status is
 * about whether the platform is operable, this one about whether the corroboration
 * contract actually holds.
 */
export type ExperienceSignalEngineStatus =
  | 'EXPERIENCE_SIGNAL_ENGINE_READY'
  | 'EXPERIENCE_SIGNAL_ENGINE_READY_WITH_BLOCKERS'
  | 'EXPERIENCE_SIGNAL_ENGINE_NOT_READY';

/**
 * The Trust, Governance & Action band (Phases 31–40), reported separately.
 *
 * A third status for the same reason there is a second: it answers a different
 * question. The engine status is about whether the platform is operable; the ESE
 * status is about whether the corroboration contract holds; this one is about whether
 * *measuring is kept apart from deciding* — that severity comes from what people
 * asserted, that a measure below its floor is withheld rather than invented, that an
 * escalation opens a review and nothing more, and that a handoff proposes without
 * mutating anything. Rolling it into either of the others would hide which is broken.
 */
export type GovernanceActionStatus =
  | 'PHASES_31_40_READY'
  | 'PHASES_31_40_READY_WITH_EXTERNAL_BLOCKERS'
  | 'PHASES_31_40_NOT_READY';

/**
 * The Agentic Experience OS band (Phases 41–50) — Phase 50's own status.
 *
 * A fourth status, and the last one, for the reason the others exist: it answers a question
 * none of them do. This one is *does AI stay downstream of governance?* — that an agent's
 * only output is a proposal, that a person decides, that the target engine can still refuse,
 * that a measure without enough data says so rather than guessing, and that payment reaches
 * nothing which decides an outcome.
 *
 * `CODE_READY_DATA_BLOCKED` is a real value rather than a euphemism. Phase 47's benchmarking
 * is built and certified against the Phase 39 aggregation, and produces nothing until enough
 * different people have contributed — which is the engine being correct, not failing. A
 * `READY` there would be a lie and a `NOT_READY` would be wrong about which thing is missing.
 */
export type ExperienceOsStatus =
  | 'RAGERS_EXPERIENCE_OS_READY'
  | 'RAGERS_EXPERIENCE_OS_CODE_READY_DATA_BLOCKED'
  | 'RAGERS_EXPERIENCE_OS_READY_WITH_BLOCKERS'
  | 'RAGERS_EXPERIENCE_OS_NOT_READY';

/**
 * The Experience Loop band (Phases 51–60) — Phase 60's own status.
 *
 * A fifth status, on the same principle as the four before it: it answers a question none
 * of them do. This one is *what may the system remember, connect and conclude the second
 * time?* — that a relationship is between experiences and never between people, that a
 * memory is of an experience rather than of a person, that a history is not a ranking, that
 * a signal can stop being current without any row being erased, that reputation is neither
 * popularity nor one opaque number, and that a plan of several governed steps cannot launder
 * privilege past the policy matrix.
 *
 * There is no `CODE_READY_DATA_BLOCKED` here. Every phase in this band is provable with the
 * deterministic path and six seeded people, so a data gap would be a gap in the test rather
 * than in the world.
 */
export type ExperienceLoopStatus =
  | 'PHASES_51_60_READY'
  | 'PHASES_51_60_READY_WITH_EXTERNAL_BLOCKERS'
  | 'PHASES_51_60_NOT_READY';

/**
 * The Operational Integrity band (Phases 61–70) — Phase 70's own status.
 *
 * A sixth status, and the one that answers a question none of the five before it does:
 * phases 1–60 asked whether the system is *correct*, and this asks whether it is safe to
 * **operate**. Those fail differently. A correct system with no rate limit, no retention
 * ceiling, no reply moderation and an audit trail covering four engines out of twelve is
 * correct code in an environment that cannot hold it.
 *
 * What it certifies: that being throttled is never being judged, that detection opens a
 * review and never takes an action, that a reported reply can actually be actioned, that a
 * deletion leaves no stored reference behind, that a raw artefact has a stated ceiling and
 * expires without taking the account with it, that an unavailable dependency produces one
 * reported state rather than three unrelated-looking bugs, and that every action taken
 * under authority about somebody else is attributable.
 *
 * `READY_WITH_EXTERNAL_BLOCKERS` is the expected value while no object storage exists:
 * retention decides, marks and records, and the deletion of remote bytes reports
 * `OBJECT_STORAGE_BLOCKED` rather than claiming a deletion nothing performed. A plain
 * `READY` that quietly skipped that would be the first time this ledger claimed something
 * it had not done.
 */
export type OperationalIntegrityStatus =
  | 'PHASES_61_70_READY'
  | 'PHASES_61_70_READY_WITH_EXTERNAL_BLOCKERS'
  | 'PHASES_61_70_NOT_READY';

/**
 * The Discovery & Network band (Phases 71–80) — Phase 80's own status.
 *
 * A seventh status, and the question it answers is the one this band was built around: **can
 * the product become more useful as the network grows without its ranking becoming a
 * popularity contest?**
 *
 * That is not a correctness question and it is not an operability question. It is a question
 * about what the system rewards, and the answer is either visible in the ordering or it is
 * not true. What it certifies: that corroboration outranks engagement rather than being summed
 * into it, that every ordering states the factor that decided it, that an unvoted experience is
 * not treated as an unfair one, that trust may constrain amplification and never ranks, that
 * reach counts people and shares are not reach, that an emerging pattern is never described as
 * established, that a watcher is invisible in both directions, and that nothing removed,
 * hidden or unpublished reaches a discovery read, a search hit or a notification payload.
 *
 * No `DATA_BLOCKED` variant: every phase in this band is provable with the deterministic path
 * and a handful of seeded people. A data gap here would be a gap in the test.
 */
export type DiscoveryNetworkStatus =
  | 'PHASES_71_80_READY'
  | 'PHASES_71_80_READY_WITH_EXTERNAL_BLOCKERS'
  | 'PHASES_71_80_NOT_READY';

/**
 * The Trust, Quality & Personalization band (Phases 81–90) — Phase 90's own status.
 *
 * An eighth status, and the question is stronger than the seventh's. Phase 80 asked whether the
 * product can grow more useful without its ranking becoming a popularity contest. This one asks
 * whether it can become **personally relevant** without three specific things happening:
 * without learning to reward outrage, without exposing trust internals, and without
 * constructing a hidden profile of anybody.
 *
 * What it certifies: that a count of people is a count of people and confidence is a separate
 * measure over it; that no per-person trust figure enters any confidence, reliability or
 * quality read; that `resolved != well resolved`, carried as two facts rather than one score;
 * that there is no leaderboard of contributors, which is worse than one of organizations;
 * that **eligibility runs before personalization**, so a preference can never become a
 * permission; that a quality measure withheld below its floor is not laundered into a
 * conclusion; and that an approval covers the steps it was given and not the ones added after —
 * `decision != effect`, asserted at the step where an approval produces a refusal.
 *
 * No `DATA_BLOCKED` variant, for the same reason as the seventh: every phase here is provable
 * with the deterministic path and a handful of seeded people.
 */
export type TrustQualityStatus =
  | 'PHASES_81_90_READY'
  | 'PHASES_81_90_READY_WITH_EXTERNAL_BLOCKERS'
  | 'PHASES_81_90_NOT_READY';

/**
 * The Authority, Control & Release band (Phases 91–100) — Phase 100's own status.
 *
 * A ninth status, and the question is the last one before anybody can be asked to use this:
 * **when the system does something, can a human see why, stop it, and prove what happened?**
 *
 * What it certifies: that every agent's authority is declared and default-denied, with target
 * engines and forbidden commands distinct from what it reads; that every authoritative read can
 * produce an explanation including *why it is withheld*; that the decision chain is readable end to
 * end with refusals still in it; that six server-side controls exist, are audited in both
 * directions and are consulted on the paths they govern; that each failure class states its blast
 * radius and what still works; that a replay recomputes and never re-decides; that an operator can
 * answer the nine questions from durable rows; that the twelve privacy rules hold against a live
 * schema; and that the whole circle closes for a Rage and again for a Rave.
 *
 * The release *dimensions* are separate and deliberately so — see `src/certification/release.ts`.
 * A band status says whether the code is certified; a release status says whether it may be run,
 * and collapsing the two is what this band's Phase 99 exists to prevent.
 */
export type AuthorityReleaseStatus =
  | 'PHASES_91_100_READY'
  | 'PHASES_91_100_READY_WITH_EXTERNAL_BLOCKERS'
  | 'PHASES_91_100_NOT_READY';

/** Which certification a gate belongs to. Absent means the engine's. */
export type GateScope =
  | 'engine'
  | 'experience_signal_engine'
  | 'governance_action'
  | 'experience_os'
  | 'experience_loop'
  | 'operational_integrity'
  | 'discovery_network'
  | 'trust_quality'
  | 'authority_release';

export interface GateDefinition {
  readonly id: string;
  readonly name: string;
  /** Defaults to the engine certification. */
  readonly scope?: GateScope;
  /** Which required gate from docs/ROADMAP.md §P20 this satisfies. */
  readonly requirement: string;
  /** Absent for a gate that is blocked unconditionally. */
  readonly command?: readonly string[];
  /** Present for a gate that is blocked unconditionally: what is missing. */
  readonly blockedBy?: string;
  /**
   * Environment variable this gate needs. When it is unset the gate reports
   * `blocked` rather than `failed` — an absent dependency is not a defect, but
   * it is also not a pass.
   */
  readonly requiresEnv?: string;
  /** Why the gate cannot run when `requiresEnv` is unset. */
  readonly blockedWithoutEnv?: string;
}

/**
 * What one attempt at a gate did.
 *
 * Recorded separately from the gate's own result so a re-run cannot erase what the
 * first run found. A gate that failed and then passed is a fact about the system, and
 * a ledger that shows only the pass has destroyed the evidence for the one question
 * anybody asks afterwards: was that flaky, or was it real and is it still there?
 */
export interface GateAttempt {
  /** 1 for the first run. */
  readonly attempt: number;
  readonly status: GateStatus;
  readonly durationMs: number;
  readonly detail: string;
  readonly exitCode?: number | null;
  readonly failureSummary?: readonly FailureSummary[];
  readonly evidenceExcerpt?: string;
}

/**
 * The gate's conclusion across every attempt.
 *
 * `INITIAL_FAIL_RETRY_PASS` is the value this whole slice exists for. Certification
 * policy may still count the gate as green — that is a separate decision, made by
 * `decideStatus` over `status`, and this slice does not change it — but the ledger has
 * to say the transient failure happened. A run that silently reported PASS would be
 * true about now and misleading about the system.
 */
export type GateConclusion =
  | 'PASS'
  | 'FAIL'
  | 'BLOCKED'
  | 'INITIAL_FAIL_RETRY_PASS'
  | 'INITIAL_FAIL_RETRY_FAIL';

// Phase 99. Re-exported so a caller reaching the report can name its own shape.
export type { DimensionReading };

export interface GateResult {
  readonly id: string;
  readonly name: string;
  readonly scope?: GateScope;
  readonly requirement: string;
  readonly status: GateStatus;
  readonly durationMs: number;
  readonly detail: string;
  readonly blockedBy?: string;

  // ── Evidence ────────────────────────────────────────────────────────────
  /** The command that ran, redacted. Absent for a gate that could not run at all. */
  readonly command?: string;
  readonly exitCode?: number | null;
  readonly counts?: GateCounts;
  /** Which subtests failed, named. Empty or absent for a passing gate. */
  readonly failureSummary?: readonly FailureSummary[];
  /** Bounded, redacted output around the failure. Absent for a passing gate. */
  readonly evidenceExcerpt?: string;
  readonly failuresOmitted?: number;
  /** Present only when a gate was attempted more than once. */
  readonly attempts?: readonly GateAttempt[];
  readonly conclusion?: GateConclusion;
}

/**
 * Fold a fresh attempt onto a gate's earlier one.
 *
 * The harness runs each gate once and owns no retry loop, so this is not called
 * during a normal run. It exists because CI *does* re-run failed jobs, and when a
 * re-run is given the previous attempt's report (`RAGERS_PREVIOUS_REPORT`) the
 * evidence must carry forward rather than start clean. Deliberately a pure function
 * over two results: adding an automatic retry here would change what certification
 * means, and that is not this slice's decision to make.
 */
export const mergeAttempt = (previous: GateResult, current: GateResult): GateResult => {
  const history: GateAttempt[] = [
    ...(previous.attempts ?? [
      {
        attempt: 1,
        status: previous.status,
        durationMs: previous.durationMs,
        detail: previous.detail,
        ...(previous.exitCode === undefined ? {} : { exitCode: previous.exitCode }),
        ...(previous.failureSummary === undefined ? {} : { failureSummary: previous.failureSummary }),
        ...(previous.evidenceExcerpt === undefined ? {} : { evidenceExcerpt: previous.evidenceExcerpt }),
      },
    ]),
  ];
  history.push({
    attempt: history.length + 1,
    status: current.status,
    durationMs: current.durationMs,
    detail: current.detail,
    ...(current.exitCode === undefined ? {} : { exitCode: current.exitCode }),
    ...(current.failureSummary === undefined ? {} : { failureSummary: current.failureSummary }),
    ...(current.evidenceExcerpt === undefined ? {} : { evidenceExcerpt: current.evidenceExcerpt }),
  });

  const firstFailed = history[0]?.status === 'failed';
  const conclusion: GateConclusion =
    current.status === 'blocked'
      ? 'BLOCKED'
      : firstFailed
        ? current.status === 'passed'
          ? 'INITIAL_FAIL_RETRY_PASS'
          : 'INITIAL_FAIL_RETRY_FAIL'
        : current.status === 'passed'
          ? 'PASS'
          : 'FAIL';

  return { ...current, attempts: history, conclusion };
};

/** The conclusion of a gate that was attempted once. */
export const conclusionOf = (status: GateStatus): GateConclusion =>
  status === 'passed' ? 'PASS' : status === 'blocked' ? 'BLOCKED' : 'FAIL';

/** The required gate list, in the order docs/ROADMAP.md §P20 states them. */
export const GATES: readonly GateDefinition[] = [
  {
    id: 'static_validation',
    name: 'Static validation (architecture, hygiene, content separation)',
    requirement: 'security',
    command: ['npm', 'run', 'lint'],
  },
  {
    id: 'schema_migrations',
    name: 'Schema & migrations (static)',
    requirement: 'schema/migrations',
    command: ['node', '--test', 'tests/unit/schema.migrations.test.ts'],
  },
  {
    id: 'unit',
    name: 'Unit tests',
    requirement: 'unit',
    command: ['node', '--test', 'tests/unit/**/*.test.ts'],
  },
  {
    id: 'integration',
    name: 'Integration tests',
    requirement: 'integration',
    command: ['node', '--test', 'tests/integration/**/*.test.ts'],
  },
  {
    id: 'authorization',
    name: 'Authorization',
    requirement: 'authorization',
    command: [
      'node',
      '--test',
      'tests/unit/identity.policy.test.ts',
      'tests/unit/runtime.authz.test.ts',
      'tests/integration/governance.audit.test.ts',
    ],
  },
  {
    id: 'retry_dead_letter',
    name: 'Retry & dead-letter',
    requirement: 'retry/dead-letter',
    command: ['node', '--test', 'tests/unit/runtime.retry.test.ts', 'tests/unit/runtime.deadletter.test.ts'],
  },
  {
    id: 'concurrency',
    name: 'Concurrency & idempotency',
    requirement: 'concurrency',
    command: [
      'node',
      '--test',
      'tests/unit/runtime.idempotency.test.ts',
      'tests/unit/runtime.outbox.test.ts',
      'tests/integration/reaction.mechanics.test.ts',
    ],
  },
  {
    id: 'voice',
    name: 'Voice capture & golden path',
    requirement: 'voice',
    command: [
      'node',
      '--test',
      'tests/unit/voice.recorder.test.ts',
      'tests/unit/voice.validation.test.ts',
      'tests/integration/voice.goldenpath.test.ts',
    ],
  },
  {
    id: 'moderation_failure_path',
    name: 'Moderation failure path (fail-closed)',
    requirement: 'moderation failure-path',
    command: ['node', '--test', 'tests/integration/privacy.failclosed.test.ts'],
  },
  {
    id: 'privacy_search_leakage',
    name: 'Privacy & search leakage',
    requirement: 'privacy/search leakage',
    command: [
      'node',
      '--test',
      'tests/unit/identity.anonymity.test.ts',
      'tests/unit/observability.logging.test.ts',
      'tests/integration/search.leakage.test.ts',
      'tests/integration/subject.guardrail.test.ts',
      'tests/integration/analytics.observability.test.ts',
      'tests/integration/creator.deletion.test.ts',
    ],
  },
  {
    id: 'accessibility',
    name: 'Accessibility (static surfaces)',
    requirement: 'accessibility',
    command: ['node', '--test', 'tests/unit/accessibility.surfaces.test.ts'],
  },
  {
    id: 'typecheck',
    name: 'Strict typecheck',
    requirement: 'build',
    command: ['npx', 'tsc', '--noEmit'],
  },
  {
    id: 'build',
    name: 'Production build',
    requirement: 'build',
    command: ['npx', 'next', 'build'],
  },
  {
    id: 'browser_e2e',
    name: 'Browser E2E',
    requirement: 'browser E2E',
    command: ['npx', 'playwright', 'test'],
  },
  {
    id: 'security',
    name: 'Dependency audit',
    requirement: 'security',
    command: ['npm', 'audit', '--audit-level=high'],
  },
  {
    id: 'live_migrations',
    name: 'Migrations applied to a live database',
    requirement: 'schema/migrations',
    command: ['npm', 'run', 'migrate'],
    requiresEnv: 'RAGERS_TEST_DATABASE_URL',
    blockedWithoutEnv:
      'No database is configured. Set RAGERS_TEST_DATABASE_URL (or DATABASE_URL) to apply and verify the migrations.',
  },
  {
    id: 'persistence_parity',
    name: 'Adapter parity (in-memory vs Postgres)',
    requirement: 'integration',
    command: ['node', '--test', 'tests/live/persistence.parity.test.ts'],
    requiresEnv: 'RAGERS_TEST_DATABASE_URL',
    blockedWithoutEnv: 'No database is configured, so the Postgres adapter cannot be compared to the in-memory one.',
  },
  {
    id: 'rls_enforcement',
    name: 'RLS enforcement against a live database',
    requirement: 'authorization',
    command: ['node', '--test', 'tests/live/rls.certification.test.ts'],
    requiresEnv: 'RAGERS_TEST_DATABASE_URL',
    blockedWithoutEnv: 'No database is configured, so the policies cannot be executed as real client roles.',
  },
  {
    id: 'durable_orchestration',
    name: 'Durable orchestration and restart recovery',
    requirement: 'retry/dead-letter',
    command: ['node', '--test', 'tests/live/orchestration.durability.test.ts'],
    requiresEnv: 'RAGERS_TEST_DATABASE_URL',
    blockedWithoutEnv: 'No database is configured, so worker restart and lease recovery cannot be exercised.',
  },
  {
    id: 'backup_restore',
    name: 'Backup and restore drill',
    requirement: 'backup/restore',
    command: ['node', '--test', 'tests/live/backup.restore.test.ts'],
    requiresEnv: 'RAGERS_TEST_DATABASE_URL',
    blockedWithoutEnv: 'No database is configured. The procedure is documented in docs/OPERATIONS.md §6.',
  },
  // ── Experience Signal Engine ──────────────────────────────────────────
  // These certify the corroboration contract rather than the platform: that a
  // count of people is a count of people, that a share is never a claim, and
  // that a response is never a resolution.
  {
    id: 'ese_corroboration_contract',
    name: 'ESE: corroboration is a claim, not a repost or a reaction',
    scope: 'experience_signal_engine',
    requirement: 'ese/contract',
    command: ['node', '--test', 'tests/unit/corroboration.contract.test.ts'],
  },
  {
    id: 'ese_matching_signal',
    name: 'ESE: matching, signal and resolution semantics',
    scope: 'experience_signal_engine',
    requirement: 'ese/intelligence',
    command: ['node', '--test', 'tests/unit/matching.signal.test.ts'],
  },
  {
    id: 'ese_normalization_trust',
    name: 'ESE: AI suggests, the person confirms; trust stays internal',
    scope: 'experience_signal_engine',
    requirement: 'ese/normalization',
    command: ['node', '--test', 'tests/unit/normalization.trust.test.ts'],
  },
  {
    id: 'ese_language_guidance',
    name: 'ESE: language guidance advises and never rewrites',
    scope: 'experience_signal_engine',
    requirement: 'ese/language',
    command: ['node', '--test', 'tests/unit/language.guidance.test.ts'],
  },
  {
    id: 'ese_corroboration_engine',
    name: 'ESE: corroboration engine end to end through the bus',
    scope: 'experience_signal_engine',
    requirement: 'ese/contract',
    command: ['node', '--test', 'tests/integration/corroboration.engine.test.ts'],
  },
  {
    id: 'ese_intelligence_chain',
    name: 'ESE: extract, confirm, cluster, measure',
    scope: 'experience_signal_engine',
    requirement: 'ese/intelligence',
    command: ['node', '--test', 'tests/integration/intelligence.chain.test.ts'],
  },
  {
    id: 'ese_resolution_organization',
    name: 'ESE: a response is not a resolution',
    scope: 'experience_signal_engine',
    requirement: 'ese/resolution',
    command: ['node', '--test', 'tests/integration/resolution.organization.test.ts'],
  },
  {
    id: 'ese_host_surfaces',
    name: 'ESE: host surface guards, including the fixture route',
    scope: 'experience_signal_engine',
    requirement: 'security',
    command: ['node', '--test', 'tests/unit/host.surfaces.test.ts'],
  },
  {
    id: 'ese_duplicate_concurrency',
    name: 'ESE: one person, one corroboration, under real concurrency',
    scope: 'experience_signal_engine',
    requirement: 'concurrency',
    command: ['node', '--test', 'tests/live/corroboration.concurrency.test.ts'],
    requiresEnv: 'RAGERS_TEST_DATABASE_URL',
    blockedWithoutEnv:
      'No database is configured. In-memory interleaving is not the same as simultaneous statements across pooled connections, so this cannot be certified without one.',
  },
  {
    id: 'ese_outbox_atomicity',
    name: 'ESE: state change and event commit together',
    scope: 'experience_signal_engine',
    requirement: 'concurrency',
    command: ['node', '--test', 'tests/live/outbox.atomicity.test.ts'],
    requiresEnv: 'RAGERS_TEST_DATABASE_URL',
    blockedWithoutEnv:
      'No database is configured, so the transaction cannot be made to fail between the rows and the event.',
  },
  {
    id: 'ese_intelligence_live',
    name: 'ESE: intelligence chain against a live database',
    scope: 'experience_signal_engine',
    requirement: 'ese/intelligence',
    command: ['node', '--test', 'tests/live/intelligence.chain.test.ts'],
    requiresEnv: 'RAGERS_TEST_DATABASE_URL',
    blockedWithoutEnv: 'No database is configured, so the jsonb and numeric round-trips cannot be exercised.',
  },
  {
    id: 'ese_been_there_backfill',
    name: 'ESE: the Been There backfill loses and invents nothing',
    scope: 'experience_signal_engine',
    requirement: 'schema/migrations',
    command: ['node', '--test', 'tests/live/migration.retire-been-there.test.ts'],
    requiresEnv: 'RAGERS_TEST_DATABASE_URL',
    blockedWithoutEnv: 'No database is configured, so the data migration cannot be run against rows.',
  },
  {
    id: 'ese_browser_boundary',
    name: 'ESE: the certification boundary flow, in a browser',
    scope: 'experience_signal_engine',
    requirement: 'browser E2E',
    command: ['npx', 'playwright', 'test', '--project=experience-signal-engine'],
  },
  // ── Engine contracts: dispute, relate, responsiveness, proposals ───────
  {
    id: 'contracts_domain',
    name: 'Contracts: dispute, Relate and proposal semantics',
    requirement: 'ese/contract',
    command: ['node', '--test', 'tests/unit/dispute.relate.proposal.test.ts'],
  },
  {
    id: 'contracts_engine',
    name: 'Contracts: the four gaps end to end through the bus',
    requirement: 'ese/contract',
    command: ['node', '--test', 'tests/integration/contracts.engine.test.ts'],
  },
  {
    id: 'persona_authorization',
    name: 'Persona authorization: the five refusals',
    requirement: 'authorization',
    command: ['node', '--test', 'tests/integration/persona.authorization.test.ts'],
  },
  {
    id: 'outcome_presentation',
    name: 'Outcome states are distinguishable, including a proposed resolution',
    requirement: 'ese/resolution',
    command: ['node', '--test', 'tests/unit/outcome.presentation.test.ts'],
  },
  {
    id: 'host_surfaces',
    name: 'Host surface guards, including the fixture route',
    requirement: 'security',
    command: ['node', '--test', 'tests/unit/host.surfaces.test.ts'],
  },
  {
    id: 'contracts_live',
    name: 'Contracts against a live database: races, RLS and numerics',
    requirement: 'authorization',
    command: ['node', '--test', 'tests/live/contracts.live.test.ts'],
    requiresEnv: 'RAGERS_TEST_DATABASE_URL',
    blockedWithoutEnv:
      'No database is configured, so the partial unique index and the dispute RLS policies cannot be executed.',
  },
  {
    id: 'relate_reputation_surfaces',
    name: 'Surfaces: Relate carries no weight; reputation shows no score',
    requirement: 'browser E2E',
    command: ['npx', 'playwright', 'test', '--project=relate-reputation'],
  },
  // ── Phases 31–40: Trust, Governance & Action ────────────────────────────
  {
    id: 'phases_31_40_domain',
    name: 'P31–35: severity is asserted, escalation decides nothing',
    scope: 'governance_action',
    requirement: 'phases/31-35',
    command: ['node', '--test', 'tests/unit/severity.escalation.test.ts'],
  },
  {
    id: 'phases_38_40_domain',
    name: 'P38–40: a measure withheld beats a measure invented',
    scope: 'governance_action',
    requirement: 'phases/38-40',
    command: ['node', '--test', 'tests/unit/sampling.aggregation.test.ts'],
  },
  {
    id: 'phases_31_40_bus',
    name: 'P31–40 end to end through the bus',
    scope: 'governance_action',
    requirement: 'phases/31-40',
    command: ['node', '--test', 'tests/integration/governance.action.test.ts'],
  },
  {
    id: 'phases_31_40_live',
    name: 'P31–40 against a live database: constraints, races and jsonb',
    scope: 'governance_action',
    requirement: 'phases/31-40/live',
    command: ['node', '--test', 'tests/live/governance.action.live.test.ts'],
    requiresEnv: 'RAGERS_TEST_DATABASE_URL',
    blockedWithoutEnv:
      'No database is configured. The unique constraints that arbitrate concurrent escalations and handoffs, and the jsonb round trip, cannot be certified without one.',
  },
  {
    id: 'phases_31_40_browser',
    name: 'P31–40 in a browser: no band without an assertion, no rate below the floor',
    scope: 'governance_action',
    requirement: 'phases/31-40/surfaces',
    command: ['npx', 'playwright', 'test', '--project=governance-action'],
  },
  // ── Phases 41–50: Agentic Experience OS ─────────────────────────────────
  {
    id: 'phases_41_43_domain',
    name: 'P41–43: severity, urgency and priority stay three questions',
    scope: 'experience_os',
    requirement: 'phases/41-43',
    command: ['node', '--test', 'tests/unit/urgency.impact.priority.test.ts'],
  },
  {
    id: 'phases_44_47_domain',
    name: 'P44–47: an agent has no write verb, and a benchmark names nobody',
    scope: 'experience_os',
    requirement: 'phases/44-47',
    command: ['node', '--test', 'tests/unit/agent.benchmark.test.ts'],
  },
  {
    id: 'phases_48_49_domain',
    name: 'P48–49: the integrity layer is blind to payment; a webhook is signed and isolated',
    scope: 'experience_os',
    requirement: 'phases/48-49',
    command: ['node', '--test', 'tests/unit/entitlement.integration.test.ts'],
  },
  {
    id: 'phases_41_50_bus',
    name: 'P41–50 end to end through the bus, including replay',
    scope: 'experience_os',
    requirement: 'phases/41-50',
    command: ['node', '--test', 'tests/integration/governance.action.test.ts'],
  },
  {
    id: 'phases_41_50_live',
    name: 'P41–50 against a live database: constraints, races and coherence',
    scope: 'experience_os',
    requirement: 'phases/41-50/live',
    command: ['node', '--test', 'tests/live/governance.action.live.test.ts'],
    requiresEnv: 'RAGERS_TEST_DATABASE_URL',
    blockedWithoutEnv:
      'No database is configured. The unique and coherence constraints that arbitrate concurrent agent runs and deliveries cannot be certified without one.',
  },
  {
    id: 'convergence_circular',
    name: 'Convergence: one full lap, Rage and Rave, every distinction intact',
    scope: 'experience_os',
    requirement: 'convergence/circular',
    command: ['node', '--test', 'tests/integration/convergence.circular.test.ts'],
  },
  {
    id: 'phases_51_55',
    name: 'P51–55: a connection is not weight, a memory names nobody, a signal can end',
    scope: 'experience_loop',
    requirement: 'phases/51-55',
    command: ['node', '--test', 'tests/unit/relationship.memory.history.test.ts', 'tests/unit/lifecycle.decay.test.ts'],
  },
  {
    id: 'phases_56_59',
    name: 'P56–59: reputation replays, a conclusion is checkable, a plan cannot launder privilege',
    scope: 'experience_loop',
    requirement: 'phases/56-59',
    command: [
      'node',
      '--test',
      'tests/unit/evolution.conclusion.plan.test.ts',
      'tests/integration/loop.intelligence.test.ts',
    ],
  },
  {
    id: 'phases_51_60_bus',
    name: 'P51–60 end to end through the bus',
    scope: 'experience_loop',
    requirement: 'phases/51-60',
    command: ['node', '--test', 'tests/integration/experience.loop.test.ts'],
  },
  {
    id: 'loop_certification',
    name: 'The experience loop closes, for a Rage and again for a Rave',
    scope: 'experience_loop',
    requirement: 'loop/certification',
    command: ['node', '--test', 'tests/integration/loop.certification.test.ts'],
  },
  {
    id: 'phases_51_60_live',
    name: 'P51–60 against a live database: the reads see real rows, and the plan constraints hold',
    scope: 'experience_loop',
    requirement: 'phases/51-60/live',
    command: ['node', '--test', 'tests/live/experience.loop.live.test.ts'],
    requiresEnv: 'RAGERS_TEST_DATABASE_URL',
    blockedWithoutEnv:
      'No database is configured. The recommendation ledger arbitrates concurrent sweeps at its primary key and the action-plan constraints refuse a plan claiming completion it did not earn — neither is certifiable without one.',
  },
  {
    id: 'phases_61_64',
    name: 'P61–64: a quota is not a judgement, detection is not an action, a reply can be actioned',
    scope: 'operational_integrity',
    requirement: 'phases/61-64',
    command: [
      'node',
      '--test',
      'tests/unit/quota.governance.test.ts',
      'tests/unit/coordination.reply.test.ts',
      'tests/integration/quota.enforcement.test.ts',
    ],
  },
  {
    id: 'phases_65_68',
    name: 'P65–68: a stated ceiling, one reported state, and a rule for the audit trail',
    scope: 'operational_integrity',
    requirement: 'phases/65-68',
    command: [
      'node',
      '--test',
      'tests/unit/retention.policy.test.ts',
      'tests/unit/degraded.mode.test.ts',
      'tests/integration/retention.sweep.test.ts',
      'tests/integration/audit.completeness.test.ts',
    ],
  },
  {
    id: 'phase_66_incidents',
    name: 'P66: the incident surface reports and does not act',
    scope: 'operational_integrity',
    requirement: 'phases/66',
    command: ['node', '--test', 'tests/integration/incident.surface.test.ts'],
  },
  {
    id: 'operational_integrity_certification',
    name: 'Operational integrity, for a Rage and again for a Rave',
    scope: 'operational_integrity',
    requirement: 'operational/certification',
    command: ['node', '--test', 'tests/integration/operational.integrity.test.ts'],
  },
  {
    id: 'tenant_isolation_sweep',
    name: 'P69: every table swept, and no world-readable table names a person',
    scope: 'operational_integrity',
    requirement: 'phases/69/live',
    command: ['node', '--test', 'tests/live/tenant.isolation.test.ts'],
    requiresEnv: 'RAGERS_TEST_DATABASE_URL',
    blockedWithoutEnv:
      'No database is configured. The sweep enumerates tables, policies and column grants from pg_catalog, and none of that exists without one — which is exactly why the four world-readable identity columns it found had survived a green in-memory suite.',
  },
  {
    id: 'phases_71_74',
    name: 'P71–74: corroboration outranks engagement, and a profile knows only what you declared',
    scope: 'discovery_network',
    requirement: 'phases/71-74',
    command: ['node', '--test', 'tests/unit/relevance.test.ts'],
  },
  {
    id: 'phases_76_79',
    name: 'P76–79: reach counts people, emerging is not verified, a notification has stages',
    scope: 'discovery_network',
    requirement: 'phases/76-79',
    command: ['node', '--test', 'tests/unit/reach.notification.test.ts'],
  },
  {
    id: 'discovery_reads',
    name: 'P71–75, 78 through the store: removed content is absent before its consumer drains',
    scope: 'discovery_network',
    requirement: 'phases/71-78',
    command: ['node', '--test', 'tests/integration/discovery.watch.test.ts'],
  },
  {
    id: 'discovery_certification',
    name: 'The discovery lap closes, for a Rage and again for a Rave',
    scope: 'discovery_network',
    requirement: 'discovery/certification',
    command: ['node', '--test', 'tests/integration/discovery.certification.test.ts'],
  },
  {
    id: 'phases_81_85_rules',
    name: 'P81–85: confidence counts people, and a fast non-answer is not a good one',
    scope: 'trust_quality',
    requirement: 'phases/81-85',
    command: ['node', '--test', 'tests/unit/confidence.quality.test.ts'],
  },
  {
    id: 'phases_81_85_rows',
    name: 'P81–85 through the store: six rows from one account are one person',
    scope: 'trust_quality',
    requirement: 'phases/81-85',
    command: ['node', '--test', 'tests/integration/confidence.quality.test.ts'],
  },
  {
    id: 'phases_86_90',
    name: 'P86–90: eligibility before personalization, and approval is not standing',
    scope: 'trust_quality',
    requirement: 'phases/86-90',
    command: ['node', '--test', 'tests/integration/personalization.certification.test.ts'],
  },
  {
    id: 'trust_quality_live',
    name: 'P81–85 against a live database: the series is append-only and staff-only',
    scope: 'trust_quality',
    requirement: 'phases/81-85/live',
    command: ['node', '--test', 'tests/live/confidence.history.test.ts'],
    requiresEnv: 'RAGERS_TEST_DATABASE_URL',
    blockedWithoutEnv:
      'No database is configured. The append-only trigger, the one-point-per-boundary constraint and the two recommendation-memory check constraints are database guarantees; asserting them in memory would assert something about a Map.',
  },
  {
    id: 'phases_91_95_rules',
    name: 'P91–95: default deny, an explanation that says why it is withheld, a stated blast radius',
    scope: 'authority_release',
    requirement: 'phases/91-95',
    command: ['node', '--test', 'tests/unit/authority.explainability.test.ts'],
  },
  {
    id: 'phases_96_99_rules',
    name: 'P96, 99: replay recomputes and never re-decides; a release cannot claim more than its weakest dimension',
    scope: 'authority_release',
    requirement: 'phases/96-99',
    command: ['node', '--test', 'tests/unit/replay.release.test.ts'],
  },
  {
    id: 'authority_control_rows',
    name: 'P91–95 through the bus: a control that nothing consults is a row, not a switch',
    scope: 'authority_release',
    requirement: 'phases/91-95',
    command: ['node', '--test', 'tests/integration/authority.control.test.ts'],
  },
  {
    id: 'experience_os_certification',
    name: 'The whole Experience OS circle closes, for a Rage and again for a Rave',
    scope: 'authority_release',
    requirement: 'os/certification',
    command: ['node', '--test', 'tests/integration/experience-os.certification.test.ts'],
  },
  {
    id: 'privacy_certification',
    name: 'P98: the twelve privacy rules against a live schema',
    scope: 'authority_release',
    requirement: 'privacy',
    command: ['node', '--test', 'tests/live/privacy.certification.test.ts'],
    requiresEnv: 'RAGERS_TEST_DATABASE_URL',
    blockedWithoutEnv:
      'No database is configured. Column grants, policies, definer functions and foreign-key refusals are all database facts; asserting them in memory would assert something about a Map.',
  },
  {
    id: 'command_boundaries',
    name: 'Command boundaries: bad input is refused, never reported as a defect',
    scope: 'experience_os',
    requirement: 'boundaries/commands',
    command: ['node', '--test', 'tests/integration/command.boundaries.test.ts'],
  },
  {
    id: 'command_boundaries_live',
    name: 'Command boundaries against a live database: the refusal precedes the write',
    scope: 'experience_os',
    requirement: 'boundaries/commands/live',
    command: ['node', '--test', 'tests/live/command.boundaries.live.test.ts'],
    requiresEnv: 'RAGERS_TEST_DATABASE_URL',
    blockedWithoutEnv:
      'No database is configured. Whether a missing refusal costs a bad row, a driver error or a silent coercion depends on the column type, and only Postgres has column types.',
  },
  {
    id: 'deployment',
    name: 'Deployment to a target environment',
    requirement: 'deployment',
    blockedBy:
      'No deployment target (Vercel/Railway project, or hosting credentials) is configured, so no environment can be deployed to and verified.',
  },
  {
    id: 'rollback',
    name: 'Rollback drill',
    requirement: 'rollback',
    blockedBy:
      'Requires a deployed environment to roll back. The additive-migration rule rollback depends on is enforced by the static-validation gate, and the migration runner refuses drift, but the drill itself needs a deployment. Procedure in docs/OPERATIONS.md §5.',
  },
];

/**
 * Status decision. Deliberately strict: one red runnable gate is a NO_GO, and
 * blocked gates can never produce a plain READY.
 */
export const decideStatus = (results: readonly GateResult[]): CertificationStatus => {
  if (results.some((result) => result.status === 'failed')) return 'RAGERS_ENGINE_E2E_NO_GO';
  if (results.some((result) => result.status === 'blocked')) {
    return 'RAGERS_ENGINE_E2E_READY_WITH_EXTERNAL_BLOCKERS';
  }
  if (results.length === 0) return 'RAGERS_ENGINE_E2E_NO_GO';
  return 'RAGERS_ENGINE_E2E_READY';
};

/**
 * The Experience Signal Engine's status, decided over its own gates only.
 *
 * Reported separately because the two can legitimately differ: the platform can
 * be held short of READY by a missing deployment target while the corroboration
 * contract itself is fully certified — and conflating them would hide whichever
 * of the two is actually broken.
 */
export const decideExperienceSignalEngineStatus = (
  results: readonly GateResult[],
): ExperienceSignalEngineStatus => {
  const own = results.filter((result) => result.scope === 'experience_signal_engine');
  if (own.length === 0) return 'EXPERIENCE_SIGNAL_ENGINE_NOT_READY';
  if (own.some((result) => result.status === 'failed')) return 'EXPERIENCE_SIGNAL_ENGINE_NOT_READY';
  if (own.some((result) => result.status === 'blocked')) {
    return 'EXPERIENCE_SIGNAL_ENGINE_READY_WITH_BLOCKERS';
  }
  return 'EXPERIENCE_SIGNAL_ENGINE_READY';
};

export const decideGovernanceActionStatus = (results: readonly GateResult[]): GovernanceActionStatus => {
  const own = results.filter((result) => result.scope === 'governance_action');
  if (own.length === 0) return 'PHASES_31_40_NOT_READY';
  if (own.some((result) => result.status === 'failed')) return 'PHASES_31_40_NOT_READY';
  if (own.some((result) => result.status === 'blocked')) return 'PHASES_31_40_READY_WITH_EXTERNAL_BLOCKERS';
  return 'PHASES_31_40_READY';
};

/**
 * The Experience OS status.
 *
 * `dataBlocked` is passed in rather than inferred from a gate, because it is a fact about the
 * *data* and every gate here passes: the code is certified and the sample is absent. Folding
 * it into a gate result would mean either failing a working gate or hiding the gap.
 */
export const decideExperienceOsStatus = (
  results: readonly GateResult[],
  dataBlocked: boolean,
): ExperienceOsStatus => {
  const own = results.filter((result) => result.scope === 'experience_os');
  if (own.length === 0) return 'RAGERS_EXPERIENCE_OS_NOT_READY';
  if (own.some((result) => result.status === 'failed')) return 'RAGERS_EXPERIENCE_OS_NOT_READY';
  if (own.some((result) => result.status === 'blocked')) return 'RAGERS_EXPERIENCE_OS_READY_WITH_BLOCKERS';
  if (dataBlocked) return 'RAGERS_EXPERIENCE_OS_CODE_READY_DATA_BLOCKED';
  return 'RAGERS_EXPERIENCE_OS_READY';
};

export const decideExperienceLoopStatus = (results: readonly GateResult[]): ExperienceLoopStatus => {
  const own = results.filter((result) => result.scope === 'experience_loop');
  if (own.length === 0) return 'PHASES_51_60_NOT_READY';
  if (own.some((result) => result.status === 'failed')) return 'PHASES_51_60_NOT_READY';
  if (own.some((result) => result.status === 'blocked')) return 'PHASES_51_60_READY_WITH_EXTERNAL_BLOCKERS';
  return 'PHASES_51_60_READY';
};

/**
 * Phases 61–70.
 *
 * `objectStorageBlocked` is passed in rather than inferred from a gate, for the same reason
 * the benchmark data block is: every retention gate *passes*. The policy is certified, the
 * ceilings are enforced, the ledger is written — and the bytes behind the keys are in a
 * store nothing has configured. Folding that into a gate would mean either failing working
 * code or hiding the gap, and the honest third option is a status that names it.
 */
export const decideDiscoveryNetworkStatus = (
  results: readonly GateResult[],
): DiscoveryNetworkStatus => {
  const own = results.filter((result) => result.scope === 'discovery_network');
  if (own.length === 0) return 'PHASES_71_80_NOT_READY';
  if (own.some((result) => result.status === 'failed')) return 'PHASES_71_80_NOT_READY';
  if (own.some((result) => result.status === 'blocked')) return 'PHASES_71_80_READY_WITH_EXTERNAL_BLOCKERS';
  return 'PHASES_71_80_READY';
};

export const decideTrustQualityStatus = (results: readonly GateResult[]): TrustQualityStatus => {
  const own = results.filter((result) => result.scope === 'trust_quality');
  if (own.length === 0) return 'PHASES_81_90_NOT_READY';
  if (own.some((result) => result.status === 'failed')) return 'PHASES_81_90_NOT_READY';
  if (own.some((result) => result.status === 'blocked')) return 'PHASES_81_90_READY_WITH_EXTERNAL_BLOCKERS';
  return 'PHASES_81_90_READY';
};

export const decideAuthorityReleaseStatus = (
  results: readonly GateResult[],
): AuthorityReleaseStatus => {
  const own = results.filter((result) => result.scope === 'authority_release');
  if (own.length === 0) return 'PHASES_91_100_NOT_READY';
  if (own.some((result) => result.status === 'failed')) return 'PHASES_91_100_NOT_READY';
  if (own.some((result) => result.status === 'blocked')) return 'PHASES_91_100_READY_WITH_EXTERNAL_BLOCKERS';
  return 'PHASES_91_100_READY';
};

export const decideOperationalIntegrityStatus = (
  results: readonly GateResult[],
  objectStorageBlocked: boolean,
): OperationalIntegrityStatus => {
  const own = results.filter((result) => result.scope === 'operational_integrity');
  if (own.length === 0) return 'PHASES_61_70_NOT_READY';
  if (own.some((result) => result.status === 'failed')) return 'PHASES_61_70_NOT_READY';
  if (own.some((result) => result.status === 'blocked') || objectStorageBlocked) {
    return 'PHASES_61_70_READY_WITH_EXTERNAL_BLOCKERS';
  }
  return 'PHASES_61_70_READY';
};

export interface CertificationReport {
  readonly status: CertificationStatus;
  readonly experienceSignalEngineStatus: ExperienceSignalEngineStatus;
  readonly governanceActionStatus: GovernanceActionStatus;
  readonly experienceOsStatus: ExperienceOsStatus;
  readonly experienceLoopStatus: ExperienceLoopStatus;
  readonly operationalIntegrityStatus: OperationalIntegrityStatus;
  readonly discoveryNetworkStatus: DiscoveryNetworkStatus;
  readonly trustQualityStatus: TrustQualityStatus;
  readonly authorityReleaseStatus: AuthorityReleaseStatus;
  /** Phase 99. The eight release dimensions, each read independently. */
  readonly release: readonly DimensionReading[];
  readonly generatedAt: string;
  readonly totals: { passed: number; failed: number; blocked: number };
  readonly results: readonly GateResult[];
}

export const buildReport = (
  results: readonly GateResult[],
  generatedAt: string,
  options: {
    readonly benchmarkDataBlocked?: boolean;
    readonly objectStorageBlocked?: boolean;
    /** Phase 99. Whether any live transcription, PII or model provider is configured. */
    readonly liveProvidersBlocked?: boolean;
    /** Whether a real sign-in credential mechanism exists. Absent by default. */
    readonly signInCredentialsBlocked?: boolean;
  } = {},
): CertificationReport => ({
  status: decideStatus(results),
  experienceSignalEngineStatus: decideExperienceSignalEngineStatus(results),
  governanceActionStatus: decideGovernanceActionStatus(results),
  experienceOsStatus: decideExperienceOsStatus(results, options.benchmarkDataBlocked ?? false),
  experienceLoopStatus: decideExperienceLoopStatus(results),
  operationalIntegrityStatus: decideOperationalIntegrityStatus(results, options.objectStorageBlocked ?? true),
  discoveryNetworkStatus: decideDiscoveryNetworkStatus(results),
  trustQualityStatus: decideTrustQualityStatus(results),
  authorityReleaseStatus: decideAuthorityReleaseStatus(results),
  // Phase 99. Derived from the same gates plus what the environment actually provides, so a
  // dimension cannot be set by hand — see `src/certification/release.ts`.
  release: readDimensions({
    results,
    objectStorageReady: !(options.objectStorageBlocked ?? true),
    benchmarkDataReady: !(options.benchmarkDataBlocked ?? true),
    liveProvidersReady: !(options.liveProvidersBlocked ?? true),
    signInCredentialsReady: !(options.signInCredentialsBlocked ?? true),
  }),
  generatedAt,
  totals: {
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    blocked: results.filter((r) => r.status === 'blocked').length,
  },
  results,
});

const ICON: Readonly<Record<GateStatus, string>> = {
  passed: '✅',
  failed: '❌',
  blocked: '⛔',
};

/** Render the evidence ledger. */
export const renderLedger = (report: CertificationReport): string => {
  const lines: string[] = [];
  lines.push('# Ragers Engine — Certification Evidence Ledger');
  lines.push('');
  lines.push('**Classification:** Internal. Generated by `npm run certify` in `engine/`.');
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push('');
  lines.push(`## Certification status: \`${report.status}\``);
  lines.push('');
  lines.push(`## Experience Signal Engine status: \`${report.experienceSignalEngineStatus}\``);
  lines.push('');
  lines.push(`## Phases 31–40 status: \`${report.governanceActionStatus}\``);
  lines.push('');
  lines.push(`## Phases 41–50 status: \`${report.experienceOsStatus}\``);
  lines.push('');
  lines.push(`## Phases 51–60 status: \`${report.experienceLoopStatus}\``);
  lines.push('');
  lines.push(`## Phases 61–70 status: \`${report.operationalIntegrityStatus}\``);
  lines.push('');
  lines.push(`## Phases 71–80 status: \`${report.discoveryNetworkStatus}\``);
  lines.push('');
  lines.push(`## Phases 81–90 status: \`${report.trustQualityStatus}\``);
  lines.push('');
  lines.push(`## Phases 91–100 status: \`${report.authorityReleaseStatus}\``);
  lines.push('');
  lines.push('## Release readiness');
  lines.push('');
  lines.push(
    'Eight dimensions, read independently. **`BLOCKED` and `NOT_READY` are different values:** ' +
      '`NOT_READY` means a gate failed, and `BLOCKED` means the evidence needs something this ' +
      'environment does not have. Collapsing them would make a deployment nobody can attempt read ' +
      'as a deployment that failed, and the fix for those two is not the same. No dimension can be ' +
      'set by hand — each is derived from the gates above and from what the environment provides.',
  );
  lines.push('');
  lines.push('| Dimension | Value | Evidence | Missing or conditional on |');
  lines.push('|---|---|---|---|');
  for (const reading of report.release) {
    lines.push(
      `| \`${reading.dimension}\` | ${reading.value} | ${reading.evidence} | ${reading.missing ?? reading.condition ?? '—'} |`,
    );
  }
  lines.push('');
  lines.push(
    'Nine statuses, because they answer different questions. The engine status is about ' +
      'whether the platform is operable; the Experience Signal Engine status is about whether ' +
      'the corroboration contract holds — that a count of people is a count of people, that a ' +
      'share is never a claim, and that a response is never a resolution. The Phases 31–40 ' +
      'status is about whether measuring is kept apart from deciding: severity from what people ' +
      'asserted, a measure withheld rather than invented below its floor, an escalation that ' +
      'opens a review and nothing more, and a handoff that proposes without mutating anything. ' +
      'The Phases 41–50 status is about whether AI stays downstream of governance: an agent ' +
      'whose only output is a proposal, a person who decides, a target engine that can still ' +
      'refuse, a measure that says so when the data is absent, and payment that reaches ' +
      'nothing deciding an outcome. The Phases 51–60 status is about what the system may ' +
      'remember, connect and conclude the second time: a relationship between experiences and ' +
      'never between people, a memory of an experience rather than of a person, a history that ' +
      'is not a ranking, a signal that can stop being current without any row being erased, ' +
      'reputation that is neither popularity nor one opaque number, and a plan of several ' +
      'governed steps that cannot launder privilege past the policy matrix. The Phases ' +
      '61–70 status is the one that is not about correctness at all: it is about whether the ' +
      'system is safe to *operate*. Being throttled is never being judged; detection opens a ' +
      'review and never takes an action; a reported reply can actually be actioned; a deletion ' +
      'leaves no stored reference behind; a raw artefact has a stated ceiling and expires ' +
      'without taking the account with it; an unavailable dependency produces one reported ' +
      'state rather than three unrelated-looking bugs; and every action taken under authority ' +
      'about somebody else is attributable. The Phases 71–80 status answers the question the ' +
      'discovery band was built around: whether the product can become more useful as the ' +
      'network grows without its ranking becoming a popularity contest. Corroboration outranks ' +
      'engagement rather than being summed into it; every ordering states the factor that ' +
      'decided it; an unvoted experience is not treated as an unfair one; trust may constrain ' +
      'amplification and never ranks; reach counts people and a share is not reach; an emerging ' +
      'pattern is never described as established; a watcher is invisible in both directions; ' +
      'and nothing removed, hidden or unpublished reaches a discovery read, a search hit or a ' +
      'notification payload. The Phases 81–90 status asks the stronger version of that ' +
      'question: whether the product can become *personally relevant* without learning to ' +
      'reward outrage, exposing trust internals, or constructing a hidden profile of anybody. ' +
      'A count of people stays a count of people and confidence is a separate measure over ' +
      'it; no per-person trust figure enters any confidence, reliability or quality read; ' +
      'resolved and well resolved are two facts rather than one score; there is no ' +
      'leaderboard of contributors, which would be worse than one of organizations; ' +
      'eligibility runs before personalization, so a preference can never become a ' +
      'permission; a measure withheld below its floor is not laundered into a conclusion; ' +
      'and an approval covers the steps it was given and not the ones added afterwards.',
  );
  lines.push('');
  lines.push(
    `${report.totals.passed} gate(s) passed, ${report.totals.failed} failed, ${report.totals.blocked} blocked by an external dependency.`,
  );
  lines.push('');
  lines.push('| | Gate | Required gate | Result |');
  lines.push('|---|---|---|---|');
  for (const result of report.results) {
    const detail = result.status === 'blocked' ? (result.blockedBy ?? 'blocked') : result.detail;
    lines.push(`| ${ICON[result.status]} | ${result.name} | ${result.requirement} | ${detail} |`);
  }
  lines.push('');

  const blocked = report.results.filter((result) => result.status === 'blocked');
  if (blocked.length > 0) {
    lines.push('## External blockers');
    lines.push('');
    lines.push(
      'These gates are not runnable in this environment. They are named rather than skipped, and they are why the status is not a plain `RAGERS_ENGINE_E2E_READY`.',
    );
    lines.push('');
    for (const result of blocked) {
      lines.push(`- **${result.name}** — ${result.blockedBy ?? 'blocked'}`);
    }
    lines.push('');
  }

  const failed = report.results.filter((result) => result.status === 'failed');
  if (failed.length > 0) {
    lines.push('## Failing gates');
    lines.push('');
    lines.push(
      'Named, with what failed and where. A gate that recorded only a count would leave the next reader with no option but a blind re-run — and a re-run that passes says nothing about what failed the first time.',
    );
    lines.push('');
    for (const result of failed) {
      lines.push(`### ${result.name}`);
      lines.push('');
      lines.push(`- **Result** — ${result.detail}`);
      if (result.command !== undefined) lines.push(`- **Command** — \`${result.command}\``);
      if (result.exitCode !== undefined) {
        lines.push(`- **Exit code** — ${result.exitCode === null ? 'killed by a signal' : result.exitCode}`);
      }
      for (const failure of result.failureSummary ?? []) {
        const where = failure.location === undefined ? '' : ` (${failure.location})`;
        lines.push(`- **Failed** — ${failure.test}${where}`);
        if (failure.assertion !== undefined) lines.push(`  - ${failure.assertion}`);
      }
      if (result.failuresOmitted !== undefined) {
        lines.push(`- ${result.failuresOmitted} further failure(s) not listed here.`);
      }
      if (result.evidenceExcerpt !== undefined) {
        lines.push('');
        lines.push('<details><summary>Output excerpt</summary>');
        lines.push('');
        lines.push('```');
        lines.push(result.evidenceExcerpt);
        lines.push('```');
        lines.push('');
        lines.push('</details>');
      }
      lines.push('');
    }
  }

  /**
   * Gates that failed and then passed.
   *
   * Reported even though the run is green, because that is the only reason this
   * section exists: a transient failure that leaves no trace is one nobody
   * investigates, and the second time it happens the evidence is gone again.
   */
  const transient = report.results.filter(
    (result) => result.conclusion === 'INITIAL_FAIL_RETRY_PASS' || result.conclusion === 'INITIAL_FAIL_RETRY_FAIL',
  );
  if (transient.length > 0) {
    lines.push('## Gates that did not pass first time');
    lines.push('');
    lines.push(
      'These reached their final state across more than one attempt. The status above reflects the final attempt; this section is here so the earlier one is not erased.',
    );
    lines.push('');
    for (const result of transient) {
      lines.push(`### ${result.name} — \`${result.conclusion}\``);
      lines.push('');
      for (const attempt of result.attempts ?? []) {
        lines.push(`- **Attempt ${attempt.attempt}** (${attempt.status}) — ${attempt.detail}`);
        for (const failure of attempt.failureSummary ?? []) {
          lines.push(`  - ${failure.test}${failure.assertion === undefined ? '' : `: ${failure.assertion}`}`);
        }
      }
      lines.push('');
    }
  }

  lines.push('## Reproducing this ledger');
  lines.push('');
  lines.push('```bash');
  lines.push('cd engine');
  lines.push('npm install');
  lines.push('npm run certify');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
};
