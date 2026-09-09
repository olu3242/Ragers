'use client';

import { useState } from 'react';
import { REACTION_TYPES, type ReactionType } from '../src/domain/types.ts';

const LABELS: Readonly<Record<ReactionType, string>> = {
  been_there: 'Been There',
  same: 'Same',
  fair_point: 'Fair Point',
  disagree: 'Disagree',
};

export interface ReactionCounts {
  readonly beenThere: number;
  readonly same: number;
  readonly fairPoint: number;
  readonly disagree: number;
  readonly replyCount: number;
}

const countFor = (counts: ReactionCounts, type: ReactionType): number => {
  switch (type) {
    case 'been_there':
      return counts.beenThere;
    case 'same':
      return counts.same;
    case 'fair_point':
      return counts.fairPoint;
    case 'disagree':
      return counts.disagree;
  }
};

/** The Ragers-native mechanics. There is deliberately no like or repost here. */
export const ReactionRow = ({
  experienceId,
  counts,
}: {
  experienceId: string;
  counts: ReactionCounts;
}) => {
  const [active, setActive] = useState<Partial<Record<ReactionType, boolean>>>({});
  const [tally, setTally] = useState(counts);
  const [busy, setBusy] = useState<ReactionType | undefined>(undefined);

  const toggle = async (type: ReactionType): Promise<void> => {
    setBusy(type);
    try {
      const response = await fetch(`/api/experiences/${experienceId}/reactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reactionType: type }),
      });
      if (!response.ok) return;
      const body = (await response.json()) as { active: boolean };
      setActive((current) => ({ ...current, [type]: body.active }));
      setTally((current) => {
        const delta = body.active ? 1 : -1;
        switch (type) {
          case 'been_there':
            return { ...current, beenThere: current.beenThere + delta };
          case 'same':
            return { ...current, same: current.same + delta };
          case 'fair_point':
            return { ...current, fairPoint: current.fairPoint + delta };
          case 'disagree':
            return { ...current, disagree: current.disagree + delta };
        }
      });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="reactions">
      {REACTION_TYPES.map((type) => (
        <button
          key={type}
          type="button"
          className="reaction"
          aria-pressed={active[type] === true}
          disabled={busy === type}
          onClick={() => void toggle(type)}
        >
          {LABELS[type]}
          <span className="reaction-count">{countFor(tally, type)}</span>
        </button>
      ))}
    </div>
  );
};
