'use client';

import { useState } from 'react';

/**
 * Relate — "these two are connected".
 *
 * Deliberately shaped so it cannot be mistaken for a Re-Rage. Relating is a claim
 * about the relationship between two accounts, not about the person's own
 * experience, so anyone can do it — and because anyone can, it carries no weight:
 * the count here is a discovery signal and is never shown beside, or added to, a
 * corroboration count.
 *
 * The copy says that outright rather than relying on the reader to infer it from
 * placement.
 */
export interface RelatedItem {
  readonly experienceId: string;
  readonly assertion: string;
  readonly assertedByCount: number;
}

const ASSERTION_LABELS: Readonly<Record<string, string>> = {
  same_occurrence: 'the same incident',
  same_pattern: 'the same kind of thing',
  related_context: 'related',
};

const ASSERTION_OPTIONS = [
  { value: 'same_occurrence', label: 'The same incident' },
  { value: 'same_pattern', label: 'The same kind of thing' },
  { value: 'related_context', label: 'Related, but different' },
] as const;

export const RelateControl = ({
  experienceId,
  related,
  canRelate,
}: {
  experienceId: string;
  related: readonly RelatedItem[];
  /** False for a signed-out visitor: relating is a signed-in act. */
  canRelate: boolean;
}) => {
  const [items, setItems] = useState(related);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [assertion, setAssertion] = useState<string>('same_pattern');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/experiences/${experienceId}/relations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toExperienceId: target.trim(), assertion }),
      });
      const body = (await response.json()) as {
        assertedByCount?: number;
        error?: { message: string };
      };
      if (!response.ok) {
        setMessage(body.error?.message ?? 'That did not go through.');
        return;
      }
      setItems((current) => {
        const existing = current.find((item) => item.experienceId === target.trim());
        if (existing) {
          return current.map((item) =>
            item.experienceId === target.trim()
              ? { ...item, assertedByCount: body.assertedByCount ?? item.assertedByCount }
              : item,
          );
        }
        return [
          ...current,
          { experienceId: target.trim(), assertion, assertedByCount: body.assertedByCount ?? 1 },
        ];
      });
      setOpen(false);
      setTarget('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relate">
      {items.length > 0 ? (
        <>
          <p className="relate-heading">People say these are connected</p>
          <ul className="relate-list">
            {items.map((item) => (
              <li key={item.experienceId}>
                <a href={`/experiences/${item.experienceId}`}>{item.experienceId}</a>
                <span className="relate-assertion">{ASSERTION_LABELS[item.assertion] ?? item.assertion}</span>
                <span className="relate-count">
                  {item.assertedByCount} {item.assertedByCount === 1 ? 'person' : 'people'}
                </span>
              </li>
            ))}
          </ul>
          {/* Said plainly, because the number sits near counts that do mean that. */}
          <p className="relate-note">
            Saying two things are connected is not the same as saying either happened to you. These
            do not count as Re-Rages.
          </p>
        </>
      ) : null}

      {canRelate ? (
        open ? (
          <div className="relate-form">
            <label htmlFor={`relate-target-${experienceId}`}>Which other experience?</label>
            <input
              id={`relate-target-${experienceId}`}
              type="text"
              value={target}
              placeholder="exp_…"
              onChange={(event) => setTarget(event.target.value)}
            />
            <label htmlFor={`relate-assertion-${experienceId}`}>How are they connected?</label>
            <select
              id={`relate-assertion-${experienceId}`}
              value={assertion}
              onChange={(event) => setAssertion(event.target.value)}
            >
              {ASSERTION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <div className="relate-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || target.trim().length === 0}
                onClick={() => void submit()}
              >
                Relate them
              </button>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="relate-open" onClick={() => setOpen(true)}>
            Relate to another experience
          </button>
        )
      ) : null}

      {message === undefined ? null : (
        <p className="relate-error" role="alert">
          {message}
        </p>
      )}
    </div>
  );
};
