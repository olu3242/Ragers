import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  buildReport,
  GATES,
  renderLedger,
  type GateResult,
} from '../src/certification/harness.ts';

/**
 * Run every gate and write the evidence ledger. Synchronous by design: a
 * certification run must be reproducible, not racy.
 */
const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = join(here, '..');
const repoRoot = join(engineRoot, '..');

const only = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));

const results: GateResult[] = [];

for (const gate of GATES) {
  if (only.length > 0 && !only.includes(gate.id)) continue;

  // A gate whose dependency is absent is blocked, never silently skipped and
  // never counted as a pass.
  const missingEnv =
    gate.requiresEnv !== undefined &&
    (process.env[gate.requiresEnv] ?? process.env['DATABASE_URL']) === undefined;
  const blockedBy = gate.blockedBy ?? (missingEnv ? gate.blockedWithoutEnv : undefined);

  if (!gate.command || blockedBy !== undefined) {
    results.push({
      id: gate.id,
      name: gate.name,
      ...(gate.scope === undefined ? {} : { scope: gate.scope }),
      requirement: gate.requirement,
      status: 'blocked',
      durationMs: 0,
      detail: 'blocked by an external dependency',
      ...(blockedBy === undefined ? {} : { blockedBy }),
    });
    process.stdout.write(`⛔ ${gate.name} — blocked\n`);
    continue;
  }

  const startedAt = Date.now();
  const [command, ...args] = gate.command;
  const outcome = spawnSync(command as string, args, {
    cwd: engineRoot,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
    maxBuffer: 32 * 1024 * 1024,
  });
  const durationMs = Date.now() - startedAt;
  const combined = `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`;
  const passed = outcome.status === 0;

  // Summarise rather than paste output: the ledger is a record, not a log.
  const testCount = /^# tests (\d+)$/m.exec(combined)?.[1];
  const passCount = /^# pass (\d+)$/m.exec(combined)?.[1];
  const failCount = /^# fail (\d+)$/m.exec(combined)?.[1];
  const playwright = /(\d+) passed/.exec(combined)?.[1];

  let detail: string;
  if (testCount && passCount) {
    detail = `${passCount}/${testCount} assertions passed`;
    if (failCount && failCount !== '0') detail += `, ${failCount} failed`;
  } else if (playwright) {
    detail = `${playwright} browser test(s) passed`;
  } else if (passed) {
    detail = 'clean';
  } else {
    const firstError = combined.split('\n').find((line) => /error|Error|failed/.test(line))?.trim();
    detail = firstError ? firstError.slice(0, 160) : `exited ${outcome.status}`;
  }
  detail += ` (${(durationMs / 1000).toFixed(1)}s)`;

  results.push({
    id: gate.id,
    name: gate.name,
    ...(gate.scope === undefined ? {} : { scope: gate.scope }),
    requirement: gate.requirement,
    status: passed ? 'passed' : 'failed',
    durationMs,
    detail,
  });
  process.stdout.write(`${passed ? '✅' : '❌'} ${gate.name} — ${detail}\n`);
}

/**
 * Phase 47 is data-blocked, and this is where that is declared.
 *
 * Not inferred from a gate, because every Phase 47 gate *passes*: the aggregation is
 * certified, the floors are enforced, and the output is empty because no environment the
 * harness runs in has twenty distinct contributors per comparison set. Folding that into a
 * gate would mean either failing working code or hiding the gap.
 *
 * `RAGERS_BENCHMARK_DATA_READY=1` is how a deployment with real volume flips it. Until
 * something sets it, the honest status is CODE_READY_DATA_BLOCKED — and a run that quietly
 * reported READY here would be claiming a benchmark nobody could actually produce.
 */
const benchmarkDataBlocked = process.env['RAGERS_BENCHMARK_DATA_READY'] !== '1';

const report = buildReport(results, new Date().toISOString(), { benchmarkDataBlocked });

// Only a full run may rewrite the ledger; a partial run reports to stdout only.
if (only.length === 0) {
  writeFileSync(join(repoRoot, 'docs', 'EVIDENCE.md'), renderLedger(report), 'utf8');
  writeFileSync(
    join(repoRoot, 'docs', 'certification-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
}

process.stdout.write(`\nCertification status: ${report.status}\n`);
process.stdout.write(`Experience Signal Engine status: ${report.experienceSignalEngineStatus}\n`);
process.stdout.write(`Phases 31–40 status: ${report.governanceActionStatus}\n`);
process.stdout.write(`Phases 41–50 status: ${report.experienceOsStatus}\n`);
process.stdout.write(`Phases 51–60 status: ${report.experienceLoopStatus}\n`);
// Either certification failing is a failure: a green platform with a broken
// corroboration contract is not a shippable product.
process.exit(
  report.status === 'RAGERS_ENGINE_E2E_NO_GO' ||
    report.experienceSignalEngineStatus === 'EXPERIENCE_SIGNAL_ENGINE_NOT_READY' ||
    report.governanceActionStatus === 'PHASES_31_40_NOT_READY' ||
    report.experienceOsStatus === 'RAGERS_EXPERIENCE_OS_NOT_READY' ||
    report.experienceLoopStatus === 'PHASES_51_60_NOT_READY'
    ? 1
    : 0,
);
