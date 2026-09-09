-- Engine contract gaps: formal dispute (E10), Relate (E6), responsiveness (E11),
-- and governed intelligence proposals (E12).
--
-- Additive only. Nothing certified is altered in place.

-- ─────────────────────────────────────────────────────────────────────────
-- E10 — formal dispute
--
-- A dispute is its own object, not a value of `resolution_status`. The existing
-- `disputed` status says the accounts differ; it cannot say who raised it, on what
-- grounds, with what evidence, or whether it was withdrawn — and it cannot stop
-- the disputed party closing it. Those are the reasons this table exists.
--
-- The distinctions the product depends on, restated as data:
--   * rejecting a proposed fix is a resolution *report* (`still_unresolved`);
--   * disputing is a claim that an account is untrue;
--   * neither is `unresolved`, and neither is `resolved`.
-- ─────────────────────────────────────────────────────────────────────────
create type dispute_status as enum (
  'open',
  'under_review',
  'upheld',
  'declined',
  'withdrawn'
);

-- Who raised it. A consumer disputes an organization's account; an organization
-- disputes an experience. Both are legitimate and they are not the same act.
create type dispute_origin as enum ('experiencer', 'organization');

create type dispute_reason as enum (
  'account_inaccurate',
  'not_our_organization',
  'already_resolved',
  'fix_not_delivered',
  'response_misleading',
  'wrong_entity',
  'other'
);

create table experience_disputes (
  id              text primary key default gen_random_uuid()::text,
  experience_id   text not null references experiences(id) on delete cascade,
  -- Set when the dispute is about a specific organization response rather than
  -- the experience as a whole.
  response_id     text references organization_responses(id) on delete set null,
  origin          dispute_origin not null,
  raised_by       text not null references actors(id) on delete cascade,
  -- The organization on whose behalf it was raised, when origin is organization.
  organization_id text references organization_profiles(id) on delete set null,
  reason          dispute_reason not null,
  detail          text check (detail is null or char_length(detail) <= 2000),
  status          dispute_status not null default 'open',
  -- Only an operator may uphold or decline. Recorded so the decision is attributable.
  reviewed_by     text references actors(id) on delete set null,
  reviewed_at     timestamptz,
  review_note     text,
  withdrawn_at    timestamptz,
  -- Set when the dispute is settled by an outcome rather than by review.
  resolution_event_id text references resolution_events(id) on delete set null,
  correlation_id  text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- One open dispute per party per experience. Without this, a party could file
  -- the same grievance repeatedly and make a contested experience look contested
  -- many times over.
  constraint dispute_is_attributed check (
    (origin = 'organization' and organization_id is not null)
    or (origin = 'experiencer' and organization_id is null)
  ),
  constraint dispute_review_is_dated check (
    (status in ('upheld','declined') and reviewed_by is not null and reviewed_at is not null)
    or status not in ('upheld','declined')
  ),
  constraint dispute_withdrawal_is_dated check (
    (status = 'withdrawn' and withdrawn_at is not null) or status <> 'withdrawn'
  )
);

-- One *open* dispute per raiser per experience; settled ones may accumulate,
-- because the history of contested claims is itself the record.
create unique index disputes_one_open_per_raiser
  on experience_disputes (experience_id, raised_by)
  where status in ('open', 'under_review');

create index disputes_experience_idx on experience_disputes (experience_id);
create index disputes_status_idx on experience_disputes (status) where status in ('open','under_review');

-- Evidence attaches to a dispute exactly as it attaches to an experience or a
-- corroboration: through the evidence table, never inline.
alter table evidence
  add column dispute_id text references experience_disputes(id) on delete cascade;

-- The one-parent rule now admits a third parent. Replaced rather than loosened so
-- a row can still only ever hang off one thing.
alter table evidence drop constraint evidence_has_one_parent;
alter table evidence add constraint evidence_has_one_parent check (
  (case when experience_id    is not null then 1 else 0 end)
  + (case when corroboration_id is not null then 1 else 0 end)
  + (case when dispute_id      is not null then 1 else 0 end) = 1
);
create index evidence_dispute_idx on evidence (dispute_id) where dispute_id is not null;

-- ─────────────────────────────────────────────────────────────────────────
-- E6 — Relate
--
-- An actor asserting that two experiences are the same or related occurrence.
-- Distinct from corroboration, which is a claim about the actor's *own*
-- experience: Relate is a claim about the relationship between two accounts, and
-- the person relating them need not have experienced either.
--
-- Because of that difference it deliberately carries no weight in trust,
-- confidence or corroboration counts. It is a discovery and clustering signal.
-- ─────────────────────────────────────────────────────────────────────────
create type relation_assertion as enum (
  'same_occurrence',
  'same_pattern',
  'related_context'
);

create table experience_relations (
  id            text primary key default gen_random_uuid()::text,
  -- Ordered pair. The engine canonicalises the order so relating A→B and B→A is
  -- one assertion, not two.
  from_experience_id text not null references experiences(id) on delete cascade,
  to_experience_id   text not null references experiences(id) on delete cascade,
  asserted_by   text not null references actors(id) on delete cascade,
  assertion     relation_assertion not null default 'same_pattern',
  note          text check (note is null or char_length(note) <= 500),
  -- Retraction keeps the row, exactly as a corroboration retraction does, so
  -- aggregates recompute and the history survives.
  status        text not null default 'active' check (status in ('active','retracted','removed')),
  retracted_at  timestamptz,
  correlation_id text not null,
  created_at    timestamptz not null default now(),

  -- One assertion per person per pair. This is what stops raw engagement
  -- manufacturing an apparent connection between two accounts.
  unique (from_experience_id, to_experience_id, asserted_by),
  constraint relation_is_between_two check (from_experience_id <> to_experience_id),
  constraint relation_retraction_is_dated check (
    (status = 'retracted' and retracted_at is not null) or status <> 'retracted'
  )
);
create index relations_from_idx on experience_relations (from_experience_id) where status = 'active';
create index relations_to_idx on experience_relations (to_experience_id) where status = 'active';

-- ─────────────────────────────────────────────────────────────────────────
-- E11 — responsiveness
--
-- Recomputed from rows like every other counter, never incremented. Named
-- `responsiveness` rather than `sla`: no service-level agreement exists, and
-- calling a platform measurement an SLA would assert a commitment nobody made.
-- ─────────────────────────────────────────────────────────────────────────
create table responsiveness_snapshots (
  organization_id      text primary key references organization_profiles(id) on delete cascade,
  cases_total          int not null default 0,
  cases_answered       int not null default 0,
  cases_confirmed_resolved int not null default 0,
  cases_open           int not null default 0,
  -- Milliseconds. Null where there is nothing to measure yet, which is different
  -- from zero and must stay distinguishable.
  median_acknowledgement_ms bigint,
  median_first_response_ms  bigint,
  median_resolution_ms      bigint,
  oldest_open_ms       bigint,
  response_rate        numeric(5,4) not null default 0,
  resolution_rate      numeric(5,4) not null default 0,
  -- How many cases the medians are computed from, so a figure derived from two
  -- cases cannot be read as a track record.
  sample_size          int not null default 0,
  computed_at          timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- E12 — governed intelligence proposals
--
-- A proposal is a *request* for a governed engine to do something. It carries no
-- authority: approving one dispatches the target engine's own command, through the
-- same command bus, authorization and outbox as any other write. There is
-- deliberately no column on any E1–E11 table that a proposal can set.
-- ─────────────────────────────────────────────────────────────────────────
create type proposal_status as enum (
  'proposed',
  'approved',
  'rejected',
  'escalated',
  'expired'
);

create table intelligence_proposals (
  id             text primary key default gen_random_uuid()::text,
  proposal_type  text not null,
  -- Which engine produced it and which engine would have to act.
  source_engine  text not null,
  target_engine  text not null,
  subject_id     text not null,
  summary        text not null check (char_length(summary) between 1 and 500),
  -- Why, in terms a reviewer can check against the evidence refs.
  rationale      text not null check (char_length(rationale) between 1 and 2000),
  confidence     numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  -- References to durable rows the reviewer can open. Never inline content.
  evidence_refs  jsonb not null default '[]'::jsonb,
  status         proposal_status not null default 'proposed',
  -- The command the target engine would run if approved, recorded up front so a
  -- reviewer approves a specific action rather than a sentiment.
  proposed_command text,
  proposed_input jsonb not null default '{}'::jsonb,
  reviewed_at    timestamptz,
  reviewed_by    text references actors(id) on delete set null,
  review_note    text,
  -- Set when approval actually dispatched the target command, so an approval that
  -- failed downstream is distinguishable from one that took effect.
  dispatched_at  timestamptz,
  dispatch_error text,
  expires_at     timestamptz,
  correlation_id text not null,
  created_at     timestamptz not null default now(),

  constraint proposal_review_is_attributed check (
    (status in ('approved','rejected','escalated') and reviewed_by is not null and reviewed_at is not null)
    or status not in ('approved','rejected','escalated')
  )
);
create index proposals_status_idx on intelligence_proposals (status) where status = 'proposed';
create index proposals_subject_idx on intelligence_proposals (subject_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Access
-- ─────────────────────────────────────────────────────────────────────────
alter table experience_disputes       enable row level security;
alter table experience_relations      enable row level security;
alter table responsiveness_snapshots  enable row level security;
alter table intelligence_proposals    enable row level security;

-- A dispute is public in the sense that a viewer should know an account is
-- contested. The *reason detail* is not: it can quote either party at length.
create view experience_disputes_public with (security_invoker = false) as
  select id, experience_id, response_id, origin, reason, status, created_at
  from experience_disputes
  where status in ('open','under_review','upheld','declined');

create policy disputes_read_own on experience_disputes for select
  using (raised_by = current_actor_id() or is_staff());
create policy disputes_insert_self on experience_disputes for insert
  with check (raised_by = current_actor_id());
-- Withdrawal is the only self-service update; upholding and declining are staff
-- decisions, and the disputed party has no update path at all.
create policy disputes_withdraw_own on experience_disputes for update
  using (raised_by = current_actor_id()) with check (raised_by = current_actor_id());
create policy disputes_staff on experience_disputes for all
  using (is_staff()) with check (is_staff());

create policy relations_read on experience_relations for select using (status = 'active' or is_staff());
create policy relations_insert_self on experience_relations for insert
  with check (asserted_by = current_actor_id());
create policy relations_update_own on experience_relations for update
  using (asserted_by = current_actor_id()) with check (asserted_by = current_actor_id());

-- Responsiveness is shown to anyone: an organization's answering record is part of
-- what a reader is entitled to know.
create policy responsiveness_read on responsiveness_snapshots for select using (true);

-- Proposals are internal. They describe what a machine suggested about somebody,
-- which is not a public matter.
create policy proposals_staff on intelligence_proposals for all
  using (is_staff()) with check (is_staff());

grant all on experience_disputes, experience_relations, responsiveness_snapshots,
             intelligence_proposals
  to service_role;
grant select on experience_disputes_public, responsiveness_snapshots to anon, authenticated;
grant select, insert, update on experience_relations to authenticated;
grant select, insert, update on experience_disputes to authenticated;
grant select on intelligence_proposals to authenticated;

do $$
declare
  client_role text;
begin
  foreach client_role in array array['anon','authenticated'] loop
    if not exists (select 1 from pg_roles where rolname = client_role) then
      continue;
    end if;
    -- A dispute and a relation are withdrawn, never deleted: the record that
    -- something was contested outlives the contest.
    execute format('revoke delete on experience_disputes, experience_relations from %I', client_role);
    -- Nothing client-side writes a derived snapshot or a proposal.
    execute format('revoke insert, update, delete on responsiveness_snapshots from %I', client_role);
    execute format('revoke insert, update, delete on intelligence_proposals from %I', client_role);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on experience_disputes, experience_relations from anon';
  end if;
end $$;
