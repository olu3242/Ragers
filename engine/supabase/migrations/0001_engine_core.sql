-- Ragers Engine — core schema
-- Internal. See docs/ROADMAP.md for the phase each table belongs to.
--
-- Two invariants are enforced structurally, not by convention:
--   1. media_assets.original_key and transcripts.raw_text are never granted to
--      any client role. Only the *_public views are readable.
--   2. Feed and search projections have no actor_id column at all, so an
--      anonymity bug in a projection is impossible to express.

create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────────────────────────────────
-- Enumerated domains
-- ─────────────────────────────────────────────────────────────────────────
create type experience_kind    as enum ('rage', 'rave');
create type creation_mode      as enum ('text', 'voice');
create type visibility_mode    as enum ('public', 'alias', 'anonymous');
create type experience_status  as enum ('draft','validating','pending_media','pending_moderation','published','under_review','hidden','removed','deleted');
create type work_state         as enum ('queued','processing','ready','failed','dead_letter');
create type protection_status  as enum ('queued','processing','protected','failed','dead_letter');
create type actor_role         as enum ('guest','member','moderator','admin');
create type actor_status       as enum ('pending','active','suspended','closed');
-- Ragers-native engagement only. Like/upvote/repost is deliberately absent.
create type reaction_type      as enum ('been_there','same','fair_point','disagree');
create type report_reason      as enum ('naming_shaming','harassment','spam','other');
create type moderation_action_kind as enum ('warn','remove','restore','no_action');
create type target_type        as enum ('experience','reply');
create type standing_tier      as enum ('new','established','trusted','limited');
create type trend_window       as enum ('1h','24h','7d');

-- ─────────────────────────────────────────────────────────────────────────
-- P3 Identity & access
-- ─────────────────────────────────────────────────────────────────────────
create table actors (
  id                 uuid primary key default gen_random_uuid(),
  email              text not null unique,
  auth_provider      text not null default 'password',
  display_name       text not null check (char_length(display_name) between 1 and 40),
  default_visibility visibility_mode not null default 'public',
  role               actor_role not null default 'member',
  status             actor_status not null default 'active',
  created_at         timestamptz not null default now(),
  last_active_at     timestamptz not null default now()
);

create table aliases (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid not null references actors(id) on delete cascade,
  alias_name  text not null check (alias_name ~ '^[a-z0-9_]{3,24}$'),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
-- Only one active holder of a given alias name at a time.
create unique index aliases_active_name_key on aliases (alias_name) where is_active;
create index aliases_actor_idx on aliases (actor_id);

create table sessions (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid not null references actors(id) on delete cascade,
  issued_at  timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_actor_idx on sessions (actor_id) where revoked_at is null;

-- ─────────────────────────────────────────────────────────────────────────
-- P4 Durable runtime
-- ─────────────────────────────────────────────────────────────────────────
create table idempotency_keys (
  key          text primary key,
  actor_id     uuid not null,
  command_name text not null,
  state        text not null default 'reserved' check (state in ('reserved','completed')),
  response     jsonb,
  error        jsonb,
  created_at   timestamptz not null default now()
);

create table outbox (
  id              uuid primary key default gen_random_uuid(),
  aggregate_type  text not null,
  aggregate_id    uuid not null,
  sequence        bigint not null,
  event_name      text not null,
  payload         jsonb not null,
  correlation_id  text not null,
  state           work_state not null default 'queued',
  attempt_count   int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  occurred_at     timestamptz not null default now(),
  delivered_at    timestamptz,
  unique (aggregate_type, aggregate_id, sequence)
);
-- Supports the ordered claim: earliest pending sequence per aggregate.
create index outbox_pending_idx on outbox (aggregate_type, aggregate_id, sequence)
  where state not in ('ready','dead_letter');

create table event_deliveries (
  id              uuid primary key default gen_random_uuid(),
  outbox_id       uuid not null references outbox(id) on delete cascade,
  consumer        text not null,
  state           work_state not null default 'queued',
  attempt_count   int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  unique (outbox_id, consumer)
);

create table dead_letters (
  id              uuid primary key default gen_random_uuid(),
  source          text not null,
  event_name      text not null,
  aggregate_type  text not null,
  aggregate_id    uuid not null,
  payload         jsonb not null,
  correlation_id  text not null,
  failure_history jsonb not null default '[]'::jsonb,
  replay_count    int not null default 0,
  created_at      timestamptz not null default now()
);

-- Append-only. No update or delete policy exists for this table, by design.
create table audit_events (
  id             uuid primary key default gen_random_uuid(),
  actor_id       uuid not null,
  action         text not null,
  resource_type  text not null,
  resource_id    text not null,
  before         jsonb,
  after          jsonb,
  correlation_id text not null,
  created_at     timestamptz not null default now()
);
create index audit_events_resource_idx on audit_events (resource_type, resource_id);

-- ─────────────────────────────────────────────────────────────────────────
-- P1/P2 Canonical Experience + media
-- ─────────────────────────────────────────────────────────────────────────
create table experiences (
  id             uuid primary key default gen_random_uuid(),
  actor_id       uuid not null references actors(id) on delete cascade,
  kind           experience_kind not null,
  creation_mode  creation_mode not null,
  category       text not null,
  body_text      text not null default '' check (char_length(body_text) <= 280),
  status         experience_status not null default 'draft',
  visibility     visibility_mode not null default 'public',
  alias_id       uuid references aliases(id) on delete set null,
  media_asset_id uuid,
  correlation_id text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  published_at   timestamptz,
  deleted_at     timestamptz,
  version        int not null default 1,
  -- Text mode is text-bearing; voice mode may carry no text at all.
  constraint text_mode_requires_body check (creation_mode <> 'text' or char_length(body_text) >= 1),
  -- An alias may only be attached to alias visibility, and is required for it.
  constraint alias_matches_visibility check (
    (visibility = 'alias' and alias_id is not null) or (visibility <> 'alias' and alias_id is null)
  )
);
create index experiences_actor_idx on experiences (actor_id);
create index experiences_published_idx on experiences (published_at desc) where status = 'published';

create table media_assets (
  id                uuid primary key default gen_random_uuid(),
  experience_id     uuid references experiences(id) on delete cascade,
  reply_id          uuid,
  kind              text not null check (kind in ('audio','image')),
  -- Internal only. Never granted to any client role. See the grants below.
  original_key      text not null,
  -- Public-facing derivative. Null until protection succeeds.
  protected_key     text,
  duration_ms       int not null check (duration_ms between 1000 and 120000),
  byte_size         bigint not null check (byte_size > 0 and byte_size <= 8388608),
  mime_type         text not null check (mime_type in ('audio/webm','audio/ogg','audio/mp4','audio/mpeg')),
  processing_status work_state not null default 'queued',
  protection_status protection_status not null default 'queued',
  protection_findings jsonb not null default '{}'::jsonb,
  attempt_count     int not null default 0,
  failure_reason    text,
  created_at        timestamptz not null default now(),
  -- A protected asset must have somewhere to serve from.
  constraint protected_requires_key check (protection_status <> 'protected' or protected_key is not null)
);
create index media_assets_experience_idx on media_assets (experience_id);

alter table experiences
  add constraint experiences_media_fk foreign key (media_asset_id) references media_assets(id) on delete set null;

create table upload_targets (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid not null references actors(id) on delete cascade,
  experience_id uuid not null references experiences(id) on delete cascade,
  storage_key   text not null,
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null,
  consumed_at   timestamptz
);

-- ─────────────────────────────────────────────────────────────────────────
-- P8 Voice intelligence
-- ─────────────────────────────────────────────────────────────────────────
create table transcripts (
  id                 uuid primary key default gen_random_uuid(),
  media_asset_id     uuid not null references media_assets(id) on delete cascade,
  -- Internal only. Never granted to any client role.
  raw_text           text,
  -- Public-facing. Present only once redaction has run.
  redacted_text      text,
  language           text,
  confidence         numeric(4,3),
  processing_status  work_state not null default 'queued',
  attempt_count      int not null default 0,
  failure_reason     text,
  provider           text not null,
  redaction_findings jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  unique (media_asset_id)
);

-- ─────────────────────────────────────────────────────────────────────────
-- P7 Conversation
-- ─────────────────────────────────────────────────────────────────────────
create table replies (
  id              uuid primary key default gen_random_uuid(),
  experience_id   uuid not null references experiences(id) on delete cascade,
  parent_reply_id uuid references replies(id) on delete cascade,
  actor_id        uuid not null references actors(id) on delete cascade,
  creation_mode   creation_mode not null,
  body_text       text not null default '' check (char_length(body_text) <= 280),
  visibility      visibility_mode not null default 'public',
  alias_id        uuid references aliases(id) on delete set null,
  media_asset_id  uuid references media_assets(id) on delete set null,
  status          experience_status not null default 'draft',
  depth           int not null default 0 check (depth between 0 and 4),
  created_at      timestamptz not null default now()
);
create index replies_experience_idx on replies (experience_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────
-- P6 Engagement — Ragers-native mechanics
-- ─────────────────────────────────────────────────────────────────────────
create table reactions (
  id            uuid primary key default gen_random_uuid(),
  experience_id uuid not null references experiences(id) on delete cascade,
  actor_id      uuid not null references actors(id) on delete cascade,
  reaction_type reaction_type not null,
  created_at    timestamptz not null default now(),
  unique (experience_id, actor_id, reaction_type)
);

create table fair_votes (
  id            uuid primary key default gen_random_uuid(),
  experience_id uuid not null references experiences(id) on delete cascade,
  actor_id      uuid not null references actors(id) on delete cascade,
  is_fair       boolean not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- One vote per actor per experience: a recast updates, never duplicates.
  unique (experience_id, actor_id)
);

create table experience_counters (
  experience_id uuid primary key references experiences(id) on delete cascade,
  been_there    int not null default 0,
  same          int not null default 0,
  fair_point    int not null default 0,
  disagree      int not null default 0,
  fair_yes      int not null default 0,
  fair_no       int not null default 0,
  reply_count   int not null default 0
);

-- ─────────────────────────────────────────────────────────────────────────
-- P5 Feed projection — deliberately has no actor_id column
-- ─────────────────────────────────────────────────────────────────────────
create table feed_entries (
  experience_id  uuid primary key references experiences(id) on delete cascade,
  kind           experience_kind not null,
  creation_mode  creation_mode not null,
  category       text not null,
  excerpt        text not null,
  identity_label text not null,
  identity_kind  visibility_mode not null,
  has_voice      boolean not null default false,
  duration_ms    int,
  published_at   timestamptz not null,
  rank_score     numeric not null default 0,
  suppressed     boolean not null default false
);
create index feed_entries_rank_idx on feed_entries (rank_score desc, published_at desc) where not suppressed;

-- ─────────────────────────────────────────────────────────────────────────
-- P11 Search projection — no actor_id, redacted text only
-- ─────────────────────────────────────────────────────────────────────────
create table search_documents (
  experience_id   uuid primary key references experiences(id) on delete cascade,
  kind            experience_kind not null,
  category        text not null,
  searchable_text text not null,
  subject_terms   text[] not null default '{}',
  identity_label  text not null,
  has_voice       boolean not null default false,
  published_at    timestamptz not null
);
create index search_documents_text_idx on search_documents using gin (to_tsvector('english', searchable_text));

-- ─────────────────────────────────────────────────────────────────────────
-- P9 Trust & safety
-- ─────────────────────────────────────────────────────────────────────────
create table reports (
  id                uuid primary key default gen_random_uuid(),
  target_type       target_type not null,
  target_id         uuid not null,
  reporter_actor_id uuid not null references actors(id) on delete cascade,
  reason_code       report_reason not null,
  status            text not null default 'open' check (status in ('open','reviewed','closed')),
  created_at        timestamptz not null default now()
);

create table moderation_queue (
  id          uuid primary key default gen_random_uuid(),
  target_type target_type not null,
  target_id   uuid not null,
  priority    int not null default 0,
  state       text not null default 'queued' check (state in ('queued','claimed','actioned','released')),
  claimed_by  uuid references actors(id) on delete set null,
  claimed_at  timestamptz,
  created_at  timestamptz not null default now(),
  unique (target_type, target_id)
);

create table moderation_actions (
  id             uuid primary key default gen_random_uuid(),
  target_type    target_type not null,
  target_id      uuid not null,
  moderator_id   uuid not null references actors(id),
  action         moderation_action_kind not null,
  reason         text not null,
  correlation_id text not null,
  created_at     timestamptz not null default now()
);

create table screenings (
  id          uuid primary key default gen_random_uuid(),
  target_type target_type not null,
  target_id   uuid not null,
  outcome     text not null check (outcome in ('clear','needs_review')),
  signals     text[] not null default '{}',
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- P12 Subject graph
-- ─────────────────────────────────────────────────────────────────────────
create table subjects (
  id                uuid primary key default gen_random_uuid(),
  canonical_term    text not null,
  kind              text not null check (kind in ('behavior','context','place_type')),
  parent_subject_id uuid references subjects(id) on delete set null,
  experience_count  int not null default 0,
  state             text not null default 'candidate' check (state in ('candidate','canonical','merged','retired')),
  merged_into_id    uuid references subjects(id) on delete set null,
  unique (canonical_term)
);

create table experience_subjects (
  id            uuid primary key default gen_random_uuid(),
  experience_id uuid not null references experiences(id) on delete cascade,
  subject_id    uuid not null references subjects(id) on delete cascade,
  weight        numeric not null default 1,
  source        text not null check (source in ('category','extracted')),
  unique (experience_id, subject_id)
);

-- ─────────────────────────────────────────────────────────────────────────
-- P13 Social graph
-- ─────────────────────────────────────────────────────────────────────────
create table graph_edges (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('follow','block','mute')),
  actor_id   uuid not null references actors(id) on delete cascade,
  target_ref text not null check (target_ref in ('actor','alias')),
  target_id  uuid not null,
  created_at timestamptz not null default now(),
  unique (kind, actor_id, target_ref, target_id),
  constraint no_self_edge check (actor_id <> target_id)
);
create index graph_edges_actor_idx on graph_edges (actor_id, kind);

-- ─────────────────────────────────────────────────────────────────────────
-- P14 Notifications
-- ─────────────────────────────────────────────────────────────────────────
create table notifications (
  id                 uuid primary key default gen_random_uuid(),
  recipient_actor_id uuid not null references actors(id) on delete cascade,
  kind               text not null,
  subject_ref        target_type not null,
  subject_id         uuid not null,
  actor_label        text not null,
  dedupe_key         text not null,
  state              text not null default 'pending' check (state in ('pending','delivered','read','suppressed')),
  suppression_reason text,
  created_at         timestamptz not null default now(),
  read_at            timestamptz,
  -- Fan-out is idempotent: at-least-once delivery cannot duplicate a notification.
  unique (recipient_actor_id, dedupe_key)
);
create index notifications_recipient_idx on notifications (recipient_actor_id, created_at desc);

create table notification_preferences (
  id       uuid primary key default gen_random_uuid(),
  actor_id uuid not null references actors(id) on delete cascade,
  kind     text not null,
  enabled  boolean not null default true,
  unique (actor_id, kind)
);

-- ─────────────────────────────────────────────────────────────────────────
-- P15 Reputation
-- ─────────────────────────────────────────────────────────────────────────
create table actor_reputation (
  actor_id             uuid primary key references actors(id) on delete cascade,
  experiences_published int not null default 0,
  fair_yes_received    int not null default 0,
  fair_no_received     int not null default 0,
  approval_rate        numeric(5,4) not null default 0,
  removals_received    int not null default 0,
  standing             standing_tier not null default 'new',
  -- Moderator/admin only. Not granted to member/anon; excluded from the public view.
  internal_signals     jsonb not null default '{}'::jsonb,
  updated_at           timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- P16 Ranking & trends
-- ─────────────────────────────────────────────────────────────────────────
create table ranking_inputs (
  experience_id      uuid primary key references experiences(id) on delete cascade,
  engagement_score   numeric not null default 0,
  fairness_score     numeric not null default 0,
  recency_decay      numeric not null default 1,
  balance_adjustment numeric not null default 0,
  final_score        numeric not null default 0,
  computed_at        timestamptz not null default now()
);

create table trends (
  id          uuid primary key default gen_random_uuid(),
  subject_id  uuid not null references subjects(id) on delete cascade,
  window      trend_window not null,
  kind        experience_kind not null,
  volume      int not null default 0,
  velocity    numeric not null default 0,
  state       text not null default 'emerging' check (state in ('emerging','trending','cooling','expired')),
  computed_at timestamptz not null default now(),
  unique (subject_id, window, kind)
);

-- ─────────────────────────────────────────────────────────────────────────
-- P17 Creator control
-- ─────────────────────────────────────────────────────────────────────────
create table deletion_requests (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid not null references actors(id) on delete cascade,
  target_type  target_type not null,
  target_id    uuid not null,
  state        text not null default 'requested' check (state in ('requested','propagating','completed','partially_failed')),
  propagation  jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

create table export_requests (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid not null references actors(id) on delete cascade,
  state        work_state not null default 'queued',
  artifact_key text,
  created_at   timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- P18 Governance
-- ─────────────────────────────────────────────────────────────────────────
create table role_assignments (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid not null references actors(id) on delete cascade,
  role       actor_role not null,
  granted_by uuid not null references actors(id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- ─────────────────────────────────────────────────────────────────────────
-- P19 Analytics — pseudonymous, content-free by construction
-- ─────────────────────────────────────────────────────────────────────────
create table analytics_events (
  id             uuid primary key default gen_random_uuid(),
  event_name     text not null,
  -- A stable hash, never an actor_id. There is no FK here on purpose.
  actor_hash     text not null,
  properties     jsonb not null default '{}'::jsonb,
  correlation_id text not null,
  occurred_at    timestamptz not null default now()
);
create index analytics_events_name_idx on analytics_events (event_name, occurred_at desc);

create table metric_snapshots (
  id          uuid primary key default gen_random_uuid(),
  metric_name text not null,
  window      text not null,
  value       numeric not null,
  computed_at timestamptz not null default now(),
  unique (metric_name, window, computed_at)
);
