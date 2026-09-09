-- Phase 21 — distributed orchestration.
--
-- Delivery becomes a durable, leased job rather than an in-process callback.
-- A job is held by exactly one worker for a bounded time; when that worker dies
-- the lease lapses and another worker resumes the job with its attempt count and
-- checkpoint intact. That is what makes restart recovery a property of the
-- system rather than of a process staying alive.

create type job_state as enum (
  'queued',
  'leased',
  'running',
  'waiting',
  'retrying',
  'completed',
  'failed',
  'dead_letter'
);

-- ─────────────────────────────────────────────────────────────────────────
-- Workers
-- ─────────────────────────────────────────────────────────────────────────
create table workers (
  id                text primary key,
  hostname          text not null,
  started_at        timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  state             text not null default 'alive' check (state in ('alive','draining','dead'))
);
-- Finding stale workers is the hot path for reaping, so index the heartbeat.
create index workers_heartbeat_idx on workers (last_heartbeat_at) where state <> 'dead';

-- ─────────────────────────────────────────────────────────────────────────
-- Leases and checkpoints on the delivery ledger
-- ─────────────────────────────────────────────────────────────────────────
alter table event_deliveries
  -- 'processing' becomes 'running' and 'ready' becomes 'completed'; the richer
  -- vocabulary distinguishes a lease from execution and a retry from a failure.
  alter column state drop default,
  alter column state type job_state using (
    case state::text
      when 'processing' then 'running'
      when 'ready'      then 'completed'
      else state::text
    end
  )::job_state,
  alter column state set default 'queued'::job_state;

alter table event_deliveries
  add column lease_owner  text references workers(id) on delete set null,
  add column leased_until timestamptz,
  add column checkpoint   jsonb not null default '{}'::jsonb,
  add column causation_id text;

-- Claiming reads "the jobs nobody holds, or whose holder has gone quiet".
create index event_deliveries_claimable_idx on event_deliveries (next_attempt_at)
  where state in ('queued','retrying','failed');
create index event_deliveries_lease_idx on event_deliveries (leased_until)
  where state in ('leased','running');

-- A held job must name its holder, and an unheld job must not.
alter table event_deliveries
  add constraint lease_matches_state check (
    (state in ('leased','running') and lease_owner is not null and leased_until is not null)
    or state not in ('leased','running')
  );

-- ─────────────────────────────────────────────────────────────────────────
-- Execution history — append-only, so an operator can reconstruct a run
-- ─────────────────────────────────────────────────────────────────────────
create table job_history (
  id          text primary key default gen_random_uuid()::text,
  delivery_id text not null,
  attempt     int not null,
  state       job_state not null,
  worker_id   text,
  detail      text,
  at          timestamptz not null default now()
);
create index job_history_delivery_idx on job_history (delivery_id, at);

-- ─────────────────────────────────────────────────────────────────────────
-- Causation on the outbox, completing the event envelope
-- ─────────────────────────────────────────────────────────────────────────
alter table outbox add column causation_id text;
create index outbox_correlation_idx on outbox (correlation_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Access
--
-- These are worker-owned tables. RLS is enabled with no client policies, and no
-- client grants are issued, so only the service role can touch them.
-- ─────────────────────────────────────────────────────────────────────────
alter table workers     enable row level security;
alter table job_history enable row level security;

create policy workers_admin_read on workers for select using (is_admin());
create policy job_history_admin_read on job_history for select using (is_admin());

grant all on workers, job_history to service_role;
grant select on workers, job_history to authenticated;

-- job_history is a record of what happened; nothing may rewrite it.
do $$
declare
  client_role text;
begin
  foreach client_role in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = client_role) then
      execute format('revoke insert, update, delete on job_history from %I', client_role);
      execute format('revoke all on workers from %I', client_role);
      execute format('grant select on workers to %I', client_role);
    end if;
  end loop;
end $$;
