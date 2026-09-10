import { createHmac, timingSafeEqual } from 'node:crypto';
import { err, ok, type Result } from '../runtime/result.ts';
import { validationError, type EngineError } from '../runtime/errors.ts';

/**
 * Platform API and integrations — Phase 49, E12/E9.
 *
 * The design constraint the roadmap sets is the whole of it: *outbound delivery rides the
 * existing durable job runtime. A webhook is a leased job with retries and a dead-letter
 * queue, not a best-effort HTTP call.* So this module defines the subscription and the
 * signing, and delivery is an ordinary consumer over the outbox — no bespoke retry loop, no
 * second event infrastructure.
 *
 * Three properties matter more than the feature:
 *
 *   1. **Tenant isolation.** A subscription belongs to one organization, and the payload it
 *      receives contains only what that organization could already read. There is no
 *      subscription shape that can ask for another tenant's events.
 *   2. **Signing.** Every delivery carries an HMAC over the exact bytes sent, so a receiver
 *      can tell a real delivery from a forged one. Verified with a constant-time compare,
 *      because a timing-variable compare on a signature is a way to guess it.
 *   3. **No payload beyond the event.** A webhook carries ids, a kind and a timestamp — never
 *      an author, never a body, never a trust or risk figure. A receiver that wants the
 *      account fetches it through the API, where authorization applies.
 */
export type IntegrationEvent =
  | 'experience.published_about_you'
  | 'cluster.signal_changed'
  | 'resolution.reported'
  | 'dispute.opened';

export const INTEGRATION_EVENTS: readonly IntegrationEvent[] = [
  'experience.published_about_you',
  'cluster.signal_changed',
  'resolution.reported',
  'dispute.opened',
];

export interface Subscription {
  readonly id: string;
  readonly organizationId: string;
  readonly endpointUrl: string;
  readonly events: readonly IntegrationEvent[];
  /** Never returned by any read path. Used only to sign. */
  readonly secret: string;
  readonly isActive: boolean;
  readonly createdAt: number;
}

/**
 * The payload. Deliberately small, and deliberately without a `body` field.
 *
 * A webhook is a notification that something happened, not a copy of it. An integration
 * that needs the account calls the API for it, where the same authorization applies as
 * anywhere else — which means a leaked webhook log cannot become a leaked corpus.
 */
export interface DeliveryPayload {
  readonly event: IntegrationEvent;
  readonly organizationId: string;
  readonly subjectId: string;
  readonly occurredAt: number;
  /** Ids and counts only. Asserted by a test that scans for forbidden keys. */
  readonly data: Readonly<Record<string, string | number | boolean>>;
}

export const FORBIDDEN_PAYLOAD_KEYS: readonly string[] = [
  'bodyText',
  'body',
  'text',
  'transcript',
  'rawText',
  'actorId',
  'authorId',
  'email',
  'trust',
  'risk',
  'originalKey',
];

/** Keys a payload must not carry, found rather than assumed. */
export const forbiddenKeysIn = (payload: DeliveryPayload): readonly string[] =>
  Object.keys(payload.data).filter((key) =>
    FORBIDDEN_PAYLOAD_KEYS.some((forbidden) => key.toLowerCase().includes(forbidden.toLowerCase())),
  );

const HTTPS = 'https://';

export const createSubscription = (
  input: { organizationId: string; endpointUrl: unknown; events: unknown; secret: unknown },
  meta: { id: string; now: number },
): Result<Subscription, EngineError> => {
  if (typeof input.endpointUrl !== 'string' || !input.endpointUrl.startsWith(HTTPS)) {
    // Plain HTTP would put the payload and the signature on the wire in clear.
    return err(validationError('endpoint_must_be_https', 'an endpoint must be https'));
  }
  if (!Array.isArray(input.events) || input.events.length === 0) {
    return err(validationError('events_required', 'a subscription must say which events it wants'));
  }
  const events = input.events.filter((event): event is IntegrationEvent =>
    (INTEGRATION_EVENTS as readonly unknown[]).includes(event),
  );
  if (events.length !== input.events.length) {
    return err(validationError('unknown_event', 'that is not an event this platform emits'));
  }
  if (typeof input.secret !== 'string' || input.secret.length < 32) {
    // A short secret is a signature anybody can forge.
    return err(validationError('secret_too_short', 'a signing secret must be at least 32 characters'));
  }
  return ok({
    id: meta.id,
    organizationId: input.organizationId,
    endpointUrl: input.endpointUrl,
    events,
    secret: input.secret,
    isActive: true,
    createdAt: meta.now,
  });
};

/**
 * Sign the exact bytes that will be sent.
 *
 * Over the serialised body rather than over its fields, because a signature over fields is a
 * signature over somebody's idea of the fields — and a receiver reconstructing that idea
 * differently gets a mismatch it cannot debug.
 */
export const sign = (secret: string, body: string): string =>
  createHmac('sha256', secret).update(body).digest('hex');

/**
 * Verify, in constant time.
 *
 * `timingSafeEqual` rather than `===`: comparing a signature with an early-exit compare
 * leaks how much of a guess was right, which is enough to recover one byte at a time.
 */
export const verify = (secret: string, body: string, signature: string): boolean => {
  const expected = sign(secret, body);
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
};

/** The body, serialised once so the signature and the request cannot disagree. */
export const serialise = (payload: DeliveryPayload): string => JSON.stringify(payload);

/** Whether a subscription may receive an event. A tenant only ever gets its own. */
export const mayReceive = (
  subscription: Subscription,
  event: IntegrationEvent,
  organizationId: string,
): boolean => subscription.isActive && subscription.organizationId === organizationId && subscription.events.includes(event);
