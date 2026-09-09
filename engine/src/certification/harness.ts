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

/** Which certification a gate belongs to. Absent means the engine's. */
export type GateScope = 'engine' | 'experience_signal_engine';

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

export interface GateResult {
  readonly id: string;
  readonly name: string;
  readonly scope?: GateScope;
  readonly requirement: string;
  readonly status: GateStatus;
  readonly durationMs: number;
  readonly detail: string;
  readonly blockedBy?: string;
}

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

export interface CertificationReport {
  readonly status: CertificationStatus;
  readonly experienceSignalEngineStatus: ExperienceSignalEngineStatus;
  readonly generatedAt: string;
  readonly totals: { passed: number; failed: number; blocked: number };
  readonly results: readonly GateResult[];
}

export const buildReport = (results: readonly GateResult[], generatedAt: string): CertificationReport => ({
  status: decideStatus(results),
  experienceSignalEngineStatus: decideExperienceSignalEngineStatus(results),
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
  lines.push(
    'Two statuses, because they answer different questions. The engine status is about ' +
      'whether the platform is operable; the Experience Signal Engine status is about whether ' +
      'the corroboration contract holds — that a count of people is a count of people, that a ' +
      'share is never a claim, and that a response is never a resolution.',
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
    for (const result of failed) {
      lines.push(`- **${result.name}** — ${result.detail}`);
    }
    lines.push('');
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
