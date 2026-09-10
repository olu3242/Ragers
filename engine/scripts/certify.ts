import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  buildReport,
  conclusionOf,
  GATES,
  mergeAttempt,
  renderLedger,
  type CertificationReport,
  type GateResult,
} from '../src/certification/harness.ts';
import { evidenceFor, redact } from '../src/certification/evidence.ts';

/**
 * Run every gate and write the evidence ledger. Synchronous by design: a
 * certification run must be reproducible, not racy.
 *
 * The parsing that turns a runner's output into evidence lives in
 * `src/certification/evidence.ts` rather than here. It used to live in this file, which
 * is why it was never tested — and an untested summariser is how a gate came to record
 * `10/11` and nothing about which one failed.
 */
const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = join(here, '..');
const repoRoot = join(engineRoot, '..');

const only = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));

/**
 * A previous attempt's report, when CI hands one over.
 *
 * The harness owns no retry loop and this slice does not give it one. But CI *does*
 * re-run failed jobs, and a re-run starting from a clean checkout would otherwise
 * report a green gate with no trace of the run that failed. Pointing
 * `RAGERS_PREVIOUS_REPORT` at the previous attempt's `certification-report.json`
 * carries that attempt forward, so the ledger shows `INITIAL_FAIL_RETRY_PASS` rather
 * than simply `PASS`.
 *
 * Read defensively: a missing, truncated or unparseable artefact must not stop a
 * certification run. The evidence is worth less than the run.
 */
const previousResults = ((): ReadonlyMap<string, GateResult> => {
  const path = process.env['RAGERS_PREVIOUS_REPORT'];
  if (path === undefined || path.length === 0) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CertificationReport;
    if (!Array.isArray(parsed.results)) return new Map();
    return new Map(parsed.results.map((result) => [result.id, result]));
  } catch (cause) {
    process.stdout.write(
      `note: could not read a previous report from ${path} (${cause instanceof Error ? cause.message : String(cause)}); running without retry history\n`,
    );
    return new Map();
  }
})();

/** Fold in the previous attempt, when there was one for this gate. */
const withHistory = (result: GateResult): GateResult => {
  const previous = previousResults.get(result.id);
  if (!previous) return { ...result, conclusion: conclusionOf(result.status) };
  return mergeAttempt(previous, result);
};

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
    results.push(
      withHistory({
        id: gate.id,
        name: gate.name,
        ...(gate.scope === undefined ? {} : { scope: gate.scope }),
        requirement: gate.requirement,
        status: 'blocked',
        durationMs: 0,
        detail: 'blocked by an external dependency',
        // The reason travels with the gate. A blocked gate whose reason was only in
        // the console is a gate nobody can act on later.
        ...(blockedBy === undefined ? {} : { blockedBy }),
        ...(gate.command === undefined ? {} : { command: redact(gate.command.join(' ')) }),
      }),
    );
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
  const passed = outcome.status === 0;

  const evidence = evidenceFor({
    command: gate.command,
    exitCode: outcome.status,
    stdout: outcome.stdout ?? '',
    stderr: outcome.stderr ?? '',
    durationMs,
  });

  results.push(
    withHistory({
      id: gate.id,
      name: gate.name,
      ...(gate.scope === undefined ? {} : { scope: gate.scope }),
      requirement: gate.requirement,
      status: passed ? 'passed' : 'failed',
      durationMs,
      detail: evidence.detail,
      command: evidence.command,
      exitCode: evidence.exitCode,
      counts: evidence.counts,
      ...(evidence.failureSummary.length === 0 ? {} : { failureSummary: evidence.failureSummary }),
      ...(evidence.evidenceExcerpt === undefined ? {} : { evidenceExcerpt: evidence.evidenceExcerpt }),
      ...(evidence.failuresOmitted === undefined ? {} : { failuresOmitted: evidence.failuresOmitted }),
    }),
  );
  const recorded = results.at(-1);
  process.stdout.write(`${passed ? '✅' : '❌'} ${gate.name} — ${evidence.detail}\n`);
  // Named on the console too, so a CI log answers the question without the artefact.
  for (const failure of evidence.failureSummary) {
    process.stdout.write(`     ↳ ${failure.test}${failure.assertion === undefined ? '' : `: ${failure.assertion}`}\n`);
  }
  // A gate that did not pass first time says so here, not only in the ledger: a green
  // console with a transient failure hidden in an artefact is how the failure gets lost.
  if (recorded?.conclusion !== undefined && recorded.conclusion !== 'PASS' && recorded.conclusion !== 'FAIL') {
    process.stdout.write(`     ↳ conclusion across attempts: ${recorded.conclusion}\n`);
  }
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

/**
 * Phase 65's honest blocker, declared here for the same reason Phase 47's is.
 *
 * Every retention gate *passes*: the ceilings are stated, the holds are enforced, the
 * ledger is written, and the byte deletion records `object_storage_blocked` because there
 * is no bucket in any environment this runs in. Folding that into a gate would mean either
 * failing working code or hiding the gap. `RAGERS_OBJECT_STORAGE_READY=1` is how a
 * deployment with real storage flips it.
 */
const objectStorageBlocked = process.env['RAGERS_OBJECT_STORAGE_READY'] !== '1';

const report = buildReport(results, new Date().toISOString(), {
  benchmarkDataBlocked,
  objectStorageBlocked,
});

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
process.stdout.write(`Phases 61–70 status: ${report.operationalIntegrityStatus}\n`);
// Either certification failing is a failure: a green platform with a broken
// corroboration contract is not a shippable product.
process.exit(
  report.status === 'RAGERS_ENGINE_E2E_NO_GO' ||
    report.experienceSignalEngineStatus === 'EXPERIENCE_SIGNAL_ENGINE_NOT_READY' ||
    report.governanceActionStatus === 'PHASES_31_40_NOT_READY' ||
    report.experienceOsStatus === 'RAGERS_EXPERIENCE_OS_NOT_READY' ||
    report.experienceLoopStatus === 'PHASES_51_60_NOT_READY' ||
    report.operationalIntegrityStatus === 'PHASES_61_70_NOT_READY'
    ? 1
    : 0,
);
