/**
 * Certification evidence — what a gate leaves behind.
 *
 * This module exists because of a real gap, found the honest way. An intermittent
 * failure in `Durable orchestration and restart recovery` turned the certification
 * job red, and the evidence the harness had kept was the string
 * `10/11 assertions passed, 1 failed`. That is enough to know something broke and not
 * enough to know *what*, so answering the question cost a blind CI re-run — and a
 * re-run that passes tells you nothing about what failed the first time.
 *
 * So a gate now records which subtest failed, what it asserted, where, and a bounded
 * excerpt of the surrounding output. Three constraints shape it:
 *
 * **Bounded, not unlimited.** The ledger is evidence, not a log. An excerpt long
 * enough to diagnose a failure is short enough to read; a whole test run pasted into
 * a committed artefact is neither.
 *
 * **Redacted by shape, never by vocabulary.** A connection string with a password in
 * it is redacted. A test named *"a short secret is a signature anybody can forge"* is
 * not, because redacting the word `secret` would destroy exactly the names this
 * module was built to preserve. The patterns below match credential *shapes*.
 *
 * **Total.** Every parser here takes arbitrary bytes and returns something. A runner
 * that crashes, prints nothing, or prints something unrecognisable must not take
 * certification down with it — the gate still fails, and the evidence says what
 * little there was.
 */

/** How much of a gate's output survives into the ledger. */
export const MAX_FAILURES_RETAINED = 5;
export const MAX_EXCERPT_CHARS = 2_000;
export const MAX_ASSERTION_CHARS = 400;
export const MAX_TEST_NAME_CHARS = 200;

/** One failing test, named. */
export interface FailureSummary {
  /** The subtest name, as the runner reported it. */
  readonly test: string;
  /** The assertion or error message, trimmed to a readable length. */
  readonly assertion?: string;
  /** `file:line:column`, where the runner gave one. */
  readonly location?: string;
}

/** What a gate's runner actually did. */
export interface RunnerOutcome {
  readonly command: readonly string[];
  /** `null` when the process was killed by a signal rather than exiting. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

/** Counts, where the runner reported them. Absent rather than zero when it did not. */
export interface GateCounts {
  readonly tests?: number;
  readonly passed?: number;
  readonly failed?: number;
}

export interface GateEvidence {
  /** The one-line summary. Unchanged in shape from before, so the ledger still reads the same. */
  readonly detail: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly counts: GateCounts;
  /** Empty for a passing gate. Never a count standing in for a name. */
  readonly failureSummary: readonly FailureSummary[];
  /** Bounded, redacted output. Absent for a passing gate — a pass needs no excerpt. */
  readonly evidenceExcerpt?: string;
  /** How many failures were found beyond those retained. */
  readonly failuresOmitted?: number;
}

// ── Redaction ─────────────────────────────────────────────────────────────

/**
 * Credential shapes, in the order they are applied.
 *
 * Each is a *shape*, not a word. The one thing this must never do is redact a test
 * name or an assertion, because those are the evidence — so there is no rule here
 * that fires on `secret`, `token` or `key` appearing in prose.
 */
const REDACTIONS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  // A URI with credentials in it. The scheme and host survive so a reader can still
  // tell which dependency was involved.
  {
    pattern: /\b([a-z][a-z0-9+.-]*):\/\/([^\s:/@]+):([^\s@]+)@/gi,
    replacement: '$1://$2:[REDACTED]@',
  },
  // A postgres URL without a password still names a database and a host; that is
  // useful and not a credential, so only the userinfo form above is touched.
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, replacement: 'Bearer [REDACTED]' },
  // Provider token shapes, which are unmistakable and never test names.
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replacement: '[REDACTED_TOKEN]' },
  { pattern: /\bsk-[A-Za-z0-9]{16,}\b/g, replacement: '[REDACTED_TOKEN]' },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: '[REDACTED_JWT]' },
  // `NAME=value` where the name is credential-shaped and the value is substantial.
  // Anchored on the assignment, so a sentence mentioning a token is untouched.
  {
    pattern:
      /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|ACCESS_KEY|SERVICE_ROLE|DSN|DATABASE_URL)[A-Z0-9_]*)\s*[=:]\s*("?)([^\s"',;]{6,})\2/g,
    replacement: '$1=[REDACTED]',
  },
];

/** Strip credential-shaped values, leaving everything else exactly as it was. */
export const redact = (text: string): string => {
  let out = text;
  for (const { pattern, replacement } of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
};

const clamp = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}… [truncated]`;

/** A single line, collapsed and bounded. Used for names and assertions. */
const oneLine = (text: string, max: number): string =>
  clamp(text.replace(/\s+/g, ' ').trim(), max);

// ── TAP (node:test) ───────────────────────────────────────────────────────

/**
 * A `not ok` line plus the YAML block under it.
 *
 * Written as a small hand-rolled scanner rather than with a YAML parser, because the
 * input is not trustworthy YAML: it is whatever the runner printed, possibly cut off
 * mid-block by a crash or a buffer limit. A scanner degrades to "found the name, no
 * assertion"; a parser throws.
 */
const parseTapFailures = (output: string): readonly FailureSummary[] => {
  const lines = output.split('\n');
  const failures: FailureSummary[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const header = /^(\s*)not ok \d+\s*-?\s*(.*)$/.exec(line);
    if (!header) continue;

    const name = (header[2] ?? '').trim();
    if (name.length === 0) continue;

    let assertion: string | undefined;
    let location: string | undefined;
    let stack: string | undefined;

    // Walk the block under this line. It ends at the next `not ok`/`ok` at the same
    // or lower indent, or at end of output — never assumed to be well-formed.
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const body = lines[cursor] as string;
      if (/^\s*(not ok|ok) \d+/.test(body)) break;
      if (/^\s*# (Subtest|tests|pass|fail)/.test(body)) break;

      const scalar = /^\s*error:\s*'(.*)'\s*$/.exec(body) ?? /^\s*error:\s*"(.*)"\s*$/.exec(body);
      if (scalar && assertion === undefined) {
        assertion = scalar[1];
        continue;
      }
      if (/^\s*error:\s*\|-?\s*$/.test(body) && assertion === undefined) {
        // A block scalar: take the indented lines that follow it.
        const collected: string[] = [];
        const blockIndent = (/^(\s*)/.exec(lines[cursor + 1] ?? '')?.[1] ?? '').length;
        for (let inner = cursor + 1; inner < lines.length; inner += 1) {
          const item = lines[inner] as string;
          const indent = (/^(\s*)/.exec(item)?.[1] ?? '').length;
          if (item.trim().length > 0 && indent < blockIndent) break;
          if (/^\s*(code|name|stack|expected|actual|operator|failureType):/.test(item)) break;
          collected.push(item.trim());
          if (collected.length >= 12) break;
        }
        assertion = collected.filter((entry) => entry.length > 0).join(' / ');
        continue;
      }
      const at = /^\s*location:\s*'(.*)'\s*$/.exec(body);
      if (at && location === undefined) {
        location = at[1];
        continue;
      }
      if (/^\s*stack:\s*\|-?\s*$/.test(body) && stack === undefined) {
        const frame = (lines[cursor + 1] ?? '').trim();
        if (frame.length > 0) stack = frame;
      }
    }

    failures.push({
      test: oneLine(name, MAX_TEST_NAME_CHARS),
      ...(assertion === undefined || assertion.length === 0
        ? {}
        : { assertion: oneLine(assertion, MAX_ASSERTION_CHARS) }),
      ...(location === undefined || location.length === 0
        ? stack === undefined
          ? {}
          : { location: oneLine(stack, MAX_TEST_NAME_CHARS) }
        : { location: oneLine(location, MAX_TEST_NAME_CHARS) }),
    });
  }

  return failures;
};

/**
 * A suite's own `not ok` says only "1 subtest failed" — true, and useless on its own.
 *
 * Ranked below the child failures rather than dropped, so a run where the parser
 * found *only* the suite line still reports something rather than nothing.
 */
const isAggregateOnly = (failure: FailureSummary): boolean =>
  /^\d+ subtests? failed$/i.test(failure.assertion ?? '');

// ── Playwright ────────────────────────────────────────────────────────────

const parsePlaywrightFailures = (output: string): readonly FailureSummary[] => {
  const lines = output.split('\n');
  const failures: FailureSummary[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^\s*\d+\)\s+(.+?)\s*[─-]*\s*$/.exec(lines[index] as string);
    if (!header) continue;
    const name = (header[1] ?? '').trim();
    if (name.length === 0) continue;

    let assertion: string | undefined;
    for (let cursor = index + 1; cursor < Math.min(index + 12, lines.length); cursor += 1) {
      const body = (lines[cursor] as string).trim();
      if (/^(Error|AssertionError|TimeoutError|expect\()/.test(body)) {
        assertion = body;
        break;
      }
    }
    failures.push({
      test: oneLine(name, MAX_TEST_NAME_CHARS),
      ...(assertion === undefined ? {} : { assertion: oneLine(assertion, MAX_ASSERTION_CHARS) }),
    });
  }
  return failures;
};

// ── The excerpt ───────────────────────────────────────────────────────────

/**
 * The output worth keeping when a gate fails.
 *
 * Prefers the region around the first failure, because that is where the diagnosis
 * is, and falls back to the tail — a process that died before printing a failure
 * leaves its reason at the end.
 */
export const excerptOf = (output: string): string => {
  const cleaned = redact(output.replace(/\r/g, ''));
  if (cleaned.trim().length === 0) return '';

  const lines = cleaned.split('\n');
  const firstFailure = lines.findIndex((line) => /^\s*not ok \d+|^\s*\d+\)\s|Error:|error:/.test(line));
  if (firstFailure === -1) {
    return clamp(lines.slice(-25).join('\n').trim(), MAX_EXCERPT_CHARS);
  }
  const from = Math.max(0, firstFailure - 3);
  return clamp(lines.slice(from, from + 40).join('\n').trim(), MAX_EXCERPT_CHARS);
};

// ── Assembly ──────────────────────────────────────────────────────────────

const number = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Counts from whichever runner produced them. */
export const countsOf = (output: string): GateCounts => {
  const tests = number(/^# tests (\d+)$/m.exec(output)?.[1]);
  const passed = number(/^# pass (\d+)$/m.exec(output)?.[1]);
  const failed = number(/^# fail (\d+)$/m.exec(output)?.[1]);
  if (tests !== undefined || passed !== undefined || failed !== undefined) {
    return {
      ...(tests === undefined ? {} : { tests }),
      ...(passed === undefined ? {} : { passed }),
      ...(failed === undefined ? {} : { failed }),
    };
  }
  // Playwright reports differently, and reports failures first when there are any.
  const browserPassed = number(/(\d+) passed/.exec(output)?.[1]);
  const browserFailed = number(/(\d+) failed/.exec(output)?.[1]);
  return {
    ...(browserPassed === undefined ? {} : { passed: browserPassed }),
    ...(browserFailed === undefined ? {} : { failed: browserFailed }),
  };
};

/** Every failing test the output names, most specific first, bounded. */
export const failuresOf = (output: string): readonly FailureSummary[] => {
  const found = [...parseTapFailures(output), ...parsePlaywrightFailures(output)];
  const specific = found.filter((failure) => !isAggregateOnly(failure));
  return specific.length > 0 ? specific : found;
};

/**
 * Everything a gate leaves behind, from what its runner actually did.
 *
 * A passing gate gets counts and a one-line detail and nothing else: keeping an
 * excerpt of a successful run would bury the failures this module exists to surface.
 */
export const evidenceFor = (outcome: RunnerOutcome): GateEvidence => {
  const combined = `${outcome.stdout}${outcome.stderr}`;
  const passed = outcome.exitCode === 0;
  const counts = countsOf(combined);
  const command = redact(outcome.command.join(' '));
  const seconds = `(${(outcome.durationMs / 1000).toFixed(1)}s)`;

  if (passed) {
    const detail =
      counts.tests !== undefined && counts.passed !== undefined
        ? `${counts.passed}/${counts.tests} assertions passed`
        : counts.passed !== undefined
          ? `${counts.passed} browser test(s) passed`
          : 'clean';
    return { detail: `${detail} ${seconds}`, command, exitCode: outcome.exitCode, counts, failureSummary: [] };
  }

  const found = failuresOf(combined);
  const retained = found.slice(0, MAX_FAILURES_RETAINED);
  const omitted = found.length - retained.length;

  // The one-line detail names the first failing test rather than only a count, which
  // is the whole point: a reader of the ledger should not need the excerpt to know
  // *which* thing broke.
  const first = retained[0];
  const counted =
    counts.tests !== undefined && counts.passed !== undefined
      ? `${counts.passed}/${counts.tests} assertions passed`
      : `exited ${outcome.exitCode === null ? 'on a signal' : outcome.exitCode}`;
  const failedPart = counts.failed !== undefined && counts.failed > 0 ? `, ${counts.failed} failed` : '';
  const named = first === undefined ? '' : ` — first failure: ${first.test}`;

  return {
    detail: `${counted}${failedPart}${named} ${seconds}`,
    command,
    exitCode: outcome.exitCode,
    counts,
    failureSummary: retained,
    ...(omitted > 0 ? { failuresOmitted: omitted } : {}),
    ...(excerptOf(combined).length === 0 ? {} : { evidenceExcerpt: excerptOf(combined) }),
  };
};
