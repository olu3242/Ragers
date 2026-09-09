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

  if (!gate.command) {
    results.push({
      id: gate.id,
      name: gate.name,
      requirement: gate.requirement,
      status: 'blocked',
      durationMs: 0,
      detail: 'blocked by an external dependency',
      ...(gate.blockedBy === undefined ? {} : { blockedBy: gate.blockedBy }),
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
    requirement: gate.requirement,
    status: passed ? 'passed' : 'failed',
    durationMs,
    detail,
  });
  process.stdout.write(`${passed ? '✅' : '❌'} ${gate.name} — ${detail}\n`);
}

const report = buildReport(results, new Date().toISOString());

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
process.exit(report.status === 'RAGERS_ENGINE_E2E_NO_GO' ? 1 : 0);
