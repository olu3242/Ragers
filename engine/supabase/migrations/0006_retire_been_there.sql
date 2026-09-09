-- Retire "Been There"; the claims it recorded become corroborations.
--
-- `been_there` meant "this happened to me too". That is a claim about the
-- claimant's own experience, which is what a Re-Rage is — so the product had two
-- "me too" signals with different weights in different tables. This migration
-- moves the existing rows to where they belong rather than dropping them: those
-- people said something, and it should still count.
--
-- The `been_there` enum value and the `been_there` counter column both stay. An
-- enum value cannot be removed additively, and the column is read by clients
-- that have not shipped yet. Nothing writes either again: the reaction engine
-- refuses the type at the boundary and the counter recompute carries the old
-- value forward untouched.

-- ─────────────────────────────────────────────────────────────────────────
-- Backfill
--
-- Filters are not defensive noise — each one is a case the corroboration rules
-- reject, and a row that violated them would fail the table's own triggers:
--   * the author of an experience cannot corroborate it (they already claimed it
--     by posting),
--   * a rage takes a re_rage and a rave a re_rave, never the other way,
--   * one person, one experience, one corroboration.
-- ─────────────────────────────────────────────────────────────────────────
insert into experience_corroborations (
  id, experience_id, corroborator_id, type, relationship, visibility, status, correlation_id, created_at
)
select
  -- The same natural key the engine uses, so a re-run cannot double-insert and a
  -- later claim from the same person lands on this row rather than beside it.
  r.experience_id || ':' || r.actor_id,
  r.experience_id,
  r.actor_id,
  case e.kind when 'rage' then 're_rage'::corroboration_type else 're_rave'::corroboration_type end,
  -- Not `same_experience`: a Been There tap carried no statement about whether
  -- it was the same incident, and inventing one would be putting words in
  -- someone's mouth.
  'similar_experience'::match_relationship,
  -- Reactions were never identity-scoped, so the safe reading is the least
  -- exposing one.
  'anonymous'::visibility_mode,
  'active',
  'migration_0006_retire_been_there',
  r.created_at
from reactions r
join experiences e on e.id = r.experience_id
where r.reaction_type = 'been_there'
  and r.actor_id is distinct from e.actor_id
on conflict (experience_id, corroborator_id) do nothing;

-- The reaction rows are gone: leaving them would double-count every migrated
-- claim, once as a corroboration and once as a reaction.
delete from reactions where reaction_type = 'been_there';

-- ─────────────────────────────────────────────────────────────────────────
-- Counters
--
-- Recomputed from rows here, exactly as the engine's consumer does, so the
-- database is correct before any event is delivered. `been_there` is zeroed:
-- every row behind it has moved.
-- ─────────────────────────────────────────────────────────────────────────
update experience_counters c
set been_there        = 0,
    re_rage_count     = coalesce(counted.re_rages, 0),
    re_rave_count     = coalesce(counted.re_raves, 0),
    corroborator_count = coalesce(counted.corroborators, 0)
from (
  select
    e.id as experience_id,
    count(*) filter (where k.type = 're_rage') as re_rages,
    count(*) filter (where k.type = 're_rave') as re_raves,
    count(distinct k.corroborator_id)          as corroborators
  from experiences e
  left join experience_corroborations k on k.experience_id = e.id and k.status = 'active'
  group by e.id
) counted
where c.experience_id = counted.experience_id;
