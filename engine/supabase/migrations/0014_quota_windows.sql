-- Phase 61: request governance and quotas.
--
-- Additive.
--
-- `rate_limited` has been in the error taxonomy since the runtime was written, it is one of
-- the two retryable kinds, and the API layer maps it to HTTP 429. Nothing produced it. This
-- table is what makes that contract real.
--
-- **A quota is not a judgement**, and the schema is where that is easiest to guarantee: there
-- is no column here for a reason, a severity, a suspicion or a score, and nothing references
-- this table from anywhere in the integrity layer. A throttle count that could be read by
-- trust or by priority would turn "posted quickly" into evidence, and the people most likely
-- to post quickly are the ones something is actively happening to.
--
-- One row per (actor, class), keyed on that pair. A fixed window rather than a sliding one:
-- sliding needs every request's timestamp retained, which is more data about a person's timing
-- than a throttle has any business keeping.
create table quota_windows (
  -- `actorId:class`. The natural key, so concurrent requests collide on one row rather than
  -- inserting several and undercounting.
  id                text primary key,
  actor_id          text not null references actors (id) on delete cascade,
  quota_class       text not null check (quota_class in ('identity', 'authoring', 'corroboration', 'upload', 'interaction')),
  window_started_at timestamptz not null default now(),
  count             integer not null default 0 check (count >= 0),
  constraint quota_windows_one_per_class unique (actor_id, quota_class)
);
create index quota_windows_actor_idx on quota_windows (actor_id);

alter table quota_windows enable row level security;

-- Nobody reads their own throttle state, and no organization reads anybody's. This is
-- operational bookkeeping, not a fact about a person, and exposing it would invite exactly
-- the interpretation the design refuses.
create policy quota_windows_staff on quota_windows for all
  using (is_staff()) with check (is_staff());

grant all on quota_windows to service_role;
