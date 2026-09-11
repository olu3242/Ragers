-- ─────────────────────────────────────────────────────────────────────────
-- Phase 94 — human override
--
-- Every fail-closed path in this system refuses correctly, and until this table existed
-- none of them could be made to refuse **on purpose**. That is an operator-safety gap
-- rather than a correctness one: at three in the morning the question is not whether the
-- system is correct, it is whether a person can stop it.
--
-- ## Why a table rather than a config flag
--
-- A flag in the environment needs a deploy to change, and a deploy is the one thing that
-- may not be available during the incident the switch exists for. A row is changed by a
-- governed command, through the bus, against the policy matrix, with an audit row — which
-- also means the switch itself is subject to the rules everything else is.
--
-- ## What is deliberately not here
--
--   * **No wildcard scope.** `target` is `not null` and a check refuses '*', 'all', 'any'
--     and 'everything'. "Pause the agents" in one keystroke has the whole intelligence
--     layer as its blast radius, and an operator under pressure should have to name the
--     thing.
--   * **No delete.** Releasing a control sets `active` false and records who and when. The
--     history of what was paused and for how long is what an incident review needs, and a
--     delete would make the system look as though it had never been touched.
--   * **No expiry.** A control that lapsed on a timer would come back on its own while
--     everybody assumed it was still in force, which is worse than one somebody forgot to
--     release — the second is visible on the operator surface.
-- ─────────────────────────────────────────────────────────────────────────

create type control_kind as enum (
  'pause_agent',
  'disable_proposal_type',
  'refuse_pending_action',
  'suspend_integration',
  'force_degraded_mode'
);

create table operator_controls (
  -- `<kind>:<target>`. Deterministic, so the same control cannot be in force twice.
  id          text primary key,
  kind        control_kind not null,
  -- What it applies to: an agent id, a proposal type, a proposal or plan id, an integration
  -- name, or the literal 'runtime' for degraded mode. Never a wildcard.
  target      text not null check (
    length(trim(target)) > 0
    and lower(trim(target)) not in ('*', 'all', 'any', 'everything')
  ),
  active      boolean not null default true,
  -- Why, in the operator's own words. Free text belongs here, unlike in
  -- `recommendation_memory`: this is a record of a decision about a system component, not a
  -- judgement about a person, and the next operator's first question is "why is this paused".
  reason      text not null check (length(trim(reason)) > 0 and length(reason) <= 500),
  created_by  text not null references actors (id),
  created_at  timestamptz not null default now(),
  released_by text references actors (id),
  released_at timestamptz,
  -- A release has both halves or neither, so a row cannot read as released by nobody.
  constraint control_release_is_complete check (
    (released_by is null) = (released_at is null)
  ),
  -- And an active control has not been released. Without this a row could say active with a
  -- release recorded, and the read predicate would disagree with the history.
  constraint control_active_is_not_released check (not (active and released_at is not null))
);
create index operator_controls_active_idx on operator_controls (kind, active);

alter table operator_controls enable row level security;

-- Operators only, in both directions. A member being able to read which agent is paused
-- would disclose an incident in progress; being able to read *who* paused it is worse.
create policy operator_controls_admin on operator_controls for select
  using (is_admin());

grant select on operator_controls to authenticated;
grant all on operator_controls to service_role;
