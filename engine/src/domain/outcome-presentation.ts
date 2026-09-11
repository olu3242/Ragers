import type { ResolutionStatus } from './resolution.ts';

/**
 * The five things a viewer must never confuse, derived from real state.
 *
 * The product rule is that these are visibly distinct:
 *
 *   response · proposed resolution · resolved · disputed · unresolved
 *
 * They are not five values of one column, and inventing a column for them would
 * be redefining a contract this layer does not own. They are derived instead:
 *
 *   * **response** — an organization has said something. Any response at all.
 *   * **proposed resolution** — an organization has described a fix
 *     (`publish_resolution`) and the people it happened to have not confirmed it.
 *     This is the state most easily misread as "resolved", and it is the reason
 *     this derivation exists at all.
 *   * **resolved** — everyone who claims the experience says it was fixed for
 *     them. Only they can put it here.
 *   * **disputed** — the accounts disagree. A statement that they differ, not a
 *     finding about who is right.
 *   * **unresolved** — everything else, including "nobody has said yet", which is
 *     distinguished below so silence is not read as a verdict.
 */
export type OutcomePresentation =
  | 'unresolved_unreported'
  | 'unresolved_reported'
  | 'response_only'
  | 'proposed_resolution'
  | 'partially_resolved'
  | 'resolved'
  | 'disputed';

export interface OutcomeInputs {
  readonly status: ResolutionStatus;
  /** Any organization response exists. */
  readonly hasResponse: boolean;
  /** An organization has described a fix, whatever the outcome axis says. */
  readonly hasProposedResolution: boolean;
  /** How many people who claim the experience have reported an outcome. */
  readonly reporters: number;
}

export const presentOutcome = (inputs: OutcomeInputs): OutcomePresentation => {
  // The experiencers' verdict outranks everything an organization said.
  if (inputs.status === 'resolved') return 'resolved';
  if (inputs.status === 'partially_resolved') return 'partially_resolved';
  if (inputs.status === 'disputed') return 'disputed';

  // An organization's described fix that nobody has confirmed is a *proposal*.
  // Showing this as "resolved" is the single most consequential misreading this
  // product can permit, so it has its own state and its own words.
  if (inputs.hasProposedResolution && inputs.reporters === 0) return 'proposed_resolution';

  if (inputs.hasResponse && inputs.reporters === 0) return 'response_only';
  if (inputs.reporters > 0) return 'unresolved_reported';
  return 'unresolved_unreported';
};

export interface OutcomeCopy {
  readonly badge: string;
  readonly explanation: string;
  /** True when the badge could be mistaken for a resolution and must say so. */
  readonly clarifies: boolean;
}

/**
 * Plain consumer language. No internal vocabulary, and nothing that dresses a
 * volume of engagement as a finding of fact.
 */
export const OUTCOME_COPY: Readonly<Record<OutcomePresentation, OutcomeCopy>> = {
  unresolved_unreported: {
    badge: 'Unresolved',
    explanation: 'Nobody has said whether this was resolved.',
    clarifies: false,
  },
  unresolved_reported: {
    badge: 'Unresolved',
    explanation: 'The people this happened to say it is still unresolved.',
    clarifies: false,
  },
  response_only: {
    badge: 'Responded',
    explanation: 'The organization has responded. That is their account, not a resolution.',
    clarifies: true,
  },
  proposed_resolution: {
    badge: 'Resolution proposed',
    explanation:
      'The organization says this was fixed. The people it happened to have not confirmed that yet.',
    clarifies: true,
  },
  partially_resolved: {
    badge: 'Partly resolved',
    explanation: 'Some of the people this happened to say it was resolved for them, and some do not.',
    clarifies: false,
  },
  resolved: {
    badge: 'Resolved',
    explanation: 'Everyone who said this happened to them reports it was resolved.',
    clarifies: false,
  },
  disputed: {
    badge: 'Disputed',
    explanation: 'The organization disputes this account. Both accounts stand.',
    clarifies: true,
  },
};

/** Response kinds that amount to describing a fix. */
export const PROPOSAL_RESPONSE_KINDS: readonly string[] = ['publish_resolution', 'remediation_instructions'];
