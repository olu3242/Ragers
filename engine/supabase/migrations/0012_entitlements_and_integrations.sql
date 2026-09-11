-- Phases 48–49: organization entitlements and governed outbound delivery.
--
-- Additive.

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 48 — entitlements
--
-- The non-negotiable, restated as schema: **payment buys reads, and nothing else.**
--
-- Note what this table does not have. There is no priority_boost, no moderation_tier, no
-- visibility_multiplier, no suppression_allowance — not set to zero, *absent*. A column that
-- exists at zero is one ALTER away from being non-zero, and the roadmap's requirement is that
-- the integrity layer have no input for entitlement at all, so there is nothing to switch.
--
-- `features` is a list of read capabilities: which reports an organization may open. Every
-- figure behind them is computed identically for every organization, paid or not, and a
-- static test asserts that no integrity module so much as references the entitlement module.
-- ─────────────────────────────────────────────────────────────────────────
create type plan_tier as enum ('none', 'basic', 'professional');

create table organization_entitlements (
  organization_id text primary key references organization_profiles (id) on delete cascade,
  tier            plan_tier not null default 'none',
  -- Read capabilities only, e.g. 'benchmark_reports'. Never anything that decides an outcome.
  features        text[] not null default '{}',
  updated_at      timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 49 — integrations
--
-- A webhook is a leased job with retries and a dead-letter queue, not a best-effort HTTP
-- call, so delivery is a consumer over the existing outbox and every attempt is a row.
-- ─────────────────────────────────────────────────────────────────────────
create table integration_subscriptions (
  id              text primary key,
  organization_id text not null references organization_profiles (id) on delete cascade,
  -- https only: plain HTTP would put the payload and the signature on the wire in clear.
  endpoint_url    text not null check (endpoint_url like 'https://%'),
  events          text[] not null default '{}',
  -- Never returned by any read path. Used only to sign, and long enough that a signature
  -- cannot be forged: a short secret is a signature anybody can produce.
  secret          text not null check (length(secret) >= 32),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  constraint subscriptions_events_present check (cardinality(events) > 0)
);
create index subscriptions_org_idx on integration_subscriptions (organization_id) where is_active;

create table integration_deliveries (
  id              text primary key,
  subscription_id text not null references integration_subscriptions (id) on delete cascade,
  organization_id text not null references organization_profiles (id) on delete cascade,
  -- The outbox event this delivery is for. With (subscription_id, outbox_id) unique, a replay
  -- finds the row and sends nothing — which is how "replay does not duplicate effects" is
  -- enforced rather than hoped for under at-least-once delivery.
  outbox_id       text not null,
  event           text not null,
  signature       text not null,
  -- The exact bytes signed and sent, so a dispute about a delivery is settleable rather than
  -- a matter of reconstructing what the payload probably was.
  body            text not null,
  state           text not null default 'pending' check (state in ('pending', 'sent', 'failed')),
  attempt_count   integer not null default 0 check (attempt_count >= 0),
  sent_at         timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  constraint deliveries_one_per_event unique (subscription_id, outbox_id),
  -- A delivery marked sent must say when. Claiming a send with no timestamp would make the
  -- audit trail unfalsifiable.
  constraint deliveries_sent_has_time check (state <> 'sent' or sent_at is not null)
);
create index deliveries_org_idx on integration_deliveries (organization_id, created_at desc);
create index deliveries_pending_idx on integration_deliveries (created_at) where state <> 'sent';

-- ─────────────────────────────────────────────────────────────────────────
-- Access
-- ─────────────────────────────────────────────────────────────────────────
alter table organization_entitlements  enable row level security;
alter table integration_subscriptions  enable row level security;
alter table integration_deliveries     enable row level security;

-- An organization may see its own plan. It may not set one: that is an operator action, and
-- an organization that could set its own tier would be buying its own entitlements.
create policy entitlements_read_member on organization_entitlements for select
  using (
    is_staff()
    or exists (
      select 1 from organization_memberships m
      where m.organization_id = organization_entitlements.organization_id
        and m.actor_id = current_actor_id()
        and m.revoked_at is null
    )
  );
create policy entitlements_staff on organization_entitlements for all
  using (is_staff()) with check (is_staff());

-- A subscription is visible to its own organization's live members. The `secret` column is
-- reachable by the row's owner, which is why no read path in the engine returns it — see
-- `publicSubscriptionView`.
create policy subscriptions_member on integration_subscriptions for all
  using (
    is_staff()
    or exists (
      select 1 from organization_memberships m
      where m.organization_id = integration_subscriptions.organization_id
        and m.actor_id = current_actor_id()
        and m.revoked_at is null
    )
  )
  with check (
    exists (
      select 1 from organization_memberships m
      where m.organization_id = integration_subscriptions.organization_id
        and m.actor_id = current_actor_id()
        and m.revoked_at is null
    )
  );

-- Tenant isolation, at the database. A hostile tenant reading this table sees only its own
-- deliveries even if the application forgets a filter.
create policy deliveries_member on integration_deliveries for select
  using (
    is_staff()
    or exists (
      select 1 from organization_memberships m
      where m.organization_id = integration_deliveries.organization_id
        and m.actor_id = current_actor_id()
        and m.revoked_at is null
    )
  );
create policy deliveries_staff on integration_deliveries for all
  using (is_staff()) with check (is_staff());

grant all on organization_entitlements, integration_subscriptions, integration_deliveries
  to service_role;
grant select on organization_entitlements to authenticated;
grant select, insert, update on integration_subscriptions to authenticated;
grant select on integration_deliveries to authenticated;
