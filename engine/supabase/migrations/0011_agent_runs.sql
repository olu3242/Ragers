-- Phases 44–47: governed agent runs.
--
-- One table. Phase 47's benchmarking stores nothing at all — a stored aggregate is a
-- re-identification risk sitting on disk, and it is wrong the moment anybody contributes —
-- so benchmarks are computed on read from the certified Phase 39 aggregation.

-- ─────────────────────────────────────────────────────────────────────────
-- The agent run ledger
--
-- What an agent did, *including when it declined to act*. The outcomes matter as much as
-- the proposals:
--
--   proposed              — it was confident enough, and a proposal exists for a person.
--   escalated             — it was not confident enough, so it handed the decision on.
--   provider_unavailable  — no model answered, so it produced nothing rather than
--                           producing something with an empty rationale.
--   refused               — it asked for something outside its own declaration.
--
-- All four are recorded rather than swallowed, because an agent that quietly does nothing is
-- indistinguishable from one that is working.
--
-- There is no column here through which an agent could touch governed state, and no table
-- anywhere that an agent writes to besides this one and (via `proposal.create`) the proposal
-- ledger. An agent analyses, proposes and escalates; it has no write verb.
-- ─────────────────────────────────────────────────────────────────────────
create type agent_outcome as enum ('proposed', 'escalated', 'refused', 'provider_unavailable');

create table agent_runs (
  id            text primary key,
  agent_id      text not null,
  subject_id    text not null,
  proposal_type text not null,
  outcome       agent_outcome not null,
  proposal_id   text references intelligence_proposals (id) on delete set null,
  -- Why it escalated or was refused, verbatim. Never summarised away: a reviewer asking
  -- "why did nothing happen?" deserves the engine's own words.
  detail        text,
  created_at    timestamptz not null default now(),
  -- One run per (agent, proposal type, subject): a sweep that runs hourly must not hand a
  -- reviewer twenty-four copies of one suggestion.
  constraint agent_runs_one_per_subject unique (agent_id, proposal_type, subject_id),
  -- A proposal only exists when the run actually proposed. The converse — an outcome of
  -- `proposed` with no proposal id — would mean the ledger claims something the proposal
  -- table cannot corroborate.
  constraint agent_runs_proposal_coherent check (
    (outcome = 'proposed' and proposal_id is not null)
    or (outcome <> 'proposed' and proposal_id is null)
  )
);
create index agent_runs_subject_idx on agent_runs (subject_id);
create index agent_runs_agent_idx on agent_runs (agent_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────
-- Access
-- ─────────────────────────────────────────────────────────────────────────
alter table agent_runs enable row level security;

-- Internal, like the proposals they produce: this records what a machine suggested about
-- somebody, which is not a public matter.
create policy agent_runs_staff on agent_runs for all
  using (is_staff()) with check (is_staff());

grant all on agent_runs to service_role;
