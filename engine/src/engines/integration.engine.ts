import { err, ok } from '../runtime/result.ts';
import { notFoundError, preconditionError, transientError } from '../runtime/errors.ts';
import {
  createSubscription,
  forbiddenKeysIn,
  mayReceive,
  serialise,
  sign,
  type DeliveryPayload,
  type IntegrationEvent,
  type Subscription,
} from '../domain/integration.ts';
import { entitlementFor, mayUse, type PlanTier } from '../domain/entitlement.ts';
import { eq } from '../ports/store.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { Consumer } from '../runtime/orchestrator.ts';
import type {
  DeliveryRow,
  EntitlementRow,
  OrganizationProfile,
  SubscriptionRow,
} from '../ports/store.ts';
import { isIntegrationSuspended } from './control.engine.ts';
import type { EngineDeps } from './deps.ts';
import { organizationFor } from './organization.engine.ts';

/**
 * Integrations — Phase 49, and the entitlement reads of Phase 48.
 *
 * Delivery is a **consumer over the existing outbox**, so a webhook inherits the leased-job
 * runtime's retries, its dead-letter queue and its at-least-once semantics rather than
 * getting a bespoke retry loop nobody maintains. That was the roadmap's design constraint
 * and it is also the only way a webhook is auditable: every attempt is a row.
 *
 * The delivery row is keyed on (subscription, outbox event), which is what makes replay safe.
 * At-least-once delivery means the same event *will* be handled twice, and the guarantee that
 * matters — "replay does not duplicate effects" — is enforced here rather than hoped for: a
 * second handling finds the row and sends nothing.
 *
 * Entitlement appears in exactly one place in this engine: whether an organization may *read*
 * a benchmark or hold a subscription at all. It reaches nothing that decides what gets
 * published, ranked, moderated or prioritised. This file is one of three declared commercial
 * surfaces in `COMMERCIAL_SURFACES`, each carrying its reason; every other module in the domain
 * and the engines is held to entitlement-blindness by discovery rather than by a list.
 */
export const deliveryKey = (subscriptionId: string, outboxId: string): string =>
  `dlv:${subscriptionId}:${outboxId}`;

export interface SubscribeInput {
  readonly organizationId: string;
  readonly endpointUrl: string;
  readonly events: readonly string[];
  readonly secret: string;
}

export const registerIntegrationEngine = (deps: EngineDeps): void => {
  const subscribe: CommandHandler<SubscribeInput, { subscriptionId: string; events: readonly string[] }> = {
    name: 'integration.subscribe',
    action: 'integration.manage',
    resolveResource: async (input) => ok({ type: 'organization_case', id: input.organizationId }),
    handle: async (input, ctx) => {
      const membership = await organizationFor(deps, ctx.actor.actorId, input.organizationId);
      if (!membership) {
        return err(preconditionError('not_a_member', 'you do not act for that organization'));
      }

      // An integration is an entitled read path. Refusing here rather than delivering
      // nothing later means an organization is told why, instead of debugging silence.
      const entitlement = await deps.store.entitlements.get(input.organizationId);
      if (!mayUse(entitlement, 'issue_alerts')) {
        return err(
          preconditionError('feature_not_available', 'that organization’s plan does not include alerts'),
        );
      }

      const created = createSubscription(input, { id: deps.ids.next('sub'), now: ctx.clock.now() });
      if (!created.ok) return created;
      await deps.store.subscriptions.put(created.value);

      return ok({
        value: { subscriptionId: created.value.id, events: created.value.events },
        events: [
          {
            aggregateType: 'organization',
            aggregateId: input.organizationId,
            eventName: 'IntegrationSubscribed',
            payload: {
              subscriptionId: created.value.id,
              organizationId: input.organizationId,
              // The events, never the secret. A secret in an event payload is a secret in
              // the outbox, the logs and every consumer that ever reads them.
              events: [...created.value.events],
            },
          },
        ],
      });
    },
  };

  deps.bus.register(subscribe);
};

/** The organization an event concerns, or undefined when it concerns none. */
const organizationForEvent = async (
  deps: EngineDeps,
  payloadExperienceId: string,
): Promise<string | undefined> => {
  const experience = await deps.store.experiences.get(payloadExperienceId);
  if (!experience?.entityId) return undefined;
  const profile = await deps.store.organizationProfiles.queryOne([
    eq<OrganizationProfile>('entityId', experience.entityId),
  ]);
  return profile?.status === 'claimed' ? profile.id : undefined;
};

const EVENT_MAP: Readonly<Record<string, IntegrationEvent>> = {
  ExperiencePublished: 'experience.published_about_you',
  ClusterSignalUpdated: 'cluster.signal_changed',
  ResolutionReported: 'resolution.reported',
  DisputeOpened: 'dispute.opened',
};

/**
 * Outbound delivery.
 *
 * A consumer, so it is leased, retried and dead-lettered like everything else. Sending is
 * left to the caller-supplied transport: the engine's job is deciding *what* goes to *whom*
 * and recording that it did, and an HTTP client in here would make that untestable without
 * a network.
 */
export const createDeliveryConsumer = (deps: EngineDeps): Consumer => ({
  name: 'integration.deliver',
  events: Object.keys(EVENT_MAP),
  handle: async (event) => {
    const mapped = EVENT_MAP[event.eventName];
    if (!mapped) return ok(undefined);
    const experienceId = String(event.payload['experienceId'] ?? '');
    if (!experienceId) return ok(undefined);

    const organizationId = await organizationForEvent(deps, experienceId);
    if (!organizationId) return ok(undefined);

    const subscriptions = await deps.store.subscriptions.query([
      eq<SubscriptionRow>('organizationId', organizationId),
    ]);

    for (const subscription of subscriptions) {
      if (!mayReceive(subscription, mapped, organizationId)) continue;

      // Keyed on (subscription, event). At-least-once delivery means this consumer *will*
      // run twice for the same event, and this is where "replay does not duplicate effects"
      // is enforced rather than hoped for.
      const id = deliveryKey(subscription.id, event.id);
      if (await deps.store.deliveries.get(id)) continue;

      const payload: DeliveryPayload = {
        event: mapped,
        organizationId,
        subjectId: experienceId,
        occurredAt: event.occurredAt,
        // Ids and counts only. A receiver that wants the account fetches it through the API,
        // where authorization applies — so a leaked webhook log is not a leaked corpus.
        data: { experienceId, eventName: event.eventName },
      };
      const leaked = forbiddenKeysIn(payload);
      if (leaked.length > 0) {
        // Refused rather than sent. A payload that carries more than it should is a leak
        // whether or not anybody notices.
        deps.metrics.increment('integration.payload_refused');
        continue;
      }

      const body = serialise(payload);
      const row: DeliveryRow = {
        id,
        subscriptionId: subscription.id,
        organizationId,
        outboxId: event.id,
        event: mapped,
        signature: sign(subscription.secret, body),
        body,
        state: 'pending',
        attemptCount: 0,
        createdAt: deps.clock.now(),
      };
      const claimed = await deps.store.deliveries.compareAndSet(row, 'absent');
      if (!claimed) continue;

      // Phase 94: a suspended integration sends nothing, and the delivery stays pending rather
      // than being marked failed. Failed would put a permanent mark on a delivery nobody
      // attempted, and releasing the control could not undo it — which would make the switch
      // irreversible in the one place the whole point is that it is not.
      if (await isIntegrationSuspended(deps, subscription.id)) {
        deps.metrics.increment('integration.suspended');
        continue;
      }

      const transport = deps.providers.webhookTransport;
      if (!transport) {
        // No transport configured: the delivery is recorded as pending and retried later,
        // rather than marked sent. Claiming a send that never happened would make the audit
        // trail a fiction.
        deps.metrics.increment('integration.transport_absent');
        continue;
      }

      const sent = await transport.send({
        url: subscription.endpointUrl,
        body,
        signature: row.signature,
      });
      await deps.store.deliveries.put({
        ...row,
        state: sent.ok ? 'sent' : 'failed',
        attemptCount: 1,
        ...(sent.ok ? { sentAt: deps.clock.now() } : { lastError: sent.error.message }),
      });
      if (!sent.ok) {
        // Returned as an error so the orchestrator retries and dead-letters it, instead of
        // this consumer inventing a retry policy of its own.
        return err(transientError('delivery_failed', sent.error.message));
      }
      deps.metrics.increment('integration.delivered', { event: mapped });
    }

    return ok(undefined);
  },
});

/** Set an organization's plan. Admin-only; it unlocks reads and nothing else. */
export const setEntitlement = async (
  deps: EngineDeps,
  organizationId: string,
  tier: PlanTier,
): Promise<EntitlementRow> => {
  const row = entitlementFor(organizationId, tier, deps.clock.now());
  await deps.store.entitlements.put({ ...row, id: organizationId, features: [...row.features] });
  return { ...row, id: organizationId, features: [...row.features] };
};

export const deliveriesFor = async (
  deps: EngineDeps,
  organizationId: string,
): Promise<readonly DeliveryRow[]> =>
  deps.store.deliveries.query([eq<DeliveryRow>('organizationId', organizationId)], {
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: 100,
  });

export const subscriptionsFor = async (
  deps: EngineDeps,
  organizationId: string,
): Promise<readonly Subscription[]> =>
  deps.store.subscriptions.query([eq<SubscriptionRow>('organizationId', organizationId)]);

/** A secret is never returned by a read path. Asserted in a test. */
export const publicSubscriptionView = (subscription: Subscription) => ({
  subscriptionId: subscription.id,
  endpointUrl: subscription.endpointUrl,
  events: subscription.events,
  isActive: subscription.isActive,
});

export const subscriptionNotFound = () => err(notFoundError('subscription_not_found', 'no such subscription'));
