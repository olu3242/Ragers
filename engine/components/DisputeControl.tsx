'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Disputing an account.
 *
 * Kept visibly separate from resolution reporting, because they are different acts:
 * rejecting a proposed fix says the problem persists; disputing says an *account is
 * untrue*. A surface that offered them as two shades of the same control would
 * collapse a distinction the whole outcome model rests on.
 *
 * The reasons offered depend on which side the viewer is. Somebody who is both an
 * experiencer and organization staff sees both, labelled, so they choose which hat
 * they are wearing.
 */
export interface DisputeView {
  readonly disputeId: string;
  readonly origin: string;
  readonly reason: string;
  readonly status: string;
}

const REASON_LABELS: Readonly<Record<string, string>> = {
  account_inaccurate: 'says the account is inaccurate',
  not_our_organization: 'says this is not their organization',
  already_resolved: 'says it was already resolved',
  fix_not_delivered: 'says the fix was not delivered',
  response_misleading: 'says the response is misleading',
  wrong_entity: 'says it names the wrong organization',
  other: 'raised a concern',
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  open: 'awaiting review',
  under_review: 'being reviewed',
  upheld: 'upheld after review',
  declined: 'declined after review',
};

const EXPERIENCER_REASONS = [
  { value: 'response_misleading', label: 'Their response is misleading' },
  { value: 'fix_not_delivered', label: 'They say it is fixed; it is not' },
  { value: 'account_inaccurate', label: 'Something here is inaccurate' },
  { value: 'other', label: 'Something else' },
] as const;

const ORGANIZATION_REASONS = [
  { value: 'account_inaccurate', label: 'The account is inaccurate' },
  { value: 'not_our_organization', label: 'This is not our organization' },
  { value: 'wrong_entity', label: 'It names the wrong organization' },
  { value: 'already_resolved', label: 'This was already resolved' },
  { value: 'other', label: 'Something else' },
] as const;

export const DisputeControl = ({
  experienceId,
  contested,
  disputes,
  canDispute,
  organizations,
}: {
  experienceId: string;
  contested: boolean;
  disputes: readonly DisputeView[];
  canDispute: boolean;
  /** Organizations the viewer may act for. Empty for a consumer. */
  organizations: readonly { readonly id: string; readonly displayName: string }[];
}) => {
  const [rows, setRows] = useState(disputes);
  const [live, setLive] = useState(contested);
  const [open, setOpen] = useState(false);
  const [asOrganization, setAsOrganization] = useState('');
  const [reason, setReason] = useState<string>('response_misleading');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const router = useRouter();

  const reasons = asOrganization === '' ? EXPERIENCER_REASONS : ORGANIZATION_REASONS;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/experiences/${experienceId}/disputes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reason,
          ...(detail.trim().length === 0 ? {} : { detail: detail.trim() }),
          ...(asOrganization === '' ? {} : { organizationId: asOrganization }),
        }),
      });
      const body = (await response.json()) as {
        disputeId?: string;
        origin?: string;
        status?: string;
        contested?: boolean;
        error?: { message: string };
      };
      if (!response.ok) {
        setMessage(body.error?.message ?? 'That did not go through.');
        return;
      }
      setRows((current) => [
        ...current,
        {
          disputeId: body.disputeId ?? '',
          origin: body.origin ?? 'experiencer',
          reason,
          status: body.status ?? 'open',
        },
      ]);
      setLive(body.contested ?? true);
      setOpen(false);
      setDetail('');
      // Raising a dispute changes server-rendered state beyond this component —
      // the Contested badge beside the account, for one. Refresh rather than leave
      // half the page optimistic and half of it stale.
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dispute">
      {rows.length > 0 ? (
        <ul className="dispute-list">
          {rows.map((row) => (
            <li key={row.disputeId}>
              <span className="dispute-origin">
                {row.origin === 'organization' ? 'The organization' : 'Someone this happened to'}
              </span>{' '}
              {REASON_LABELS[row.reason] ?? 'raised a dispute'} —{' '}
              <span className="dispute-status">{STATUS_LABELS[row.status] ?? row.status}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {live ? (
        // Said explicitly: a dispute is not a finding about who is right.
        <p className="dispute-note">
          This account is contested. A dispute records that the accounts differ — it is not a
          finding about which is right.
        </p>
      ) : null}

      {canDispute ? (
        open ? (
          <div className="dispute-form">
            {organizations.length > 0 ? (
              <>
                <label htmlFor={`dispute-as-${experienceId}`}>Disputing as</label>
                <select
                  id={`dispute-as-${experienceId}`}
                  value={asOrganization}
                  onChange={(event) => {
                    setAsOrganization(event.target.value);
                    setReason(
                      event.target.value === ''
                        ? EXPERIENCER_REASONS[0].value
                        : ORGANIZATION_REASONS[0].value,
                    );
                  }}
                >
                  <option value="">Myself</option>
                  {organizations.map((organization) => (
                    <option key={organization.id} value={organization.id}>
                      {organization.displayName}
                    </option>
                  ))}
                </select>
              </>
            ) : null}

            <label htmlFor={`dispute-reason-${experienceId}`}>What is wrong?</label>
            <select
              id={`dispute-reason-${experienceId}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            >
              {reasons.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <label htmlFor={`dispute-detail-${experienceId}`}>
              What should a reviewer know?{reason === 'other' ? ' (required)' : ''}
            </label>
            <textarea
              id={`dispute-detail-${experienceId}`}
              rows={3}
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
            />

            <p className="dispute-hint">
              A moderator reviews this. Neither side can decide it, and you can withdraw it at any
              time.
            </p>

            <div className="dispute-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || (reason === 'other' && detail.trim().length === 0)}
                onClick={() => void submit()}
              >
                Raise dispute
              </button>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="dispute-open" onClick={() => setOpen(true)}>
            Dispute this
          </button>
        )
      ) : null}

      {message === undefined ? null : (
        <p className="dispute-error" role="alert">
          {message}
        </p>
      )}
    </div>
  );
};
