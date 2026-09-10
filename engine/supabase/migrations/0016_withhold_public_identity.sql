-- ─────────────────────────────────────────────────────────────────────────
-- Phase 69 — withhold the actor identity on world-readable tables
--
-- Found by the tenant isolation sweep, which enumerates the schema rather than
-- checking a list of tables somebody maintained. Four columns were readable by
-- `anon` — an unauthenticated visitor, no login, no rate limit, no trace — on
-- tables whose read policy is `using (true)`:
--
--   * reactions.actor_id            — every experience a given account reacted to
--   * experience_shares.actor_id    — who shared what, and where to
--   * resolution_events.actor_id    — who moved a resolution status
--   * organization_profiles.claimed_by — which personal account claimed which business
--
-- `reactions` is the serious one. A `been_there` reaction is somebody saying *this
-- happened to me as well* — a claim about their own life — and it was world-readable
-- with their account id attached, on a product whose first promise is that you can
-- speak without exposing yourself. The corroboration table, which is the same claim
-- made deliberately, has four scoped policies. Reactions are the older table and were
-- never revisited when the identity rules tightened.
--
-- None of it was reachable through the product: every read goes through the engine on
-- the owner connection, and no browser client exists. That is the argument for fixing it
-- now rather than later — the hole opens the day somebody adds a direct client, and on
-- that day nobody will be reading the grants from migration 0002.
--
-- ## The mechanism, and why this one
--
-- Column-level grants, the same instrument that withholds `media_assets.original_key`
-- and `transcripts.raw_text`. RLS is row-level and cannot express "these rows but not
-- that column", so a column the client must not see is a grant question, not a policy
-- question. The rows stay readable — a reaction is still visible as a reaction, a claimed
-- business is still a public page — and only the identity goes.
--
-- Additive per the rollback rule: a revoke plus a narrower grant changes no column and
-- drops nothing. The previous release still runs, because nothing in it reads these
-- columns as a client role.
--
-- ## What this does not solve
--
-- A client that legitimately needs to know *its own* reaction ("have I already tapped
-- this") cannot ask, because referencing a column in a WHERE clause requires SELECT on
-- it. That needs a view — `my_reactions`, scoped by `current_actor_id()` — and it is
-- deliberately not here: nothing needs it yet, and a view nobody reads is a surface
-- nobody maintains. Recorded in docs/architecture/ENGINE_GAPS.md so the day a browser
-- client is added, the requirement is written down rather than rediscovered.
-- ─────────────────────────────────────────────────────────────────────────

do $$
declare
  client_role text;
begin
  foreach client_role in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = client_role) then

      -- Reactions. Every column except actor_id. The insert and delete grants stay: a
      -- toggle writes its own row, and the `reactions_own_write` policy already scopes it
      -- to `actor_id = current_actor_id()`, which the database checks without the client
      -- needing to read the column.
      execute format('revoke select on reactions from %I', client_role);
      execute format(
        'grant select (id, experience_id, reaction_type, created_at) on reactions to %I',
        client_role);

      -- Shares. A share is not a claim, and who made it is nobody else's business.
      execute format('revoke select on experience_shares from %I', client_role);
      execute format(
        'grant select (id, experience_id, destination, created_at) on experience_shares to %I',
        client_role);

      -- Resolution events. The transition is public — that is the point of a
      -- resolution — and who moved it is not. `detail` goes too: it is free text written
      -- by whoever moved the status, and free text on a public table is how an identity
      -- leaks back in through a sentence.
      execute format('revoke select on resolution_events from %I', client_role);
      execute format(
        'grant select (id, experience_id, from_status, to_status, source, created_at) '
        || 'on resolution_events to %I', client_role);

      -- Organization profiles. The business page is public; the account that claimed it
      -- is not, because that links a named person to a company for anybody who asks.
      execute format('revoke select on organization_profiles from %I', client_role);
      execute format(
        'grant select (id, entity_id, display_name, claimed_at, status, created_at) '
        || 'on organization_profiles to %I', client_role);

    end if;
  end loop;
end $$;
