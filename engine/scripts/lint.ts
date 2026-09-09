import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/**
 * Static validation.
 *
 * Purpose-built rather than a general linter: these are the project's own
 * architectural rules, the ones a generic ruleset has no opinion about. Type
 * safety is covered by `tsc` under full strict mode, and behaviour by the test
 * suites; this catches the things that would otherwise erode quietly.
 */
const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = join(here, '..');
const repoRoot = join(engineRoot, '..');

interface Finding {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

const findings: Finding[] = [];

const walk = (dir: string, extensions: readonly string[]): readonly string[] => {
  const out: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (extensions.some((extension) => entry.endsWith(extension))) out.push(full);
    }
  };
  if (!statSync(dir, { throwIfNoEntry: false })) return out;
  visit(dir);
  return out;
};

const report = (rule: string, file: string, line: number, detail: string): void => {
  findings.push({ rule, file: relative(repoRoot, file), line, detail });
};

const engineSources = walk(join(engineRoot, 'src'), ['.ts']);
const hostSources = [
  ...walk(join(engineRoot, 'app'), ['.ts', '.tsx']),
  ...walk(join(engineRoot, 'components'), ['.tsx']),
  ...walk(join(engineRoot, 'lib'), ['.ts']),
];

// ── Rule: the engine core logs through the injected logger ────────────────
for (const file of engineSources) {
  for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    if (/\bconsole\.(log|debug|info|warn|error|dir)\s*\(/.test(line)) {
      report('no-console-in-engine', file, index + 1, 'use the injected logger, which redacts');
    }
  }
}

// ── Rule: no unchecked `any` in the engine core ───────────────────────────
for (const file of [...engineSources, ...hostSources]) {
  for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    if (/:\s*any\b/.test(line) || /\bas any\b/.test(line)) {
      report('no-any', file, index + 1, 'strict typing is the point of the strict config');
    }
  }
}

// ── Rule: no unresolved markers left behind ───────────────────────────────
for (const file of [...engineSources, ...hostSources]) {
  for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    const marker = /\b(TODO|FIXME|XXX|HACK)\b/.exec(line);
    if (marker) report('no-unresolved-markers', file, index + 1, `${marker[1]} left in shipped code`);
  }
}

// ── Rule: configuration is read at the edges, not in the domain ───────────
for (const file of engineSources) {
  if (file.includes(join('src', 'engines', 'deps.ts'))) continue;
  const relativePath = relative(engineRoot, file);
  for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    if (/process\.env/.test(line)) {
      report(
        'no-env-in-core',
        file,
        index + 1,
        `${relativePath} reads the environment; configuration belongs in the composition root`,
      );
    }
  }
}

// ── Rule: the domain layer stays free of infrastructure ───────────────────
const domainFiles = engineSources.filter((file) => file.includes(join('src', 'domain')));
for (const file of domainFiles) {
  for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    if (/from '(pg|next|react)/.test(line) || /adapters\//.test(line)) {
      report('domain-has-no-infrastructure', file, index + 1, 'the domain must not import an adapter or a framework');
    }
  }
}

// ── Rule: no credential-shaped literals ───────────────────────────────────
const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key', /-----BEGIN (RSA |EC )?PRIVATE KEY-----/],
  ['bearer-literal', /\bBearer\s+[A-Za-z0-9._-]{24,}/],
  ['postgres-password', /postgres(ql)?:\/\/[^\s:@]+:[^\s@]{6,}@/],
];
for (const file of [...engineSources, ...hostSources, ...walk(join(engineRoot, 'scripts'), ['.ts'])]) {
  const contents = readFileSync(file, 'utf8');
  for (const [name, pattern] of SECRET_PATTERNS) {
    const match = pattern.exec(contents);
    if (match) {
      const line = contents.slice(0, match.index).split('\n').length;
      report('no-hardcoded-credentials', file, line, `looks like a ${name}`);
    }
  }
}

// ── Rule: public surfaces carry no internal terminology ───────────────────
const BANNED_TERMS: readonly string[] = [
  'Behavioral Signal Graph',
  'Ragers OS',
  'Experience OS',
  'Trust OS',
  'trust-score methodology',
  'growth flywheel',
  'data moat',
  'competitive moat',
  'monetization strategy',
  'behavioral intelligence',
  'anti-brigading',
  'ranking algorithm',
];
const publicSurfaces = [
  ...['index.html', 'app.html', 'styles.css', 'app.css', 'script.js', 'app.js'].map((name) => join(repoRoot, name)),
  ...hostSources,
];
for (const file of publicSurfaces) {
  if (!statSync(file, { throwIfNoEntry: false })) continue;
  const contents = readFileSync(file, 'utf8').toLowerCase();
  for (const term of BANNED_TERMS) {
    if (contents.includes(term.toLowerCase())) {
      report('no-internal-terms-on-public-surfaces', file, 1, `"${term}" must not appear on a public surface`);
    }
  }
}

// ── Rule: every migration is additive-only after 0002 ─────────────────────
const migrations = readdirSync(join(engineRoot, 'supabase', 'migrations')).filter((n) => n.endsWith('.sql')).sort();
for (const name of migrations) {
  const contents = readFileSync(join(engineRoot, 'supabase', 'migrations', name), 'utf8');
  for (const [index, line] of contents.split('\n').entries()) {
    const stripped = line.replace(/--.*$/, '');
    // Dropping a table or column breaks rollback, which relies on migrations
    // being additive so the previous release still runs against the new schema.
    if (/\bdrop\s+(table|column)\b/i.test(stripped)) {
      report('migrations-are-additive', join(engineRoot, 'supabase', 'migrations', name), index + 1,
        'dropping a table or column breaks the additive-migration rollback strategy');
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────
if (findings.length === 0) {
  process.stdout.write(
    `static validation: PASS (${engineSources.length + hostSources.length} source files, ${migrations.length} migrations)\n`,
  );
  process.exit(0);
}

const byRule = new Map<string, Finding[]>();
for (const finding of findings) {
  byRule.set(finding.rule, [...(byRule.get(finding.rule) ?? []), finding]);
}
for (const [rule, items] of byRule) {
  process.stderr.write(`\n${rule} (${items.length}):\n`);
  for (const item of items) process.stderr.write(`  ${item.file}:${item.line} — ${item.detail}\n`);
}
process.stderr.write(`\nstatic validation: FAIL (${findings.length} finding(s))\n`);
process.exit(1);
