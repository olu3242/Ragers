-- ─────────────────────────────────────────────────────────────────────────
-- Phase 82 — the confidence series
--
-- Confidence in a pattern moves: evidence arrives, something is contradicted, the
-- claims stop coming. Phase 81 computes the current band; this is the record of how it
-- got there, because "it is limited now" and "it was strong and fell" are different
-- facts and only the second one tells anybody anything.
--
-- ## Append-only, and computed per boundary
--
-- Each row is computed from **the whole set as of its boundary**, never by folding the
-- previous row forward. That is the Phase 56 pattern, adopted here for the same reason:
-- an accumulated series drifts the first time an event is delivered twice, and nobody
-- notices, because a series that only moves one way looks correct.
--
-- The consequence is that replay is safe by construction. Re-deriving a boundary
-- produces the identical row, so the primary key absorbs it — `(subject_id, at)` is the
-- natural key and the insert is `on conflict do nothing`. There is no counter to
-- double-apply because nothing is incremented.
--
-- ## What is deliberately not here
--
--   * No numeric confidence. The column is the band, because a number invites
--     arithmetic over an ordinal scale and comparison nobody intended. `moderate` minus
--     `limited` is not a quantity.
--   * No actor column, anywhere. A confidence is about a *pattern*, and the people who
--     contributed to it are in `experience_corroborations` where they belong. A series
--     keyed by person would be a reputation history under another name.
-- ─────────────────────────────────────────────────────────────────────────

create type confidence_band as enum ('insufficient', 'limited', 'moderate', 'strong');

create table confidence_points (
  -- `<subject>:<boundary>`. Deterministic, so a re-derivation of the same boundary
  -- collides rather than duplicating.
  id             text primary key,
  -- The cluster or experience the confidence is about. No foreign key: it may point at
  -- either, which Postgres cannot express conditionally — the same reasoning as
  -- `experience_watches.target_id`, and the read re-checks status regardless.
  subject_id     text not null,
  subject_kind   text not null check (subject_kind in ('experience', 'cluster')),
  at             timestamptz not null,
  band           confidence_band not null,
  -- People, never rows. Carried so a reader can see the count was not adjusted by the
  -- band, which is Phase 81's central rule.
  independent_people integer not null check (independent_people >= 0),
  -- Which factor decided this band, in words. Stored rather than recomputed because the
  -- factors that produced a point a year ago may not exist in the same form today, and a
  -- history whose explanations drift is worse than one without them.
  deciding       text not null,
  computed_at    timestamptz not null default now(),
  constraint confidence_points_one_per_boundary unique (subject_id, at)
);
create index confidence_points_subject_idx on confidence_points (subject_id, at desc);

alter table confidence_points enable row level security;

-- The band is publishable and the series is not, which is the split this table exists to
-- make possible. A reader may be told "limited confidence"; a *history* of how a pattern's
-- credibility moved is an operator read, because a reader watching it move would be
-- watching an argument they cannot see the sides of.
create policy confidence_points_staff on confidence_points for select
  using (is_staff());

grant select on confidence_points to authenticated;
grant all on confidence_points to service_role;

create or replace function confidence_points_are_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'confidence_points is append-only';
end;
$$;

drop trigger if exists confidence_points_no_update on confidence_points;
create trigger confidence_points_no_update before update or delete on confidence_points
  for each row execute function confidence_points_are_append_only();

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 87 — recommendation memory
--
-- `recommendations` records what was concluded. Nothing records what happened to it, so
-- an operator surface re-offers a recommendation somebody dismissed last week, and
-- nobody can tell whether the ones acted on made any difference.
--
-- **The minimum that is necessary**, and the omissions are the design:
--
--   * No free text. No "why I dismissed this". A dismissal reason would become a record
--     of one person's judgement about another's situation, written in a box nobody
--     reviews, readable by every operator afterwards.
--   * No actor column. Who dismissed a recommendation is not needed to stop re-offering
--     it, and storing it would make the table a log of individual operators' decisions —
--     which is what `audit_events` is for, under a rule that governs what belongs there.
--   * One row per recommendation. Not per (recommendation, operator): the point is
--     whether *this* recommendation is still live, and per-operator state would re-offer
--     it to somebody else, which is the behaviour this table exists to prevent.
-- ─────────────────────────────────────────────────────────────────────────

create type recommendation_outcome as enum ('shown', 'dismissed', 'accepted', 'acted_on');

create table recommendation_memory (
  -- The recommendation's own id, so the memory is keyed to it and cannot duplicate.
  recommendation_id text primary key references recommendations (id) on delete cascade,
  outcome           recommendation_outcome not null default 'shown',
  -- When each transition happened, so a series is derivable without a second table.
  shown_at          timestamptz not null default now(),
  dismissed_at      timestamptz,
  accepted_at       timestamptz,
  acted_on_at       timestamptz,
  -- The plan an acceptance produced, when it produced one. A recommendation accepted and
  -- then refused per step has an `accepted_at` and a plan whose status says what happened —
  -- which is how `decision != effect` stays visible here too.
  plan_id           text references action_plans (id) on delete set null,
  updated_at        timestamptz not null default now(),
  -- A timestamp implies its outcome. Without this a row could say `dismissed` with no
  -- `dismissed_at`, and a series derived from the timestamps would silently skip it.
  constraint memory_dismissed_has_time check ((outcome = 'dismissed') = (dismissed_at is not null)),
  constraint memory_acted_has_acceptance check (acted_on_at is null or accepted_at is not null)
);
create index recommendation_memory_outcome_idx on recommendation_memory (outcome, updated_at desc);

alter table recommendation_memory enable row level security;

create policy recommendation_memory_staff on recommendation_memory for all
  using (is_staff()) with check (is_staff());

grant all on recommendation_memory to service_role;
