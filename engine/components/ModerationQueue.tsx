'use client';

import { useState } from 'react';
import { PriorityRow, type PriorityView } from './PriorityRow.tsx';

/**
 * The operator's review queue.
 *
 * Deliberately not a feed. Each row is a decision waiting to be made, and it
 * shows *why* it is here — the screening signals that routed it, and how many
 * people reported it — because a moderator judging content without knowing what
 * flagged it is guessing.
 *
 * The decisions offered are the engine's, unabbreviated: warn, remove, restore,
 * no action. "No action" is offered as a real outcome rather than left as an
 * empty gesture, because deciding that nothing is wrong is a decision, and a
 * queue that only offers removal quietly biases toward it.
 */
export interface QueueCase {
  readonly queueItemId: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly priority: number;
  readonly state: string;
  readonly claimedBy?: string;
  readonly signals: readonly string[];
  readonly screeningOutcome: string;
  readonly reportCount: number;
  readonly publicationStatus: string;
  readonly bodyText: string;
  /**
   * Why an escalation rule put this here, in the words of the rule and the values
   * that satisfied it. Empty for an item that arrived from screening or a report.
   */
  readonly escalations: readonly string[];
  /** How long it has been waiting, when it is an escalated experience. */
  readonly aging?: string;
  /**
   * Where it sits and why — Phases 41–43. Absent when nothing was assessed.
   *
   * Named `ranking` rather than `priority` because `priority` on this type is already
   * the queue item's own numeric weight from screening. Two different things called the
   * same name in one row is how the wrong one gets rendered.
   */
  readonly ranking?: PriorityView;
}

const SIGNAL_LABELS: Readonly<Record<string, string>> = {
  person_name: 'may name a person',
  phone: 'contains a phone number',
};

const ACTIONS = [
  { action: 'no_action', label: 'No action needed' },
  { action: 'warn', label: 'Warn' },
  { action: 'remove', label: 'Remove' },
  { action: 'restore', label: 'Restore' },
] as const;

export const ModerationQueue = ({ cases, actorId }: { cases: readonly QueueCase[]; actorId: string }) => {
  const [rows, setRows] = useState(cases);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const post = async (url: string, data: unknown): Promise<boolean> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (response.ok) return true;
    const body = (await response.json()) as { error?: { message: string } };
    setMessage(body.error?.message ?? 'That did not go through.');
    return false;
  };

  const claim = async (item: QueueCase): Promise<void> => {
    setBusy(item.queueItemId);
    setMessage(undefined);
    try {
      if (await post('/api/moderation/claim', { queueItemId: item.queueItemId })) {
        setRows((current) =>
          current.map((row) =>
            row.queueItemId === item.queueItemId ? { ...row, state: 'claimed', claimedBy: actorId } : row,
          ),
        );
      }
    } finally {
      setBusy(undefined);
    }
  };

  const decide = async (item: QueueCase, action: string): Promise<void> => {
    setBusy(`${item.queueItemId}:${action}`);
    setMessage(undefined);
    try {
      const reason = reasons[item.queueItemId] ?? '';
      if (
        await post('/api/moderation/action', {
          targetType: item.targetType,
          targetId: item.targetId,
          action,
          reason,
        })
      ) {
        // Removed from the list rather than marked done: the queue is what is
        // still outstanding, and a decided item is not.
        setRows((current) => current.filter((row) => row.queueItemId !== item.queueItemId));
      }
    } finally {
      setBusy(undefined);
    }
  };

  if (rows.length === 0) {
    return (
      <div className="empty">
        <h2>Nothing waiting.</h2>
        <p>Content routed to review will appear here.</p>
      </div>
    );
  }

  return (
    <div className="queue">
      {message === undefined ? null : (
        <p className="queue-error" role="alert">
          {message}
        </p>
      )}
      {rows.map((item) => {
        const mine = item.claimedBy === actorId;
        const heldByOther = item.state === 'claimed' && !mine;
        return (
          <article className="queue-case" key={item.queueItemId}>
            <div className="queue-head">
              <span className="queue-status">{item.publicationStatus.replace(/_/g, ' ')}</span>
              {item.signals.map((signal) => (
                <span className="queue-signal" key={signal}>
                  {SIGNAL_LABELS[signal] ?? signal}
                </span>
              ))}
              {item.reportCount > 0 ? (
                <span className="queue-reports">
                  {item.reportCount} report{item.reportCount === 1 ? '' : 's'}
                </span>
              ) : null}
            </div>

            {/* An escalated item says which rule fired and on what values. "Escalated"
                alone tells a moderator nothing they can act on. */}
            {item.escalations.length > 0 ? (
              <ul className="queue-escalations">
                {item.escalations.map((because) => (
                  <li key={because}>{because}</li>
                ))}
              </ul>
            ) : null}
            {item.aging === undefined ? null : <p className="queue-aging">{item.aging}</p>}

            {/* Where it sits, and why — separately from why it was queued. Screening put
                it here; priority says what to do with it first. */}
            <PriorityRow priority={item.ranking} />

            <p className="queue-body">{item.bodyText}</p>

            {heldByOther ? (
              <p className="queue-note">Another moderator is handling this.</p>
            ) : mine ? (
              <div className="queue-actions">
                <label htmlFor={`reason-${item.queueItemId}`}>Reason (recorded in the audit trail)</label>
                <input
                  id={`reason-${item.queueItemId}`}
                  type="text"
                  value={reasons[item.queueItemId] ?? ''}
                  onChange={(event) =>
                    setReasons((current) => ({ ...current, [item.queueItemId]: event.target.value }))
                  }
                />
                <div className="queue-buttons">
                  {ACTIONS.map((option) => (
                    <button
                      key={option.action}
                      type="button"
                      className={`queue-action queue-action-${option.action}`}
                      disabled={busy === `${item.queueItemId}:${option.action}`}
                      onClick={() => void decide(item, option.action)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="queue-claim"
                disabled={busy === item.queueItemId}
                onClick={() => void claim(item)}
              >
                Claim to review
              </button>
            )}
          </article>
        );
      })}
    </div>
  );
};
