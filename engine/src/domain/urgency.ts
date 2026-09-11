import { daysOf, type Aging } from './aging.ts';
import { isAtLeastBand, type SeverityBand } from './severity.ts';

/**
 * Urgency — Phase 41, E8.
 *
 * Phase 32 already delivers the severity engine's core, so this module implements only
 * what was missing, and the reason it is a separate module is the distinction it exists
 * to keep:
 *
 *   **severity** — how bad it was. Asserted by the person it happened to.
 *   **urgency**  — how soon somebody should look. Derived from state and elapsed time.
 *   **priority** — where it sits in a queue relative to everything else (Phase 43).
 *
 * Those are three different questions and they disagree constantly. A minor problem
 * left unanswered for four months is not severe and is urgent. A critical problem
 * already acknowledged and being worked is severe and not urgent. Collapsing any pair
 * of them produces a queue that is confidently wrong.
 *
 * Urgency is **not truth**. It says nothing about whether an account is accurate, and
 * nothing about who is at fault. It is an operational reading of "this has been sitting
 * here", and it carries its reasons so a person can disagree with it.
 */
export type UrgencyLevel = 'routine' | 'soon' | 'prompt' | 'immediate';

export const URGENCY_LEVELS: readonly UrgencyLevel[] = ['routine', 'soon', 'prompt', 'immediate'];

const LEVEL_ORDER: Readonly<Record<UrgencyLevel, number>> = {
  routine: 0,
  soon: 1,
  prompt: 2,
  immediate: 3,
};

export const isAtLeastUrgency = (level: UrgencyLevel, floor: UrgencyLevel): boolean =>
  LEVEL_ORDER[level] >= LEVEL_ORDER[floor];

/** Named so a reason reads as a sentence rather than a slug. */
export type UrgencyFactorId =
  | 'safety_asserted'
  | 'severity_high'
  | 'unanswered'
  | 'aging_unresolved'
  | 'proposed_fix_unconfirmed'
  | 'escalated'
  | 'contested'
  | 'recent_and_unseen'
  | 'being_worked';

export interface UrgencyFactor {
  readonly id: UrgencyFactorId;
  /** In the words a person reads. Never a slug, never a number on its own. */
  readonly because: string;
  /** Which way it pushed. A factor that lowers urgency is stated too. */
  readonly direction: 'raises' | 'lowers';
}

export interface Urgency {
  readonly level: UrgencyLevel;
  readonly factors: readonly UrgencyFactor[];
  /**
   * True when there was nothing to read. An experience with no severity assessment,
   * no escalation and no elapsed time is `routine` because a level is required —
   * `unassessed` is what stops that reading as "somebody checked and it is fine".
   */
  readonly unassessed: boolean;
}

export interface UrgencyInputs {
  /** From Phase 32. `undefined` when nothing was asserted. */
  readonly band?: SeverityBand | undefined;
  readonly severityUnassessed: boolean;
  /** Whether safety was among the asserted dimensions. */
  readonly safetyAsserted: boolean;
  readonly aging: Aging;
  /** Open escalations. Their existence raises urgency; their reasons are Phase 34's. */
  readonly openEscalations: number;
  readonly contested: boolean;
  /** Whether the organization has acknowledged or is actively working it. */
  readonly acknowledged: boolean;
  readonly beingWorked: boolean;
}

const DAYS_RECENT = 2;
const DAYS_AGING = 14;
const DAYS_LONG = 45;
const DAYS_PROPOSED_UNCONFIRMED = 21;

const highest = (levels: readonly UrgencyLevel[]): UrgencyLevel =>
  levels.reduce<UrgencyLevel>((best, level) => (LEVEL_ORDER[level] > LEVEL_ORDER[best] ? level : best), 'routine');

/**
 * Derive urgency.
 *
 * The highest raising factor wins, then a single lowering factor can step it down by
 * one — never to `routine` from `immediate`, and never below what safety asserts.
 *
 * A maximum rather than a weighted sum, for the same reason severity uses one: an
 * average lets a long list of small factors outvote one serious one, and "several
 * things are slightly stale" should never outrank "somebody said this was a safety
 * problem and nobody has replied".
 */
export const urgencyOf = (inputs: UrgencyInputs): Urgency => {
  const factors: UrgencyFactor[] = [];
  const raising: UrgencyLevel[] = [];

  const raise = (level: UrgencyLevel, id: UrgencyFactorId, because: string): void => {
    raising.push(level);
    factors.push({ id, because, direction: 'raises' });
  };

  // Safety, on its own scale and never reducible. Read from what the person asserted,
  // not from severity's band — the band could be critical for a purely financial
  // reason, and that is a different kind of soon.
  if (inputs.safetyAsserted) {
    raise('immediate', 'safety_asserted', 'somebody said safety was involved');
  }

  const assessed = !inputs.severityUnassessed && inputs.band !== undefined;
  if (assessed && isAtLeastBand(inputs.band, 'serious')) {
    raise(
      inputs.band === 'critical' ? 'prompt' : 'soon',
      'severity_high',
      `what it cost was reported as ${inputs.band}`,
    );
  }

  const unresolvedDays = daysOf(inputs.aging.inCurrentStatusMs);
  const noContact = inputs.aging.sinceOrganizationContactMs === undefined;

  if (noContact && inputs.aging.unresolved) {
    // Silence, aged. Still not read as refusal — only as elapsed time.
    const ageDays = daysOf(inputs.aging.ageMs);
    if (ageDays >= DAYS_LONG) {
      raise('prompt', 'unanswered', `no reply in ${ageDays} days`);
    } else if (ageDays >= DAYS_AGING) {
      raise('soon', 'unanswered', `no reply in ${ageDays} days`);
    }
  }

  if (inputs.aging.unresolved && unresolvedDays >= DAYS_LONG) {
    raise('prompt', 'aging_unresolved', `unresolved for ${unresolvedDays} days`);
  } else if (inputs.aging.unresolved && unresolvedDays >= DAYS_AGING) {
    raise('soon', 'aging_unresolved', `unresolved for ${unresolvedDays} days`);
  }

  const proposedDays =
    inputs.aging.proposedUnconfirmedMs === undefined ? undefined : daysOf(inputs.aging.proposedUnconfirmedMs);
  if (proposedDays !== undefined && proposedDays >= DAYS_PROPOSED_UNCONFIRMED) {
    raise('soon', 'proposed_fix_unconfirmed', `a described fix has gone unconfirmed for ${proposedDays} days`);
  }

  if (inputs.openEscalations > 0) {
    raise(
      'prompt',
      'escalated',
      inputs.openEscalations === 1 ? 'an escalation is open' : `${inputs.openEscalations} escalations are open`,
    );
  }

  if (inputs.contested) {
    raise('soon', 'contested', 'the accounts differ and nobody has reviewed it');
  }

  // Recency is deliberately weak, and deliberately present. A brand-new account nobody
  // has seen is worth a look, but "posted an hour ago" is not an emergency — that is
  // what the `soon` ceiling here is for.
  if (!inputs.acknowledged && daysOf(inputs.aging.ageMs) < DAYS_RECENT && inputs.aging.unresolved) {
    raise('soon', 'recent_and_unseen', 'posted recently and nobody has looked at it');
  }

  const base = highest(raising);

  // The one lowering factor. Somebody is on it, so it does not need chasing — but it
  // is stated rather than silently applied, and it cannot cancel safety.
  let level = base;
  if (inputs.beingWorked && !inputs.safetyAsserted && LEVEL_ORDER[base] > 0) {
    level = URGENCY_LEVELS[LEVEL_ORDER[base] - 1] ?? base;
    factors.push({
      id: 'being_worked',
      because: 'the organization is working on it',
      direction: 'lowers',
    });
  }

  return {
    level,
    factors,
    // Nothing raised it and nothing lowered it: there was nothing to read.
    unassessed: raising.length === 0,
  };
};

export const URGENCY_LABELS: Readonly<Record<UrgencyLevel, string>> = {
  routine: 'No rush',
  soon: 'Worth a look',
  prompt: 'Needs attention',
  immediate: 'Needs attention now',
};

/**
 * Urgency is not severity, stated as code so a test can pin it.
 *
 * Exists because the two are the most tempting pair to collapse — they are both
 * "how bad is this" to a tired reader — and the collapse is invisible until a queue
 * starts putting stale annoyances above fresh dangers.
 */
export const urgencyIsNotSeverity = (): true => true;
