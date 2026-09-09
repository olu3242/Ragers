'use client';

import { useState } from 'react';
import { OUTCOME_COPY, type OutcomePresentation } from '../src/domain/outcome-presentation.ts';

/**
 * An organization's inbox.
 *
 * What this surface can do: acknowledge, answer, ask privately for information,
 * describe a fix, and dispute an account. What it structurally cannot do: hide,
 * edit or delete anything, or mark anything resolved. There is no control here for
 * those because there is no endpoint for them — the organization has no write path
 * to an experience at all.
 *
 * Volume is shown as what it is: a count of people who said this happened to them.
 * It is never labelled verified, and the numbers never carry a tone.
 */
export interface OrganizationCase {
  readonly experienceId: string;
  readonly kind: string;
  readonly bodyText: string;
  readonly corroborators: number;
  readonly reRages: number;
  readonly reRaves: number;
  readonly presentation: OutcomePresentation;
  readonly reporters: number;
  readonly resolvedShare: number;
  readonly responded: boolean;
  readonly resolutionProposed: boolean;
  readonly clusterId?: string;
}

/** Every kind, with words that say what each one commits the organization to. */
const RESPONSE_KINDS = [
  { kind: 'acknowledge', label: 'Acknowledge', hint: 'Says you have seen it. Commits to nothing further.' },
  { kind: 'respond', label: 'Respond', hint: 'Your account, published beside theirs.' },
  {
    kind: 'request_information',
    label: 'Ask for details',
    hint: 'Private to the person. Not published.',
  },
  {
    kind: 'publish_resolution',
    label: 'Describe a fix',
    hint: 'Published as a proposed resolution. Only the people it happened to can confirm it.',
  },
  { kind: 'service_update', label: 'Post an update', hint: 'A change others should know about.' },
  {
    kind: 'dispute',
    label: 'Dispute',
    hint: 'Records that your account differs. Both accounts stand.',
  },
  { kind: 'known_incident', label: 'Known incident', hint: 'Says this was part of something already known.' },
  {
    kind: 'remediation_instructions',
    label: 'What to do',
    hint: 'Published as a proposed resolution with steps.',
  },
] as const;

export const OrganizationCaseInbox = ({
  organizationId,
  cases,
}: {
  organizationId: string;
  cases: readonly OrganizationCase[];
}) => {
  const [rows, setRows] = useState(cases);
  const [openCase, setOpenCase] = useState<string | undefined>(undefined);
  const [kind, setKind] = useState<string>('acknowledge');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);

  const submit = async (experienceId: string): Promise<void> => {
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/organizations/${organizationId}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ experienceId, kind, body }),
      });
      const payload = (await response.json()) as {
        resolutionStatus?: string;
        error?: { message: string };
      };
      if (!response.ok) {
        setMessage(payload.error?.message ?? 'That did not go through.');
        return;
      }
      // Reflect the truth back immediately: describing a fix produces a
      // *proposal*, and the row must not start reading as resolved.
      const proposes = kind === 'publish_resolution' || kind === 'remediation_instructions';
      setRows((current) =>
        current.map((row) =>
          row.experienceId === experienceId
            ? {
                ...row,
                responded: true,
                resolutionProposed: row.resolutionProposed || proposes,
                presentation: proposes && row.reporters === 0 ? 'proposed_resolution' : row.presentation,
              }
            : row,
        ),
      );
      setOpenCase(undefined);
      setBody('');
    } finally {
      setBusy(false);
    }
  };

  if (rows.length === 0) {
    return (
      <div className="empty">
        <h2>No cases yet.</h2>
        <p>Experiences about your organization will appear here once they are published.</p>
      </div>
    );
  }

  return (
    <div className="inbox">
      {message === undefined ? null : (
        <p className="inbox-error" role="alert">
          {message}
        </p>
      )}
      {rows.map((item) => {
        const copy = OUTCOME_COPY[item.presentation];
        const claimants = item.kind === 'rage' ? item.reRages : item.reRaves;
        return (
          <article className="inbox-case" key={item.experienceId}>
            <div className="inbox-head">
              <span className={item.kind === 'rage' ? 'badge badge-rage' : 'badge badge-rave'}>
                {item.kind === 'rage' ? 'Rager' : 'Rave'}
              </span>
              <span className="outcome-badge">{copy.badge}</span>
              {item.clusterId === undefined ? null : (
                <a className="inbox-cluster" href={`/clusters/${item.clusterId}`}>
                  Part of a pattern
                </a>
              )}
            </div>

            <p className="inbox-body">{item.bodyText}</p>

            <p className="inbox-signal">
              {/* People, not engagement. Stated as a claim, not as a finding. */}
              {item.corroborators === 0
                ? 'One person says this happened to them.'
                : `${item.corroborators + 1} people say this happened to them.`}
              {claimants > 0 ? ` ${claimants} added their own account.` : ''}
            </p>
            <p className="inbox-outcome">{copy.explanation}</p>

            {openCase === item.experienceId ? (
              <div className="composer-response">
                <label htmlFor={`kind-${item.experienceId}`}>How are you responding?</label>
                <select
                  id={`kind-${item.experienceId}`}
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                >
                  {RESPONSE_KINDS.map((option) => (
                    <option key={option.kind} value={option.kind}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="composer-hint">
                  {RESPONSE_KINDS.find((option) => option.kind === kind)?.hint}
                </p>

                <label htmlFor={`body-${item.experienceId}`}>What do you want to say?</label>
                <textarea
                  id={`body-${item.experienceId}`}
                  rows={4}
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                />

                <div className="composer-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy || body.trim().length === 0}
                    onClick={() => void submit(item.experienceId)}
                  >
                    Send response
                  </button>
                  <button type="button" className="btn" onClick={() => setOpenCase(undefined)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setOpenCase(item.experienceId);
                  setKind('acknowledge');
                  setBody('');
                }}
              >
                {item.responded ? 'Respond again' : 'Respond'}
              </button>
            )}
          </article>
        );
      })}
    </div>
  );
};
