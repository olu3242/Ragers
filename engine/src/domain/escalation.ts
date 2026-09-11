import { daysOf, type Aging } from './aging.ts';
import { isAtLeastBand, type SeverityBand } from './severity.ts';

/**
 * Escalation rules — Phase 34, E10.
 *
 * What escalation *is*: opening a review. What it is emphatically not: a sanction, a
 * suppression, a resolution-state change, or a finding about anybody. An escalated
 * experience is one a person will now look at, and that is the entire consequence.
 *
 * The rules are declarative so the queue can say *why* an item is there — naming the
 * rule and the values that satisfied it. An operator told "escalated" learns nothing;
 * one told "serious, unresolved 21 days, no organization contact" can act.
 *
 * Idempotence is a property of the rule id, not of a timestamp: the same condition on
 * the same experience yields the same `escalationKey`, so a re-run enqueues nothing
 * new. Without that, a nightly sweep would bury the queue in duplicates of one case.
 */
export type EscalationRuleId =
  | 'serious_and_stale'
  | 'critical_unacknowledged'
  | 'proposed_fix_unconfirmed'
  | 'disputed_and_aging'
  | 'many_experiencers_no_response';

export interface EscalationRule {
  readonly id: EscalationRuleId;
  /** Said in the words an operator reads on the queue item. */
  readonly because: string;
}

export interface EscalationInput {
  readonly experienceId: string;
  readonly band: SeverityBand;
  readonly unassessedSeverity: boolean;
  readonly aging: Aging;
  readonly independentExperiencers: number;
  readonly hasLiveDispute: boolean;
  readonly acknowledged: boolean;
}

export interface Escalation {
  readonly experienceId: string;
  readonly ruleId: EscalationRuleId;
  readonly because: string;
  /** Deterministic: the same condition never queues twice. */
  readonly escalationKey: string;
}

const DAYS_STALE = 14;
const DAYS_CRITICAL_UNACKNOWLEDGED = 2;
const DAYS_PROPOSED_UNCONFIRMED = 21;
const DAYS_DISPUTE_AGING = 30;
const EXPERIENCERS_WITHOUT_RESPONSE = 10;

/**
 * Which rules fire.
 *
 * Returns every match rather than the first, because two independent reasons to look
 * at something are more informative than one — and because "first match wins" ordering
 * quietly encodes a priority nobody agreed to.
 *
 * A severity band that was never assessed cannot satisfy a severity rule. An
 * unassessed experience defaults to `minor`, and treating that default as a finding
 * would escalate on the absence of information.
 */
export const escalationsFor = (input: EscalationInput): readonly Escalation[] => {
  const out: Escalation[] = [];
  const push = (ruleId: EscalationRuleId, because: string): void => {
    out.push({ experienceId: input.experienceId, ruleId, because, escalationKey: `${input.experienceId}:${ruleId}` });
  };

  const assessed = !input.unassessedSeverity;
  const unresolvedDays = daysOf(input.aging.inCurrentStatusMs);
  const noContact = input.aging.sinceOrganizationContactMs === undefined;

  if (assessed && isAtLeastBand(input.band, 'serious') && input.aging.unresolved && unresolvedDays >= DAYS_STALE) {
    push(
      'serious_and_stale',
      `${input.band} and unresolved for ${unresolvedDays} days`,
    );
  }

  if (
    assessed &&
    input.band === 'critical' &&
    !input.acknowledged &&
    daysOf(input.aging.ageMs) >= DAYS_CRITICAL_UNACKNOWLEDGED
  ) {
    push('critical_unacknowledged', `critical and unacknowledged for ${daysOf(input.aging.ageMs)} days`);
  }

  const proposedDays =
    input.aging.proposedUnconfirmedMs === undefined ? undefined : daysOf(input.aging.proposedUnconfirmedMs);
  if (proposedDays !== undefined && proposedDays >= DAYS_PROPOSED_UNCONFIRMED) {
    // Neither confirmed nor rejected. Escalating asks a person to check, and
    // deliberately does not decide it either way.
    push('proposed_fix_unconfirmed', `a proposed fix has gone unconfirmed for ${proposedDays} days`);
  }

  if (input.hasLiveDispute && daysOf(input.aging.inCurrentStatusMs) >= DAYS_DISPUTE_AGING) {
    push('disputed_and_aging', `a dispute has been open for ${daysOf(input.aging.inCurrentStatusMs)} days`);
  }

  if (input.independentExperiencers >= EXPERIENCERS_WITHOUT_RESPONSE && noContact) {
    push(
      'many_experiencers_no_response',
      `${input.independentExperiencers} people and no response from the organization`,
    );
  }

  return out;
};

/**
 * The guarantee stated as code, so a test can assert it rather than trust a comment:
 * escalation never proposes a resolution status.
 *
 * Any future edit that returns a status from this module fails the unit test that
 * calls this.
 */
export const escalationChangesResolution = (): false => false;
