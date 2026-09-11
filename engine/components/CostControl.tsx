'use client';

import { useState } from 'react';

/**
 * What it cost you — the experiencer's own account, Phase 31.
 *
 * Only the person it happened to sees this control, and only they can answer it. The
 * engine refuses an assertion from anybody else, including a moderator, and there is
 * no command anywhere that lets staff set a severity band directly — so what a person
 * says here is the only thing severity is ever drawn from.
 *
 * Two deliberate omissions:
 *
 *   * **No total.** The dimensions are not added up into one figure, because the
 *     figure would be compared across unlike experiences.
 *   * **No band shown while answering.** Telling somebody "answering this makes it
 *     Critical" is an invitation to answer strategically rather than accurately.
 *
 * Every field is optional. A person who does not want to say what it cost them is not
 * penalised for it — their experience is simply unassessed, and reads as unassessed
 * rather than as minor.
 */
const NUMERIC = [
  { dimension: 'money_lost', label: 'Money you lost', suffix: 'GBP', step: '0.01' },
  { dimension: 'time_lost_minutes', label: 'Time you lost (minutes)', step: '1' },
  { dimension: 'people_affected', label: 'Other people you know were affected', step: '1' },
] as const;

const FLAGS = [
  { dimension: 'service_interrupted', label: 'A service you rely on was interrupted' },
  { dimension: 'safety_involved', label: 'Safety was involved' },
  { dimension: 'recurrence', label: 'This keeps happening' },
] as const;

export const CostControl = ({
  experienceId,
  asserted,
}: {
  experienceId: string;
  /** Dimensions already answered, so a person is not asked twice. */
  asserted: readonly string[];
}) => {
  const [answered, setAnswered] = useState<readonly string[]>(asserted);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);

  const send = async (body: Record<string, unknown>, dimension: string): Promise<void> => {
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/experiences/${experienceId}/enrichment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { asserted?: string[]; error?: { message: string } };
      if (!response.ok) {
        setMessage(payload.error?.message ?? 'That did not go through.');
        return;
      }
      setAnswered(payload.asserted ?? [...answered, dimension]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="cost" aria-labelledby={`cost-${experienceId}`}>
      <h2 id={`cost-${experienceId}`} className="cost-heading">
        What did this cost you?
      </h2>
      <p className="cost-hint">
        Your own account, in your own terms. Every question is optional, and leaving one
        blank costs you nothing.
      </p>

      {answered.length > 0 ? (
        <p className="cost-answered">
          You have answered: {answered.map((entry) => entry.replaceAll('_', ' ')).join(', ')}.
        </p>
      ) : null}

      {open ? (
        <div className="cost-form">
          {NUMERIC.map((field) => (
            <div className="cost-field" key={field.dimension}>
              <label htmlFor={`cost-${experienceId}-${field.dimension}`}>{field.label}</label>
              <input
                id={`cost-${experienceId}-${field.dimension}`}
                type="number"
                min="0"
                step={field.step}
                value={amounts[field.dimension] ?? ''}
                onChange={(event) =>
                  setAmounts((current) => ({ ...current, [field.dimension]: event.target.value }))
                }
              />
              <button
                type="button"
                className="btn"
                disabled={busy || (amounts[field.dimension] ?? '') === ''}
                onClick={() =>
                  void send(
                    {
                      dimension: field.dimension,
                      amount: Number(amounts[field.dimension]),
                      ...('suffix' in field ? { currency: field.suffix } : {}),
                    },
                    field.dimension,
                  )
                }
              >
                Save
              </button>
            </div>
          ))}

          {FLAGS.map((field) => (
            <div className="cost-field" key={field.dimension}>
              <span id={`cost-${experienceId}-${field.dimension}-label`}>{field.label}</span>
              <button
                type="button"
                className="btn"
                aria-describedby={`cost-${experienceId}-${field.dimension}-label`}
                disabled={busy}
                onClick={() => void send({ dimension: field.dimension, flag: true }, field.dimension)}
              >
                Yes
              </button>
            </div>
          ))}
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Add what it cost
        </button>
      )}

      {message === undefined ? null : (
        <p className="cost-error" role="alert">
          {message}
        </p>
      )}
    </section>
  );
};
