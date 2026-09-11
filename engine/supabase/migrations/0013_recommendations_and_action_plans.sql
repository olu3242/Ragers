-- Phases 58–59: proactive recommendations and governed action plans.
--
-- Additive.

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 58 — recommendations
--
-- A ledger, not a store of advice. The recommendation itself is an `intelligence_proposals`
-- row and stays there, under the contract that refuses a proposal with no traceable basis.
-- What this table holds is the *fact that a conclusion was already recommended*, keyed on
-- what the conclusion is about rather than on when it was drawn — so a sweep that runs
-- hourly over unchanged state produces one recommendation and not twenty-four.
--
-- The primary key is that key. Two concurrent sweeps reaching the same conclusion collide
-- on it, and the loser creates nothing: the same mechanism the handoff ledger uses, for the
-- same reason. `proposal_id` is nullable because a conclusion whose proposal was refused
-- leaves the honest state — noticed, and produced nothing a reviewer can act on.
-- ─────────────────────────────────────────────────────────────────────────
create table recommendations (
  -- kind|subject|sorted experience ids. Deterministic, so it is the collision point.
  id                text primary key,
  kind              text not null,
  subject_id        text not null,
  -- The experiences the conclusion spans. At least two, checked here as well as in the
  -- domain: a "pattern" over one account is that account with a bigger word attached.
  across_experience_ids text[] not null,
  distinct_people   integer not null check (distinct_people >= 2),
  -- The lifecycle state the conclusion was drawn under, recorded so a reader can tell a
  -- statement about a live pattern from one about a stabilising one.
  lifecycle_state   text not null check (lifecycle_state in ('emerging', 'active', 'stabilizing', 'resolved')),
  proposal_id       text references intelligence_proposals (id) on delete set null,
  created_at        timestamptz not null default now(),
  constraint recommendations_span_two check (cardinality(across_experience_ids) >= 2)
);
create index recommendations_subject_idx on recommendations (subject_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 59 — governed action plans
--
-- The first thing in this product that runs more than one governed action from one
-- approval, so the schema is shaped by what must not happen.
--
-- **A plan has no write of its own.** There is no column here that names an E1–E11 row it
-- changed, because a step's effect belongs to the engine that owns it. What a step records
-- is whether the *dispatch* happened and what refused it.
--
-- **Partial failure is a first-class outcome, not an error state.** `partially_completed`
-- is a normal status, and `completed` requires every step to have dispatched — enforced by
-- constraint rather than by whoever writes the row next. A plan reported complete because
-- it was approved is the failure this table exists to make impossible.
-- ─────────────────────────────────────────────────────────────────────────
create table action_plans (
  id           text primary key,
  -- The proposal a reviewer approved. A plan cannot exist without one: approval is the
  -- only thing that turns a recommendation into steps.
  proposal_id  text not null references intelligence_proposals (id) on delete cascade,
  subject_id   text not null,
  -- The reviewer. A plan is attributed to the person who approved it, never to the engine.
  approved_by  text not null references actors (id) on delete cascade,
  status       text not null default 'pending'
               check (status in ('pending', 'completed', 'partially_completed', 'failed')),
  step_count   integer not null check (step_count >= 1),
  -- How many steps actually dispatched. The number `completed` is checked against.
  dispatched_count integer not null default 0 check (dispatched_count >= 0),
  created_at   timestamptz not null default now(),
  executed_at  timestamptz,
  constraint plans_dispatched_within_steps check (dispatched_count <= step_count),
  -- Completed means every step dispatched. Nothing else may claim it.
  constraint plans_completed_is_total check (status <> 'completed' or dispatched_count = step_count),
  -- And a plan that says it ran must say when.
  constraint plans_executed_has_time check (status = 'pending' or executed_at is not null)
);
create index plans_proposal_idx on action_plans (proposal_id);
create index plans_subject_idx on action_plans (subject_id, created_at desc);

create table action_plan_steps (
  id            text primary key,
  plan_id       text not null references action_plans (id) on delete cascade,
  step_order    integer not null check (step_order >= 1),
  -- The command the owning engine will run, dispatched on the bus like any other.
  command       text not null,
  input         jsonb not null default '{}'::jsonb,
  target_engine text not null,
  dispatched    boolean not null default false,
  -- The owning engine's own refusal, kept verbatim: a step the engine declined is not a
  -- step that happened, and paraphrasing it would lose why.
  dispatch_error text,
  executed_at   timestamptz,
  constraint steps_one_per_order unique (plan_id, step_order),
  -- A step cannot be both dispatched and refused. One of the two, or neither yet.
  constraint steps_not_both check (not (dispatched and dispatch_error is not null)),
  constraint steps_executed_has_time check ((not dispatched and dispatch_error is null) or executed_at is not null)
);
create index steps_plan_idx on action_plan_steps (plan_id, step_order);

-- ─────────────────────────────────────────────────────────────────────────
-- Access
--
-- All three are operator surfaces. A recommendation names other people's experiences, and
-- a plan is a record of governed action taken on them, so neither is readable by the
-- people it concerns — the *effects* are visible where they belong, on the experience.
-- ─────────────────────────────────────────────────────────────────────────
alter table recommendations    enable row level security;
alter table action_plans       enable row level security;
alter table action_plan_steps  enable row level security;

create policy recommendations_staff on recommendations for all
  using (is_staff()) with check (is_staff());
create policy plans_staff on action_plans for all
  using (is_staff()) with check (is_staff());
create policy plan_steps_staff on action_plan_steps for all
  using (is_staff()) with check (is_staff());

grant all on recommendations, action_plans, action_plan_steps to service_role;
