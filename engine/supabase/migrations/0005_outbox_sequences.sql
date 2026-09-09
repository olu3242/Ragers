-- Per-aggregate sequence allocation for the outbox.
--
-- The original allocator was `max(sequence) + 1` read inside the same statement
-- that inserted the event. Two commands touching one aggregate at the same
-- moment — two people corroborating the same experience — both read the same
-- maximum, both wrote the same sequence, and the unique index turned one of
-- them into a conflict error the caller had done nothing to deserve. The
-- in-memory adapter never had the bug because it holds an explicit counter, so
-- the two adapters were not actually at parity under concurrency.
--
-- This gives Postgres the same explicit counter, incremented atomically in the
-- statement that inserts the event, so allocation no longer depends on reading
-- the table it is about to write.

create table outbox_sequences (
  aggregate_type text not null,
  aggregate_id   text not null,
  -- The sequence most recently handed out, not the next one to hand out: the
  -- allocator returns the value after incrementing.
  last_sequence  bigint not null,
  updated_at     timestamptz not null default now(),
  primary key (aggregate_type, aggregate_id)
);

-- Existing deployments already have events. Seed the counters from them, or the
-- first allocation after this migration would collide with what is stored.
insert into outbox_sequences (aggregate_type, aggregate_id, last_sequence)
select aggregate_type, aggregate_id, max(sequence)
from outbox
group by aggregate_type, aggregate_id
on conflict (aggregate_type, aggregate_id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────
-- Access
--
-- Runtime bookkeeping, like the outbox itself: RLS on, no client policies and
-- no client grants, so only the service role can reach it.
-- ─────────────────────────────────────────────────────────────────────────
alter table outbox_sequences enable row level security;

grant all on outbox_sequences to service_role;

do $$
declare
  client_role text;
begin
  foreach client_role in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = client_role) then
      execute format('revoke all on outbox_sequences from %I', client_role);
    end if;
  end loop;
end $$;
