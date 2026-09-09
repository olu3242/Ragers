'use client';

import { useState } from 'react';

/**
 * The claim controls: Re-Rage / Re-Rave, and Share.
 *
 * They are one component but two entirely separate counts, shown next to each
 * other on purpose. A corroboration count is a count of *people who say this
 * happened to them*; a share count is a count of times a link was passed on.
 * "1,842 Re-Rages" and "12,481 Shares" mean different things, so they are never
 * summed, never blended into one "engagement" figure, and never labelled alike.
 */
export interface SignalCounts {
  readonly corroborations: number;
  readonly shares: number;
}

export const SignalRow = ({
  experienceId,
  kind,
  counts,
}: {
  experienceId: string;
  kind: 'rage' | 'rave';
  counts: SignalCounts;
}) => {
  const [tally, setTally] = useState(counts);
  const [claimed, setClaimed] = useState(false);
  const [busy, setBusy] = useState<'claim' | 'share' | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);

  const label = kind === 'rage' ? 'Re-Rage' : 'Re-Rave';

  const claim = async (): Promise<void> => {
    setBusy('claim');
    setMessage(undefined);
    try {
      const response = await fetch(`/api/experiences/${experienceId}/corroborations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: kind === 'rage' ? 're_rage' : 're_rave' }),
      });
      const body = (await response.json()) as {
        corroborationCount?: number;
        error?: { code: string; message: string };
      };
      if (!response.ok) {
        // The refusals here are meaningful to a person — "you already said this"
        // and "you cannot corroborate your own" — so they are shown, not swallowed.
        setMessage(body.error?.message ?? 'That did not go through.');
        return;
      }
      setClaimed(true);
      setTally((current) => ({ ...current, corroborations: body.corroborationCount ?? current.corroborations }));
    } finally {
      setBusy(undefined);
    }
  };

  const share = async (): Promise<void> => {
    setBusy('share');
    try {
      const response = await fetch(`/api/experiences/${experienceId}/shares`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destination: 'copy_link' }),
      });
      if (!response.ok) return;
      const body = (await response.json()) as { shareCount?: number };
      setTally((current) => ({ ...current, shares: body.shareCount ?? current.shares }));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="signals">
      <button
        type="button"
        className="signal signal-claim"
        aria-pressed={claimed}
        disabled={busy === 'claim'}
        onClick={() => void claim()}
      >
        {label}{' '}
        <span className="signal-count">{tally.corroborations}</span>
      </button>
      <button
        type="button"
        className="signal signal-share"
        disabled={busy === 'share'}
        onClick={() => void share()}
      >
        Share{' '}
        <span className="signal-count">{tally.shares}</span>
      </button>
      <p className="signal-note">
        {label} means it happened to you too. Sharing does not.
      </p>
      {message === undefined ? null : (
        <p className="signal-error" role="alert">
          {message}
        </p>
      )}
    </div>
  );
};
