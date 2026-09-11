-- Phases 36–40: resolution evidence, sample floors, benchmark-safe aggregation, and
-- the governed intelligence handoff.
--
-- Additive only. Most of this band is derived-on-read rather than stored, which is
-- why this migration is small: a stored median is wrong the moment nobody recomputes
-- it, and a stored aggregate is a re-identification risk sitting on disk.

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 37 — evidence for a report of the outcome
--
-- `dispute_id` already exists (0007). This adds the fourth and last parent: the
-- resolution report. Somebody saying "they fixed it" or "they did not" can now show
-- what they are talking about, and the organization cannot touch it.
--
-- The one-parent rule is replaced rather than loosened, again, so a row can still only
-- ever hang off one thing.
-- ─────────────────────────────────────────────────────────────────────────
alter table evidence
  add column resolution_report_id text references resolution_reports (id) on delete cascade;

alter table evidence drop constraint evidence_has_one_parent;
alter table evidence add constraint evidence_has_one_parent check (
  (case when experience_id        is not null then 1 else 0 end)
  + (case when corroboration_id     is not null then 1 else 0 end)
  + (case when dispute_id           is not null then 1 else 0 end)
  + (case when resolution_report_id is not null then 1 else 0 end) = 1
);
create index evidence_report_idx on evidence (resolution_report_id) where resolution_report_id is not null;

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 40 — the handoff ledger
--
-- A handoff is a record that governed state was offered to the intelligence layer,
-- and which proposal it produced. It exists so a reviewer can ask "why am I being
-- shown this?" and get an answer that points at rows, and so the same governed
-- condition does not generate a second proposal every time a sweep runs.
--
-- It stores no recommendation of its own. The proposal lives in
-- `intelligence_proposals`, under the E12 contract that already refuses one without
-- traceable evidence — and approving that proposal dispatches the target engine's own
-- command rather than writing any E1–E11 table.
-- ─────────────────────────────────────────────────────────────────────────
create table intelligence_handoffs (
  id             text primary key,
  -- What governed condition was handed off, e.g. 'critical_unresolved'.
  trigger_id     text not null,
  subject_id     text not null,
  proposal_id    text references intelligence_proposals (id) on delete set null,
  created_at     timestamptz not null default now(),
  -- One handoff per (condition, subject): a sweep that runs hourly must not produce
  -- twenty-four proposals about the same thing.
  constraint handoffs_one_per_subject unique (trigger_id, subject_id)
);
create index handoffs_subject_idx on intelligence_handoffs (subject_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Access
-- ─────────────────────────────────────────────────────────────────────────
alter table intelligence_handoffs enable row level security;

-- Internal, for the same reason proposals are: this describes what a machine noticed
-- about somebody, which is not a public matter.
create policy handoffs_staff on intelligence_handoffs for all
  using (is_staff()) with check (is_staff());

grant all on intelligence_handoffs to service_role;
