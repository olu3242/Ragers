-- Phases 31–35: structured enrichment, severity classification, escalation, and
-- organization case management.
--
-- Additive only. Nothing certified is altered in place.
--
-- The through-line: everything here is either *what a person asserted* or *what the
-- event log already says*. No table in this migration stores an inference about a
-- person, and no table in it gives an organization a write path to an experience.

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 31 — structured experience enrichment (E1)
--
-- One row per experience, holding the dimensions the experiencer asserted. The
-- `provenance` inside each value is what separates an assertion from an extraction,
-- and every reader downstream filters on it. Extraction is stored so the person can
-- confirm it, and is inert until they do — the same rule `experience_metadata`
-- already holds for entity and issue type.
--
-- `fingerprint` is a content hash for near-duplicate detection. It is an input to
-- review and never an action: nothing suppresses, hides or deletes on a match,
-- because somebody re-posting a corrected account would otherwise disappear.
-- ─────────────────────────────────────────────────────────────────────────
create table experience_enrichments (
  id            text primary key,
  experience_id text not null unique references experiences (id) on delete cascade,
  -- The asserted values, each carrying its own dimension, provenance and author.
  -- JSONB rather than a row per dimension because a dimension is only ever read as
  -- part of the whole picture, and a partial read would understate severity.
  values        jsonb not null default '[]'::jsonb,
  fingerprint   text not null,
  correlation_id text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Near-duplicate lookup. Not unique: two people may legitimately have identical
-- accounts of the same failure, and a unique index would refuse the second person.
create index enrichments_fingerprint_idx on experience_enrichments (fingerprint);

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 32 — severity classification (E8)
--
-- A named band, not a score. Four steps a person can reason about, stored with the
-- `basis` that produced them so an organization reading "serious" can see why rather
-- than argue with a number.
--
-- `unassessed` is load-bearing. An experience with nothing asserted has to carry
-- *some* band, and it carries `minor`; `unassessed` is what stops a reader treating
-- that default as a finding about the experience.
-- ─────────────────────────────────────────────────────────────────────────
create type severity_band as enum ('minor', 'significant', 'serious', 'critical');

create table experience_severities (
  id            text primary key,
  experience_id text not null unique references experiences (id) on delete cascade,
  band          severity_band not null,
  -- Share of dimensions the person answered. Not a probability, and never rendered
  -- as one.
  confidence    numeric(5,3) not null check (confidence >= 0 and confidence <= 1),
  basis         text[] not null default '{}',
  independent_experiencers integer not null default 0 check (independent_experiencers >= 0),
  unassessed    boolean not null default true,
  classified_at timestamptz not null default now()
);
create index severities_band_idx on experience_severities (band) where unassessed = false;

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 34 — escalation (E10)
--
-- Escalation opens a review. It is not a sanction, applies nothing, hides nothing,
-- and changes no resolution state — there is deliberately no column here that could
-- express any of those.
--
-- The unique constraint is the idempotence guarantee: one row per (experience, rule),
-- so a nightly sweep over the same condition enqueues nothing new instead of burying
-- the queue in duplicates of one case.
-- ─────────────────────────────────────────────────────────────────────────
create table experience_escalations (
  id            text primary key,
  experience_id text not null references experiences (id) on delete cascade,
  rule_id       text not null,
  -- In the words the operator reads, with the values that satisfied the rule.
  because       text not null,
  queue_item_id text references moderation_queue (id) on delete set null,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  constraint escalations_one_per_rule unique (experience_id, rule_id)
);
create index escalations_open_idx on experience_escalations (created_at desc) where resolved_at is null;

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 35 — organization case management (E9)
--
-- A case is the organization's own workspace over an experience, and confers no
-- authority over it. That is why it is a separate table with its own state machine
-- rather than columns on `experiences`.
--
-- The vocabulary is deliberately different from resolution's: a case is `closed`,
-- never `resolved`. Closing a case resolves nothing, and there is no path from any
-- state here to `experiences.resolution_status`.
-- ─────────────────────────────────────────────────────────────────────────
create type case_state as enum ('new', 'triaged', 'in_progress', 'awaiting_customer', 'closed');

create table organization_cases (
  id              text primary key,
  organization_id text not null references organization_profiles (id) on delete cascade,
  experience_id   text not null references experiences (id) on delete cascade,
  state           case_state not null default 'new',
  assignee_id     text references actors (id) on delete set null,
  opened_at       timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  closed_at       timestamptz,
  closure_note    text,
  correlation_id  text not null,
  -- One case per organization per experience: two staff opening a case on the same
  -- complaint must land on one workspace, not two divergent ones.
  constraint cases_one_per_experience unique (organization_id, experience_id),
  -- Closing requires an account of what was done. A case closed with no note leaves
  -- the person it happened to nothing to read.
  constraint cases_closure_note check (state <> 'closed' or (closure_note is not null and length(closure_note) > 0))
);
create index cases_open_idx on organization_cases (organization_id, updated_at desc) where state <> 'closed';
create index cases_assignee_idx on organization_cases (assignee_id) where assignee_id is not null;

-- ─────────────────────────────────────────────────────────────────────────
-- Access
-- ─────────────────────────────────────────────────────────────────────────
alter table experience_enrichments  enable row level security;
alter table experience_severities   enable row level security;
alter table experience_escalations  enable row level security;
alter table organization_cases      enable row level security;

-- Enrichment is the experiencer's own account of what it cost them. They read and
-- write their own; staff read all. It is not public: "lost £2,400" beside a named
-- person is a detail a reader does not need in order to understand the experience.
create policy enrichments_read_own on experience_enrichments for select
  using (
    is_staff()
    or exists (
      select 1 from experiences e
      where e.id = experience_enrichments.experience_id and e.actor_id = current_actor_id()
    )
  );
create policy enrichments_write_own on experience_enrichments for all
  using (
    exists (
      select 1 from experiences e
      where e.id = experience_enrichments.experience_id and e.actor_id = current_actor_id()
    )
  )
  with check (
    exists (
      select 1 from experiences e
      where e.id = experience_enrichments.experience_id and e.actor_id = current_actor_id()
    )
  );
create policy enrichments_staff on experience_enrichments for all
  using (is_staff()) with check (is_staff());

-- The band is readable: it is how a reader tells a serious failure from an annoyance,
-- and it carries no personal detail. The dimensions that produced it stay in
-- `experience_enrichments`, which does not.
create policy severities_read on experience_severities for select using (true);
create policy severities_staff on experience_severities for all
  using (is_staff()) with check (is_staff());

-- Escalations are internal: they describe an operational decision to look at
-- something, and publishing them would let anyone infer moderation thresholds.
create policy escalations_staff on experience_escalations for all
  using (is_staff()) with check (is_staff());

-- A case is visible to the organization's own live members and to staff. A revoked
-- membership confers nothing, which is why `revoked_at is null` appears in both the
-- read and the write check rather than only in the read.
create policy cases_read_member on organization_cases for select
  using (
    is_staff()
    or exists (
      select 1 from organization_memberships m
      where m.organization_id = organization_cases.organization_id
        and m.actor_id = current_actor_id()
        and m.revoked_at is null
    )
  );
create policy cases_write_member on organization_cases for all
  using (
    exists (
      select 1 from organization_memberships m
      where m.organization_id = organization_cases.organization_id
        and m.actor_id = current_actor_id()
        and m.revoked_at is null
    )
  )
  with check (
    exists (
      select 1 from organization_memberships m
      where m.organization_id = organization_cases.organization_id
        and m.actor_id = current_actor_id()
        and m.revoked_at is null
    )
  );
create policy cases_staff on organization_cases for all
  using (is_staff()) with check (is_staff());

grant all on experience_enrichments, experience_severities, experience_escalations,
             organization_cases
  to service_role;
grant select on experience_severities to anon, authenticated;
grant select, insert, update on experience_enrichments to authenticated;
grant select, insert, update on organization_cases to authenticated;
