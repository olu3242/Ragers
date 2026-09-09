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

export interface GateDefinition {
  readonly id: string;
  readonly name: string;
  /** Which required gate from docs/ROADMAP.md §P20 this satisfies. */
  readonly requirement: string;
  /** Absent for a blocked gate. */
  readonly command?: readonly string[];
  /** Present only for a blocked gate: what is missing, specifically. */
  readonly blockedBy?: string;
}

export interface GateResult {
  readonly id: string;
  readonly name: string;
  readonly requirement: string;
  readonly status: GateStatus;
  readonly durationMs: number;
  readonly detail: string;
  readonly blockedBy?: string;
}

/** The required gate list, in the order docs/ROADMAP.md §P20 states them. */
export const GATES: readonly GateDefinition[] = [
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
    id: 'live_migrations',
    name: 'Migrations applied to a live database',
    requirement: 'schema/migrations',
    blockedBy:
      'No Postgres/Supabase project is provisioned for this session, so the migrations in supabase/migrations are verified statically but never applied.',
  },
  {
    id: 'rls_enforcement',
    name: 'RLS enforcement against a live database',
    requirement: 'authorization',
    blockedBy:
      'RLS policies can only be executed against a live Postgres instance. The application policy layer they mirror is covered by the authorization gate.',
  },
  {
    id: 'deployment',
    name: 'Deployment to a target environment',
    requirement: 'deployment',
    blockedBy: 'No deployment target (Vercel/Railway project) is configured for this session.',
  },
  {
    id: 'backup_restore',
    name: 'Backup & restore drill',
    requirement: 'backup/restore',
    blockedBy: 'Requires a live database to back up and restore. Procedure is documented in docs/OPERATIONS.md.',
  },
  {
    id: 'rollback',
    name: 'Rollback drill',
    requirement: 'rollback',
    blockedBy: 'Requires a deployed environment to roll back. Procedure is documented in docs/OPERATIONS.md.',
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

export interface CertificationReport {
  readonly status: CertificationStatus;
  readonly generatedAt: string;
  readonly totals: { passed: number; failed: number; blocked: number };
  readonly results: readonly GateResult[];
}

export const buildReport = (results: readonly GateResult[], generatedAt: string): CertificationReport => ({
  status: decideStatus(results),
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
