-- ─────────────────────────────────────────────────────────────────────────
-- Phase 65 — Retention & data minimisation
--
-- Three raw artefacts are held today with no stated lifetime and no removal:
-- media_assets.original_key, transcripts.raw_text and evidence.original_key. All
-- three are already unreadable by every client role — the grants in 0002 and the
-- privacy gate hold that — and unreadable is not absent. This migration gives each
-- a removal record and adds the ledger a sweep writes.
--
-- Additive only, per the rollback rule: three nullable columns per table and one new
-- table. The previous release runs unchanged against this schema, because nothing it
-- reads has moved and nothing it writes is now required.
--
-- Written as plain `create table` rather than `create table if not exists`, matching the
-- fourteen migrations before it. The runner already refuses to re-apply a migration, so
-- the guard bought nothing — and it cost something: the schema test that checks every port
-- table has a relation scans for `create table <name> (`, so `if not exists` hid this table
-- from it and the port went unverified while the suite stayed green.
--
-- What is NOT here, deliberately:
--
--   * No expires_at column. The ceiling is a policy decision that belongs in code
--     where its reason can be read (src/domain/retention.ts), not a per-row date
--     nobody can change without a backfill. A stored date would also drift from the
--     policy the moment the policy changed, and the row would win.
--   * No deletion of the key column itself. The key is how a future sweep, once
--     object storage exists, knows what to delete. Forgetting it before the bytes are
--     gone would leave the bytes orphaned and unreachable forever, which is worse
--     than holding a string.
-- ─────────────────────────────────────────────────────────────────────────

-- The removal record, per artefact. `removed_at` is the fact; `removal_reason` is why,
-- so a null column is distinguishable from an upload that never happened; and
-- `byte_removal` records whether the bytes actually went, which today they cannot.
alter table media_assets
  add column original_removed_at   timestamptz,
  add column original_removal_reason text,
  add column original_byte_removal text
    check (original_byte_removal is null or original_byte_removal in ('removed','object_storage_blocked'));

alter table transcripts
  add column raw_removed_at   timestamptz,
  add column raw_removal_reason text,
  add column raw_byte_removal text
    check (raw_byte_removal is null or raw_byte_removal in ('removed','object_storage_blocked'));

alter table evidence
  add column original_removed_at   timestamptz,
  add column original_removal_reason text,
  add column original_byte_removal text
    check (original_byte_removal is null or original_byte_removal in ('removed','object_storage_blocked'));

-- ─────────────────────────────────────────────────────────────────────────
-- The sweep ledger
--
-- One row per artefact per sweep, including the ones nothing happened to. "We looked
-- and it was held" is the answer to the only question an auditor asks about a
-- retention policy, and a ledger that recorded only removals could not give it.
--
-- Append-only by the same trigger pattern as audit_events: a retention ledger that can
-- be edited proves nothing about what was retained.
-- ─────────────────────────────────────────────────────────────────────────
create table retention_sweeps (
  id               text primary key default gen_random_uuid()::text,
  swept_at         timestamptz not null default now(),
  subject_id       text not null,
  retention_class  text not null check (retention_class in ('original_media','raw_transcript','original_evidence')),
  verdict          text not null check (verdict in ('within_ceiling','expired','held','already_removed')),
  expires_at       timestamptz not null,
  -- Only set when the verdict is `held`, and then it names which review is holding it.
  hold             text check (hold is null or hold in ('dispute_open','moderation_review_open')),
  byte_removal     text check (byte_removal is null or byte_removal in ('removed','object_storage_blocked')),
  -- The policy's own reason, denormalised on purpose: a ledger row a year from now must
  -- explain itself without depending on what the policy says by then.
  reason           text not null,
  constraint retention_hold_only_when_held check ((verdict = 'held') = (hold is not null))
);
create index retention_sweeps_subject_idx on retention_sweeps (subject_id, swept_at desc);
create index retention_sweeps_verdict_idx on retention_sweeps (verdict, swept_at desc);

alter table retention_sweeps enable row level security;

-- Operators only. A retention ledger names artefacts across every account, so it is
-- exactly the kind of read that must not be reachable by the people it describes.
create policy retention_sweeps_staff_read on retention_sweeps for select
  using (is_staff());

grant all on retention_sweeps to service_role;

create or replace function retention_sweeps_are_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'retention_sweeps is append-only';
end;
$$;

drop trigger if exists retention_sweeps_no_update on retention_sweeps;
create trigger retention_sweeps_no_update before update or delete on retention_sweeps
  for each row execute function retention_sweeps_are_append_only();
