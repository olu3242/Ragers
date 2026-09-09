-- Ragers Engine — row level security
--
-- These policies mirror src/policy/policy.ts. The database is not a second,
-- weaker gate: if the application policy is bypassed, RLS still refuses.
--
-- Two absolute rules, enforced by column grants rather than row policies
-- (RLS filters rows; it cannot hide a column):
--   * media_assets.original_key is never selectable by any client role
--   * transcripts.raw_text      is never selectable by any client role
-- Clients read the *_public views instead, which cannot expose those columns.

-- ─────────────────────────────────────────────────────────────────────────
-- Actor context helpers
-- ─────────────────────────────────────────────────────────────────────────
create or replace function current_actor_id() returns text
  language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')
  $$;

-- `security definer` is load-bearing, not incidental: this function reads
-- `actors`, and the policy on `actors` calls is_staff() -> current_actor_role().
-- As an invoker-rights function that recurses until Postgres aborts with
-- "stack depth limit exceeded". Definer rights read the table as its owner,
-- which breaks the cycle. search_path is pinned so the definer context cannot
-- be redirected to an attacker-controlled schema.
create or replace function current_actor_role() returns actor_role
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce(
      (select role from actors where id = current_actor_id()),
      'guest'::actor_role
    )
  $$;

revoke all on function current_actor_role() from public;
grant execute on function current_actor_role() to anon, authenticated, service_role;

create or replace function is_staff() returns boolean
  language sql stable as $$
    select current_actor_role() in ('moderator','admin')
  $$;

create or replace function is_admin() returns boolean
  language sql stable as $$
    select current_actor_role() = 'admin'
  $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Enable RLS everywhere. A table without a policy is therefore closed.
-- ─────────────────────────────────────────────────────────────────────────
alter table actors                   enable row level security;
alter table aliases                  enable row level security;
alter table sessions                 enable row level security;
alter table experiences              enable row level security;
alter table media_assets             enable row level security;
alter table upload_targets           enable row level security;
alter table transcripts              enable row level security;
alter table replies                  enable row level security;
alter table reactions                enable row level security;
alter table fair_votes               enable row level security;
alter table experience_counters      enable row level security;
alter table feed_entries             enable row level security;
alter table search_documents         enable row level security;
alter table reports                  enable row level security;
alter table moderation_queue         enable row level security;
alter table moderation_actions       enable row level security;
alter table screenings               enable row level security;
alter table subjects                 enable row level security;
alter table experience_subjects      enable row level security;
alter table graph_edges              enable row level security;
alter table notifications            enable row level security;
alter table notification_preferences enable row level security;
alter table actor_reputation         enable row level security;
alter table ranking_inputs           enable row level security;
alter table trends                   enable row level security;
alter table deletion_requests        enable row level security;
alter table export_requests          enable row level security;
alter table audit_events             enable row level security;
alter table role_assignments         enable row level security;
alter table analytics_events         enable row level security;
alter table metric_snapshots         enable row level security;
alter table idempotency_keys         enable row level security;
alter table outbox                   enable row level security;
alter table event_deliveries         enable row level security;
alter table dead_letters             enable row level security;

-- ─────────────────────────────────────────────────────────────────────────
-- Identity
-- ─────────────────────────────────────────────────────────────────────────
create policy actors_self_select on actors for select
  using (id = current_actor_id() or is_staff());
create policy actors_self_update on actors for update
  using (id = current_actor_id()) with check (id = current_actor_id());

-- An alias row is private: the alias->actor link is exactly what anonymity
-- protects. Public surfaces read the label from the feed projection instead.
create policy aliases_owner_all on aliases for all
  using (actor_id = current_actor_id()) with check (actor_id = current_actor_id());

create policy sessions_owner_select on sessions for select
  using (actor_id = current_actor_id());
create policy sessions_owner_update on sessions for update
  using (actor_id = current_actor_id()) with check (actor_id = current_actor_id());

-- ─────────────────────────────────────────────────────────────────────────
-- Experiences
-- ─────────────────────────────────────────────────────────────────────────
create policy experiences_read on experiences for select
  using (
    status = 'published'
    or actor_id = current_actor_id()
    or is_staff()
  );
create policy experiences_insert_own on experiences for insert
  with check (actor_id = current_actor_id() and current_actor_role() <> 'guest');
create policy experiences_update_own on experiences for update
  using (actor_id = current_actor_id() or is_staff())
  with check (actor_id = current_actor_id() or is_staff());
-- Deletion is a state transition plus propagation, never a raw row delete.
create policy experiences_no_hard_delete on experiences for delete using (false);

-- ─────────────────────────────────────────────────────────────────────────
-- Media & transcripts — protected derivatives only
-- ─────────────────────────────────────────────────────────────────────────
create policy media_assets_read on media_assets for select
  using (
    exists (
      select 1 from experiences e
      where e.id = media_assets.experience_id
        and (e.status = 'published' or e.actor_id = current_actor_id() or is_staff())
    )
  );
create policy media_assets_owner_write on media_assets for all
  using (
    exists (select 1 from experiences e where e.id = media_assets.experience_id and e.actor_id = current_actor_id())
  )
  with check (
    exists (select 1 from experiences e where e.id = media_assets.experience_id and e.actor_id = current_actor_id())
  );

create policy upload_targets_owner on upload_targets for all
  using (actor_id = current_actor_id()) with check (actor_id = current_actor_id());

create policy transcripts_read on transcripts for select
  using (
    exists (
      select 1 from media_assets m join experiences e on e.id = m.experience_id
      where m.id = transcripts.media_asset_id
        and (e.status = 'published' or e.actor_id = current_actor_id() or is_staff())
    )
  );

-- Public views. These are the only shapes a client may read, and they simply
-- do not contain original_key or raw_text.
create view media_assets_public with (security_invoker = true) as
  select id, experience_id, reply_id, kind, protected_key, duration_ms, mime_type,
         processing_status, protection_status, created_at
  from media_assets
  where protection_status = 'protected';

create view transcripts_public with (security_invoker = true) as
  select id, media_asset_id, redacted_text, language, processing_status, created_at
  from transcripts
  where redacted_text is not null;

-- ─────────────────────────────────────────────────────────────────────────
-- Conversation & engagement
-- ─────────────────────────────────────────────────────────────────────────
create policy replies_read on replies for select
  using (status = 'published' or actor_id = current_actor_id() or is_staff());
create policy replies_insert_own on replies for insert
  with check (actor_id = current_actor_id() and current_actor_role() <> 'guest');
create policy replies_update_own on replies for update
  using (actor_id = current_actor_id() or is_staff())
  with check (actor_id = current_actor_id() or is_staff());

create policy reactions_read on reactions for select using (true);
create policy reactions_own_write on reactions for all
  using (actor_id = current_actor_id()) with check (actor_id = current_actor_id());

create policy fair_votes_read on fair_votes for select
  using (actor_id = current_actor_id() or is_staff());
-- A member may not vote on the fairness of their own experience.
create policy fair_votes_own_write on fair_votes for all
  using (actor_id = current_actor_id())
  with check (
    actor_id = current_actor_id()
    and not exists (
      select 1 from experiences e where e.id = fair_votes.experience_id and e.actor_id = current_actor_id()
    )
  );

create policy counters_read on experience_counters for select using (true);

-- ─────────────────────────────────────────────────────────────────────────
-- Read projections
-- ─────────────────────────────────────────────────────────────────────────
create policy feed_read on feed_entries for select using (not suppressed or is_staff());
create policy search_read on search_documents for select using (true);
create policy subjects_read on subjects for select using (true);
create policy experience_subjects_read on experience_subjects for select using (true);
create policy trends_read on trends for select using (true);
-- Ranking inputs are internal: no score component is exposed to a client.
create policy ranking_inputs_staff_read on ranking_inputs for select using (is_staff());

-- ─────────────────────────────────────────────────────────────────────────
-- Trust & safety
-- ─────────────────────────────────────────────────────────────────────────
-- A reporter can see that they filed a report, and nothing about its handling.
create policy reports_insert_own on reports for insert
  with check (reporter_actor_id = current_actor_id() and current_actor_role() <> 'guest');
create policy reports_read on reports for select
  using (reporter_actor_id = current_actor_id() or is_staff());

create policy queue_staff_only on moderation_queue for all
  using (is_staff()) with check (is_staff());
create policy moderation_actions_staff_read on moderation_actions for select using (is_staff());
-- A moderator may not action their own content.
create policy moderation_actions_staff_insert on moderation_actions for insert
  with check (
    is_staff()
    and moderator_id = current_actor_id()
    and not exists (
      select 1 from experiences e
      where e.id = moderation_actions.target_id
        and moderation_actions.target_type = 'experience'
        and e.actor_id = current_actor_id()
    )
  );
create policy screenings_staff_read on screenings for select using (is_staff());

-- ─────────────────────────────────────────────────────────────────────────
-- Social graph & notifications
-- ─────────────────────────────────────────────────────────────────────────
create policy graph_edges_own on graph_edges for all
  using (actor_id = current_actor_id()) with check (actor_id = current_actor_id());

create policy notifications_own_select on notifications for select
  using (recipient_actor_id = current_actor_id());
create policy notifications_own_update on notifications for update
  using (recipient_actor_id = current_actor_id())
  with check (recipient_actor_id = current_actor_id());
create policy notification_prefs_own on notification_preferences for all
  using (actor_id = current_actor_id()) with check (actor_id = current_actor_id());

-- ─────────────────────────────────────────────────────────────────────────
-- Reputation — internal_signals excluded from the public view
-- ─────────────────────────────────────────────────────────────────────────
create policy reputation_staff_read on actor_reputation for select using (is_staff());

-- Deliberately NOT security_invoker: the base table is staff-only, so an
-- invoker-rights view would return nothing to the members whose own approval
-- rate this is meant to show. Running as owner makes the view itself the
-- access boundary, and it selects only the public columns — internal_signals
-- is absent, so there is nothing here to leak.
create view actor_reputation_public with (security_invoker = false) as
  select actor_id, experiences_published, fair_yes_received, fair_no_received, approval_rate, updated_at
  from actor_reputation;

-- ─────────────────────────────────────────────────────────────────────────
-- Creator control
-- ─────────────────────────────────────────────────────────────────────────
create policy deletion_requests_own on deletion_requests for all
  using (actor_id = current_actor_id() or is_staff())
  with check (actor_id = current_actor_id());
create policy export_requests_own on export_requests for all
  using (actor_id = current_actor_id())
  with check (actor_id = current_actor_id());

-- ─────────────────────────────────────────────────────────────────────────
-- Governance — audit is append-only
-- ─────────────────────────────────────────────────────────────────────────
create policy audit_admin_read on audit_events for select using (is_admin());
create policy audit_insert on audit_events for insert with check (true);
-- No update or delete policy exists for audit_events, so RLS exposes no rows to
-- modify and both statements become no-ops. That protects the data but succeeds
-- silently, so the privilege is revoked as well and tampering raises an error
-- instead. Defence in depth, and a much clearer signal in an audit review.

create policy role_assignments_admin on role_assignments for all
  using (is_admin()) with check (is_admin());

-- ─────────────────────────────────────────────────────────────────────────
-- Operations — runtime tables are service-role only (no client policies)
-- ─────────────────────────────────────────────────────────────────────────
create policy dead_letters_admin_read on dead_letters for select using (is_admin());
create policy analytics_admin_read on analytics_events for select using (is_admin());
create policy metrics_admin_read on metric_snapshots for select using (is_admin());
-- idempotency_keys, outbox and event_deliveries intentionally have no policies:
-- only the service role, which bypasses RLS, may touch them.

-- ─────────────────────────────────────────────────────────────────────────
-- Base privileges
--
-- RLS filters rows a role may touch; it does not grant the privilege to touch
-- the table in the first place. Without these grants the policies above are
-- never consulted, because the statement is refused earlier. Supabase installs
-- equivalents as part of its bootstrap, so these are written explicitly here to
-- keep a plain Postgres deployment identical — and so a pg_dump/pg_restore
-- reproduces exactly this surface rather than whatever an environment happened
-- to have.
--
-- Grants are per table and per statement on purpose. A blanket
-- `grant select on all tables` would hand out every column, which is precisely
-- what the withheld-column rules below exist to prevent.
-- ─────────────────────────────────────────────────────────────────────────
grant usage on schema public to anon, authenticated, service_role;

-- Publicly readable surfaces (RLS still decides which rows).
grant select on experiences, replies, reactions, experience_counters, feed_entries,
                search_documents, subjects, experience_subjects, trends
  to anon, authenticated;

-- Member-owned reads.
grant select on actors, aliases, sessions, upload_targets, fair_votes, notifications,
                notification_preferences, graph_edges, reports, deletion_requests,
                export_requests, actor_reputation, moderation_queue, moderation_actions,
                screenings, audit_events, dead_letters, metric_snapshots
  to authenticated;

-- Member writes. Note the deliberate absence of `delete` on experiences and
-- replies: removal is a state transition plus propagation, never a row delete.
grant insert, update on experiences, replies to authenticated;
grant insert, update on aliases, upload_targets, fair_votes, deletion_requests,
                        export_requests, notification_preferences, moderation_queue,
                        role_assignments
  to authenticated;
grant insert on reports, moderation_actions, audit_events to authenticated;
grant update on actors, sessions, notifications to authenticated;
-- Reactions and graph edges are toggles, so removing the row is the intent.
grant insert, delete on reactions, graph_edges to authenticated;
grant select on role_assignments to authenticated;

-- The worker owns everything else.
grant all on all tables in schema public to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Column grants — the absolute rules
-- ─────────────────────────────────────────────────────────────────────────
do $$
declare
  client_role text;
begin
  foreach client_role in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = client_role) then
      execute format('revoke all on media_assets from %I', client_role);
      execute format('revoke all on transcripts from %I', client_role);
      -- Every column except original_key.
      execute format(
        'grant select (id, experience_id, reply_id, kind, protected_key, duration_ms, byte_size, '
        || 'mime_type, processing_status, protection_status, protection_findings, created_at) '
        || 'on media_assets to %I', client_role);
      -- Every column except raw_text.
      execute format(
        'grant select (id, media_asset_id, redacted_text, language, confidence, processing_status, '
        || 'provider, redaction_findings, created_at) on transcripts to %I', client_role);
      execute format('grant select on media_assets_public to %I', client_role);
      if client_role = 'authenticated' then
        execute 'grant insert, update on media_assets to authenticated';
      end if;
      execute format('grant select on transcripts_public to %I', client_role);
      execute format('grant select on actor_reputation_public to %I', client_role);
      -- Ranking components and analytics are never client-readable.
      execute format('revoke all on ranking_inputs from %I', client_role);
      execute format('revoke all on analytics_events from %I', client_role);
      -- Make tampering an error rather than a silent no-op.
      execute format('revoke update, delete on audit_events from %I', client_role);
      execute format('revoke delete on experiences from %I', client_role);
      execute format('revoke delete on replies from %I', client_role);
      execute format('grant select on actor_reputation_public to %I', client_role);
      -- ranking components and analytics stay internal even for staff reads,
      -- which go through the worker's service role.
      execute format('revoke all on ranking_inputs from %I', client_role);
      execute format('revoke all on analytics_events from %I', client_role);
    end if;
  end loop;
end $$;
