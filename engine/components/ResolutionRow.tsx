'use client';

import { useState } from 'react';

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
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  open: 'Open',
  gaining_signal: 'Happening to others',
  acknowledged: 'Acknowledged',
  under_review: 'Being looked into',
  resolved: 'Resolved',
  partially_resolved: 'Partly resolved',
  disputed: 'Disputed',
  reopened: 'Happening again',
};

const REPORT_OPTIONS = [
  { kind: 'resolved_for_me', label: 'Resolved for me' },
  { kind: 'partially_resolved', label: 'Partly resolved' },
  { kind: 'still_unresolved', label: 'Still unresolved' },
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
      setCurrent((previous) => ({
        ...previous,
        status: body.status ?? previous.status,
        reporters: body.reporters ?? previous.reporters,
        resolvedShare: body.resolvedShare ?? previous.resolvedShare,
      }));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="resolution">
      <p className="resolution-status">
        <span className="resolution-badge">{STATUS_LABELS[current.status] ?? current.status}</span>
        {current.reporters === 0 ? (
          <span className="resolution-tally">Nobody has said whether this was resolved.</span>
        ) : (
          <span className="resolution-tally">
            {current.reporters} {current.reporters === 1 ? 'person has' : 'people have'} reported —{' '}
            {Math.round(current.resolvedShare * 100)}% say it was resolved for them
          </span>
        )}
      </p>

      {current.organizationResponded ? (
        // Stated separately and explicitly: this is the part most easily misread.
        <p className="resolution-note">
          The organization has responded. That is their account, not a resolution.
        </p>
      ) : null}

      {canReport ? (
        <div className="resolution-actions">
          <span className="resolution-prompt">Was this resolved for you?</span>
          {REPORT_OPTIONS.map((option) => (
            <button
              key={option.kind}
              type="button"
              className="resolution-report"
              disabled={busy === option.kind}
              onClick={() => void submit(option.kind)}
            >
              {option.label}
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
