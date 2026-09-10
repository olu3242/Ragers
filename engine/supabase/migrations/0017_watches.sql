-- ─────────────────────────────────────────────────────────────────────────
-- Phase 78 — watching a thing
--
-- A person can follow a person today (`graph_edges`, kinds follow/block/mute against
-- actor/alias). Nobody can follow a *thing* — an experience whose outcome they want to
-- know, or a subject that keeps coming up. That is this table.
--
-- ## Why not extend graph_edges
--
-- Because a follow between people raises a question a watch does not: whether the
-- followed person sees it, and whether following is mutual. `graph_edges` answers that
-- question, and a watch would have to share the answer. The privacy rule here runs the
-- other way — the *thing* is public and the *watcher* is not — so it gets its own table
-- with its own policies rather than a fourth kind in a table whose rules were written
-- for people.
--
-- ## The privacy rule
--
-- **A count may be public. An identity never is.** Nobody may learn who is watching
-- their experience, and nobody may learn what somebody else is watching. Both directions
-- matter, and the second is the one that is easy to get wrong: a list of what somebody
-- watches is a list of the failures they are worried about, which is a profile of their
-- circumstances.
--
-- Enforced three ways, because one is not enough for a rule this shaped:
--   * RLS: a row is selectable only by the actor who created it.
--   * No grant on the table to `anon` at all — a signed-out visitor cannot read a watch
--     row even in principle.
--   * The count is served by a `security definer` function rather than by a permissive
--     policy, so "how many people are watching" never becomes "which rows exist".
-- ─────────────────────────────────────────────────────────────────────────

create type watch_target as enum ('experience', 'subject');

create table experience_watches (
  id          text primary key default gen_random_uuid()::text,
  actor_id    text not null references actors (id) on delete cascade,
  target_type watch_target not null,
  target_id   text not null,
  created_at  timestamptz not null default now(),
  -- Watching twice is watching. The unique constraint is what makes the command idempotent
  -- rather than the handler remembering to check first — the same lesson the corroboration
  -- check, the review queue and the agent runner each taught in turn.
  constraint watches_one_per_target unique (actor_id, target_type, target_id)
);

-- The count read wants (target_type, target_id); the "what am I watching" read wants
-- (actor_id). Both are hot enough to index.
create index watches_target_idx on experience_watches (target_type, target_id);
create index watches_actor_idx on experience_watches (actor_id, created_at desc);

-- Deliberately no foreign key on `target_id`. It points at either an experience or a
-- subject depending on `target_type`, and Postgres cannot express a conditional reference.
-- The consequence is handled rather than ignored: Phase 78's consumer removes watches when
-- their target goes, and the read re-checks the target's status anyway — which it would
-- have to do regardless, because a cascade cannot tell "deleted" from "hidden".

alter table experience_watches enable row level security;

-- A watcher reads their own rows and nobody else's. There is no staff policy either: an
-- operator has no reason to know who is watching what, and the absence of the policy is
-- what makes that true rather than a convention.
create policy watches_own on experience_watches for select
  using (actor_id = current_actor_id());

create policy watches_own_write on experience_watches for insert
  with check (actor_id = current_actor_id());

create policy watches_own_delete on experience_watches for delete
  using (actor_id = current_actor_id());

-- `authenticated` only. `anon` gets no grant at all, so a signed-out visitor cannot read a
-- watch row even if a policy were later written carelessly.
grant select, insert, delete on experience_watches to authenticated;
grant all on experience_watches to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- The public count
--
-- `security definer` so it can count rows the caller cannot select. This is the whole
-- reason it is a function rather than a view over a permissive policy: a policy that let
-- anybody count would let anybody enumerate, because a count filtered by a predicate is an
-- oracle. Here the caller gets one integer and no way to ask about a particular person.
--
-- `search_path` is pinned, per the same rule the other definer functions follow: a definer
-- function with a mutable search path is a privilege escalation waiting for somebody to
-- create a table with the right name.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function watch_count(p_target_type watch_target, p_target_id text)
  returns integer
  language sql
  security definer
  set search_path = public, pg_temp
  stable
as $$
  select count(*)::integer from experience_watches
   where target_type = p_target_type and target_id = p_target_id;
$$;

grant execute on function watch_count(watch_target, text) to anon, authenticated;
