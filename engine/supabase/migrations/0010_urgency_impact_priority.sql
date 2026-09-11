-- Phases 41–43: urgency, impact estimation and explainable prioritisation.
--
-- Additive, and deliberately one table. Impact is *derived on read* from asserted
-- dimensions across a pattern and never stored: a stored estimate is wrong the moment
-- anybody adds an account, and an estimate that is silently stale is worse than none.
-- What is cached here is the priority reading, because a queue has to be sortable in
-- the database rather than in application memory.

-- ─────────────────────────────────────────────────────────────────────────
-- The three questions, kept apart
--
--   severity — how bad it was.      Asserted by the person. `experience_severities`.
--   urgency  — how soon to look.    Derived from state and elapsed time.
--   priority — where it sits.       Derived from both, plus impact.
--
-- They disagree constantly, and that is the point. A minor problem unanswered for four
-- months is not severe and is urgent. A critical one already being worked is severe and
-- not urgent. Collapsing any pair produces a queue that is confidently wrong.
--
-- There is no score column, and that is the design rather than an omission. The roadmap
-- asks for a band *and* for the contributing factors recorded alongside it, and a
-- composite number satisfies the first while quietly failing the second: a reader shown
-- `73.4` cannot tell whether it came from one serious thing or six trivial ones.
-- Ordering is a lexicographic comparison over the named columns below.
-- ─────────────────────────────────────────────────────────────────────────
create type urgency_level as enum ('routine', 'soon', 'prompt', 'immediate');
create type priority_band as enum ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

create table experience_priorities (
  id               text primary key,
  experience_id    text not null unique references experiences (id) on delete cascade,
  band             priority_band not null,
  -- One sentence naming why, e.g. "reported as serious, and needs attention".
  reason           text not null,
  -- Which dimensions decided it, most decisive first.
  dominant         text[] not null default '{}',
  urgency          urgency_level not null,
  -- Why it is urgent, in the words a person reads rather than as slugs.
  urgency_factors  text[] not null default '{}',
  severity         severity_band,
  -- Distinct people who said it happened to them, across the pattern. A count.
  people_affected  integer check (people_affected is null or people_affected >= 0),
  -- False when the pattern has too few people to estimate over. Distinct from zero:
  -- "we do not know" and "nobody" are opposite statements.
  impact_known     boolean not null default false,
  confidence       numeric(5,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  unresolved_days  integer not null default 0 check (unresolved_days >= 0),
  unassessed       boolean not null default true,
  computed_at      timestamptz not null default now(),
  -- An unknown impact must not carry a population: a caller reading `people_affected`
  -- without checking `impact_known` would otherwise treat an absence as a small number.
  constraint priorities_impact_coherent check (impact_known or people_affected is null)
);

-- The queue read: banded, most urgent first. Partial, because an unassessed row is not
-- in the queue at all — it is an experience nobody has said anything about yet.
create index priorities_queue_idx
  on experience_priorities (band desc, urgency desc, unresolved_days desc)
  where unassessed = false;

-- ─────────────────────────────────────────────────────────────────────────
-- Access
-- ─────────────────────────────────────────────────────────────────────────
alter table experience_priorities enable row level security;

-- Internal. A priority reading is an operational judgement about where something sits
-- in a queue; publishing it would let anyone infer both the thresholds and the position
-- of other people's complaints.
create policy priorities_staff on experience_priorities for all
  using (is_staff()) with check (is_staff());

grant all on experience_priorities to service_role;
