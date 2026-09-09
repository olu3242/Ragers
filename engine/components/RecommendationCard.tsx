'use client';

import { useState } from 'react';
import {
  DECISION_LABELS,
  DECISION_OUTCOMES,
  decisionNeedsNote,
  describeConfidence,
  describeEffect,
  engineLabel,
  isDecidable,
  type DecisionOutcome,
} from '../lib/proposals.ts';
import type { EngineId, EvidenceRef, ProposalStatus } from '../src/domain/proposal.ts';

/**
 * A governed recommendation, and the decision on it.
 *
 * Three properties of this card are deliberate and load-bearing:
 *
 *   1. **It shows the action, not a sentiment.** A reviewer approves a named
 *      command against a named engine, so they know what they are authorising.
 *   2. **It reports the effect separately from the decision.** Approving here
 *      dispatches the target engine's own command, which can refuse; the refusal
 *      is shown verbatim and the card does not claim the action happened.
 *   3. **Evidence is a link, never a paraphrase.** A reviewer checks the rows
 *      themselves; a summary of evidence inside a recommendation is the
 *      recommendation arguing its own case.
 *
 * It deliberately does *not* refresh the page after a decision. A decided
 * recommendation leaves the open queue, so a refresh would take the card away at
 * the exact moment it carries the one thing the reviewer needs to read — that the
 * governed engine refused their approval. The card stays, showing what happened,
 * until they navigate away.
 */
export interface RecommendationView {
  readonly proposalId: string;
  readonly proposalType: string;
  readonly sourceEngine: EngineId;
  readonly targetEngine: EngineId;
  readonly subjectId: string;
  readonly summary: string;
  readonly rationale: string;
  readonly confidence: number;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly status: ProposalStatus;
  readonly proposedCommand?: string | undefined;
}

const EVIDENCE_HREF: Readonly<Record<EvidenceRef['kind'], (id: string) => string | undefined>> = {
  experience: (id) => `/experiences/${id}`,
  corroboration: () => undefined,
  evidence: () => undefined,
  cluster: () => undefined,
  signal_snapshot: () => undefined,
  risk_event: () => undefined,
};

const EVIDENCE_LABELS: Readonly<Record<EvidenceRef['kind'], string>> = {
  experience: 'account',
  corroboration: 'corroboration',
  evidence: 'attachment',
  cluster: 'group of accounts',
  signal_snapshot: 'measurement',
  risk_event: 'safety record',
};

export const RecommendationCard = ({ recommendation }: { recommendation: RecommendationView }) => {
  const [status, setStatus] = useState<ProposalStatus>(recommendation.status);
  const [effect, setEffect] = useState<string>(
    describeEffect({
      status: recommendation.status,
      targetEngine: recommendation.targetEngine,
      proposedCommand: recommendation.proposedCommand,
    }),
  );
  const [outcome, setOutcome] = useState<DecisionOutcome>('approved');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);

  const noteRequired = decisionNeedsNote(outcome);

  const decide = async (): Promise<void> => {
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/proposals/${recommendation.proposalId}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          outcome,
          ...(note.trim().length === 0 ? {} : { note: note.trim() }),
        }),
      });
      const body = (await response.json()) as {
        status?: ProposalStatus;
        dispatched?: boolean;
        dispatchError?: string;
        error?: { message: string };
      };
      if (!response.ok) {
        setMessage(body.error?.message ?? 'That decision did not go through.');
        return;
      }
      const decided = body.status ?? outcome;
      setStatus(decided);
      // The engine's own account of what followed, not this component's guess.
      setEffect(
        describeEffect({
          status: decided,
          targetEngine: recommendation.targetEngine,
          proposedCommand: recommendation.proposedCommand,
          dispatched: body.dispatched,
          dispatchError: body.dispatchError,
        }),
      );
      setNote('');
    } finally {
      setBusy(false);
    }
  };

  const decidable = isDecidable(status);

  return (
    <li className="recommendation">
      <p className="recommendation-type">{recommendation.proposalType.replaceAll('_', ' ')}</p>
      <p className="recommendation-summary">{recommendation.summary}</p>

      <dl className="recommendation-meta">
        <dt>Proposed by</dt>
        <dd>{engineLabel(recommendation.sourceEngine)}</dd>
        <dt>Would be carried out by</dt>
        <dd>{engineLabel(recommendation.targetEngine)}</dd>
        <dt>About</dt>
        <dd>{recommendation.subjectId}</dd>
        <dt>Confidence</dt>
        <dd>{describeConfidence(recommendation.confidence)}</dd>
        {recommendation.proposedCommand === undefined ? null : (
          <>
            <dt>Action</dt>
            {/* Named, so approval authorises a specific thing. */}
            <dd>
              <code>{recommendation.proposedCommand}</code>
            </dd>
          </>
        )}
      </dl>

      <p className="recommendation-rationale">{recommendation.rationale}</p>

      <p className="recommendation-evidence-label">Check for yourself:</p>
      <ul className="recommendation-evidence">
        {recommendation.evidenceRefs.map((ref) => {
          const href = EVIDENCE_HREF[ref.kind](ref.id);
          return (
            <li key={`${ref.kind}:${ref.id}`}>
              {href === undefined ? (
                <span>
                  {EVIDENCE_LABELS[ref.kind]} <code>{ref.id}</code>
                </span>
              ) : (
                <a href={href}>
                  {EVIDENCE_LABELS[ref.kind]} <code>{ref.id}</code>
                </a>
              )}
            </li>
          );
        })}
      </ul>

      {/* The effect, always, and never folded into the status word. */}
      <p className="recommendation-effect" role="status">
        {effect}
      </p>

      {decidable ? (
        <div className="recommendation-decision">
          <fieldset>
            <legend>Your decision</legend>
            {DECISION_OUTCOMES.map((option) => (
              <label key={option} htmlFor={`decision-${recommendation.proposalId}-${option}`}>
                <input
                  type="radio"
                  id={`decision-${recommendation.proposalId}-${option}`}
                  name={`decision-${recommendation.proposalId}`}
                  value={option}
                  checked={outcome === option}
                  onChange={() => setOutcome(option)}
                />
                {DECISION_LABELS[option]}
              </label>
            ))}
          </fieldset>

          <label htmlFor={`note-${recommendation.proposalId}`}>
            Why?{noteRequired ? ' (required)' : ' (optional)'}
          </label>
          <textarea
            id={`note-${recommendation.proposalId}`}
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />

          <p className="recommendation-hint">
            Approving runs the action through {engineLabel(recommendation.targetEngine)}, under the
            same rules as doing it by hand. It can be refused — if it is, you will see why here.
          </p>

          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || (noteRequired && note.trim().length === 0)}
            onClick={() => void decide()}
          >
            {DECISION_LABELS[outcome]}
          </button>
        </div>
      ) : null}

      {message === undefined ? null : (
        <p className="recommendation-error" role="alert">
          {message}
        </p>
      )}
    </li>
  );
};
