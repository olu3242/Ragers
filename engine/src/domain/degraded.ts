import type { DependencyHealth, HealthReport, HealthState } from '../runtime/health.ts';

/**
 * Phase 67 — degraded mode and backpressure.
 *
 * Every fail-closed path in this system already refuses correctly on its own. Media that
 * cannot be protected is not published. A transcript that cannot be redacted is not
 * shown. A command whose store is unreachable fails rather than half-writing. None of
 * that changes here, and the tests assert it does not.
 *
 * What is missing is the *shape*. Three independent correct refusals, arriving at three
 * different surfaces with three different messages, look like three unrelated bugs — so
 * the first thing anybody does during an incident is investigate them separately, which
 * is the worst possible use of the first ten minutes. There is no single place that says
 * "the database is unreachable, and here is the list of things that are consequently
 * being refused".
 *
 * This module is that place, and it is deliberately the thinnest possible thing:
 *
 * **Derived, never asserted.** There is no `system.setDegraded` command and no stored
 * flag. Degraded mode is a *reading* of the health registry, computed on demand. A stored
 * flag would need somebody to set it — which means somebody to forget to clear it, and a
 * system reporting degraded for a week after it recovered is a system nobody believes.
 * The absence is assertable: `degradedModeAcceptsACommand()` returns false.
 *
 * **It changes no refusal.** Nothing downstream reads this to decide anything. If it did,
 * an unavailable dependency would start causing refusals *in addition to* the ones it
 * already causes, and a bug in this module would become an outage. It is a lens, not a
 * gate — and the way to keep that true is for nothing in `src/engines` to import it.
 *
 * **Consequences are stated, not guessed.** A dependency's entry names what is refused
 * while it is down, in plain operator language. That mapping is the actual content of
 * this phase, and it is enforced by discovery: every health check registered in
 * `src/engine.ts` must have an entry here, so a dependency added later without stated
 * consequences fails the guard rather than silently reporting nothing.
 */

/**
 * What is refused while a given dependency is unavailable.
 *
 * Written for the person reading it at 03:00, not for a machine. Each entry answers one
 * question — "what will users be seeing?" — because that is what determines whether the
 * incident needs a status page or just a retry.
 */
export interface DependencyConsequences {
  /** One line an operator reads first. Always present, even when nothing is refused. */
  readonly summary: string;
  /**
   * What stops working, in the terms a user would describe it.
   *
   * **Empty when nothing is refused, and that is load-bearing.** The first version put
   * the string "Nothing is refused" in here, which meant a list named `refusing` had an
   * entry in it while nothing was being refused — an operator scanning the report would
   * read a line and conclude something was down. A list of refusals contains refusals;
   * the fact that there are none belongs in `summary`, where it reads as an answer rather
   * than as an item.
   */
  readonly refuses: readonly string[];
  /** What keeps working, which is the half of the answer people forget to state. */
  readonly unaffected: readonly string[];
}

/**
 * The map. Keys are the health-check names registered by the composition root.
 *
 * `unaffected` is not padding. During an incident the expensive mistake is assuming
 * everything is down and telling everybody so; naming what still works is what keeps the
 * response proportionate.
 */
export const DEPENDENCY_CONSEQUENCES: Readonly<Record<string, DependencyConsequences>> = {
  database: {
    summary: 'Writes and uncached reads are being refused. This is a user-visible outage.',
    refuses: [
      'Every write: posting, corroborating, replying, reporting and moderating all fail rather than half-completing.',
      'Every read that is not already cached, including the feed and any experience page.',
    ],
    unaffected: [
      'Nothing is lost. No partial write is possible, because a command that cannot reach its store never reaches its outbox either.',
    ],
  },
  outbox: {
    summary: 'Nothing is refused. Everything downstream of an event is behind and catching up.',
    refuses: [],
    unaffected: [
      'Posting, corroborating and moderating all work.',
      'Everything downstream of an event — the feed, search, notifications, signals — is behind rather than broken, and catches up on its own once the backlog drains.',
    ],
  },
  dead_letters: {
    summary: 'Nothing is refused. There is work that already failed its retries and needs a person.',
    refuses: [],
    unaffected: [
      'Every live path. This is a queue of things to look at, not a dependency anything waits on.',
    ],
  },
};

/**
 * How bad the whole thing is, and what it means.
 *
 * Three values rather than a boolean, because "some things are slow" and "writes are
 * failing" call for completely different responses and collapsing them loses the
 * distinction an operator most needs.
 */
export type DegradedLevel =
  /** Everything is healthy. */
  | 'nominal'
  /** Something is behind or accumulating, and nothing is being refused because of it. */
  | 'degraded'
  /** Something a request path depends on is unavailable, so requests are being refused. */
  | 'impaired';

export interface DegradedDependency {
  readonly name: string;
  readonly state: HealthState;
  readonly detail?: string;
  readonly consequences: DependencyConsequences;
}

export interface DegradedStateReport {
  readonly level: DegradedLevel;
  /** Only the dependencies that are not healthy. A nominal report lists nothing. */
  readonly affected: readonly DegradedDependency[];
  /**
   * Every distinct thing actually being refused, across the affected dependencies.
   *
   * Empty at level `degraded`, which is the useful reading: things are behind and nothing
   * is being turned away. Deduplicated, so two failures with one effect read as one effect.
   */
  readonly refusing: readonly string[];
  readonly checkedAt: string;
}

/**
 * The consequences of a dependency nobody stated any for.
 *
 * Not an empty entry: an unmapped dependency has to be *visible* as unmapped, or a
 * health check added without consequences reports "nothing is refused" — which is a
 * confident wrong answer, the worst kind during an incident. The discovery guard exists
 * so this never appears in a real report; it is here so that if it somehow does, it reads
 * as a gap rather than as reassurance.
 */
export const UNMAPPED_CONSEQUENCES: DependencyConsequences = {
  summary: 'Unknown — nobody stated what this dependency breaks. Treat its effects as unbounded.',
  refuses: ['Unknown — this dependency has no stated consequences. Treat its effects as unbounded until somebody checks.'],
  unaffected: [],
};

/** `unhealthy` means a request path is broken; `degraded` means something is behind. */
const levelOf = (states: readonly HealthState[]): DegradedLevel => {
  if (states.includes('unhealthy')) return 'impaired';
  if (states.includes('degraded')) return 'degraded';
  return 'nominal';
};

/**
 * The whole state, as a pure function of a health report.
 *
 * Pure so it is testable against a fabricated report rather than by breaking a real
 * database — which matters, because the case that has to be right is the one nobody can
 * conveniently reproduce.
 */
export const degradedStateFrom = (
  report: HealthReport,
  /**
   * Phase 94. An operator has declared degraded mode, whatever the dependencies say.
   *
   * The reading changes and **no refusal does** — the same rule this module has held since
   * Phase 67. An operator forcing degraded mode is telling the team something the health checks
   * cannot see ("the model provider is answering but its answers are wrong"), and the honest
   * response is to report it, not to start refusing things nobody asked to have refused.
   */
  forced = false,
): DegradedStateReport => {
  const affected: DegradedDependency[] = [];
  for (const dependency of report.dependencies) {
    if (dependency.state === 'healthy') continue;
    affected.push({
      name: dependency.name,
      state: dependency.state,
      ...(dependency.detail === undefined ? {} : { detail: dependency.detail }),
      consequences: DEPENDENCY_CONSEQUENCES[dependency.name] ?? UNMAPPED_CONSEQUENCES,
    });
  }

  // Deduplicated across dependencies: two failures with the same consequence should read
  // as one thing being refused, not two.
  const refusing = [...new Set(affected.flatMap((dependency) => dependency.consequences.refuses))];

  const observed = levelOf(affected.map((dependency) => dependency.state));
  return {
    // Forced never *lowers* the reading: a declared degraded state over an actually-impaired
    // system must still read `impaired`, because the operator's declaration is extra information
    // rather than a replacement for what the checks found.
    level: forced && observed === 'nominal' ? 'degraded' : observed,
    affected,
    refusing,
    checkedAt: report.checkedAt,
  };
};

/** One line for a log or an operator header. Empty when nominal, so it prints nothing. */
export const degradedSummary = (state: DegradedStateReport): string =>
  state.level === 'nominal'
    ? ''
    : `${state.level}: ${state.affected.map((d) => `${d.name} (${d.state})`).join(', ')}`;

/**
 * The absences, as code.
 *
 * `degradedModeAcceptsACommand` — a stored flag needs somebody to set it, which means
 * somebody to forget to clear it. `degradedModeChangesARefusal` — nothing reads this to
 * decide anything, so a bug here cannot become an outage. Both are asserted rather than
 * trusted to review, and the test that calls them is where a future edit has to argue.
 */
export const degradedModeAcceptsACommand = (): false => false;
export const degradedModeChangesARefusal = (): false => false;

/** A dependency's health as this module sees it, for a surface that shows the full list. */
export const dependencyLine = (dependency: DependencyHealth): string =>
  `${dependency.name}: ${dependency.state}${dependency.detail === undefined ? '' : ` — ${dependency.detail}`}`;
