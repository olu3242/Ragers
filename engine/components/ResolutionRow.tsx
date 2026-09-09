'use client';

import { useState } from 'react';
import {
  OUTCOME_COPY,
  presentOutcome,
  type OutcomePresentation,
} from '../src/domain/outcome-presentation.ts';

/**
 * The outcome, reported by the people it happened to.
 *
 * Two things this component is careful about. It shows an organization's response
 * and the outcome as *separate* facts, because a company answering is not the same
 * as anything being fixed. And it offers the report control only to people who
 * claim the experience — everyone else sees the tally, which is a count and never
 * a list of names.
 */
export interface ResolutionState {
  readonly status: string;
  readonly reporters: number;
  readonly resolvedShare: number;
  readonly partial: number;
  readonly unresolved: number;
  readonly organizationResponded: boolean;
  readonly resolutionProposed: boolean;
  readonly presentation: OutcomePresentation;
}

/**
 * What a person can say about their own outcome.
 *
 * Framed as a review when the organization has proposed a fix, and as a plain
 * report otherwise — the same three engine values either way, because a person
 * accepting a proposed fix and a person saying it was resolved are the same
 * statement, and inventing a fourth state for the difference would be redefining a
 * contract this layer does not own.
 *
 * "Reject" maps to `still_unresolved`. A consumer-initiated *dispute* — an
 * assertion that the organization's account is untrue, as opposed to the problem
 * not being fixed — has no engine representation today and is recorded as a
 * dependency rather than faked here.
 */
const REPORT_OPTIONS = [
  { kind: 'resolved_for_me', label: 'Resolved for me', reviewLabel: 'Accept — this was fixed' },
  { kind: 'partially_resolved', label: 'Partly resolved', reviewLabel: 'Partly — some of it' },
  { kind: 'still_unresolved', label: 'Still unresolved', reviewLabel: 'Reject — not fixed' },
] as const;

export const ResolutionRow = ({
  experienceId,
  state,
  canReport,
}: {
  experienceId: string;
  state: ResolutionState;
  /** True when the viewer is the author or an active corroborator. */
  canReport: boolean;
}) => {
  const [current, setCurrent] = useState(state);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);

  const submit = async (kind: string): Promise<void> => {
    setBusy(kind);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/experiences/${experienceId}/resolution`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const body = (await response.json()) as {
        status?: string;
        reporters?: number;
        resolvedShare?: number;
        error?: { message: string };
      };
      if (!response.ok) {
        setMessage(body.error?.message ?? 'That did not go through.');
        return;
      }
      setCurrent((previous) => {
        const status = body.status ?? previous.status;
        const reporters = body.reporters ?? previous.reporters;
        return {
          ...previous,
          status,
          reporters,
          resolvedShare: body.resolvedShare ?? previous.resolvedShare,
          // Recomputed rather than left stale: the badge is the thing a person
          // just changed, and showing the old one would misreport their own answer
          // back to them.
          presentation: presentOutcome({
            status: status as never,
            hasResponse: previous.organizationResponded,
            hasProposedResolution: previous.resolutionProposed,
            reporters,
          }),
        };
      });
    } finally {
      setBusy(undefined);
    }
  };

  const copy = OUTCOME_COPY[current.presentation];
  const reviewing = current.presentation === 'proposed_resolution';

  return (
    <div className="resolution">
      <p className="resolution-status">
        <span className={`outcome-badge outcome-${current.presentation}`}>{copy.badge}</span>
        {current.reporters === 0 ? null : (
          <span className="resolution-tally">
            {current.reporters} {current.reporters === 1 ? 'person has' : 'people have'} reported —{' '}
            {Math.round(current.resolvedShare * 100)}% say it was resolved for them
          </span>
        )}
      </p>

      {/* Always shown, not only when it could be misread: the difference between a
          response, a proposal and a resolution is the thing a viewer most needs. */}
      <p className="resolution-note">{copy.explanation}</p>

      {canReport ? (
        <div className="resolution-actions">
          <span className="resolution-prompt">
            {reviewing ? 'They say this was fixed. Was it?' : 'Was this resolved for you?'}
          </span>
          {REPORT_OPTIONS.map((option) => (
            <button
              key={option.kind}
              type="button"
              className="resolution-report"
              disabled={busy === option.kind}
              onClick={() => void submit(option.kind)}
            >
              {reviewing ? option.reviewLabel : option.label}
            </button>
          ))}
        </div>
      ) : null}

      {message === undefined ? null : (
        <p className="resolution-error" role="alert">
          {message}
        </p>
      )}
    </div>
  );
};
