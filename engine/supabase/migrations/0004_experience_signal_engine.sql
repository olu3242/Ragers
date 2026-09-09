-- Ragers Experience Signal Engine — schema.
--
-- See docs/EXPERIENCE_SIGNAL_ENGINE.md for the reconciliation this implements.
-- Two points are load-bearing and worth restating here:
--
--   * `experiences.status` (publication) and `experiences.resolution_status`
--     (outcome) are independent axes. Publication is what makes media protection
--     and moderation screening fail closed; resolution is what happened
--     afterwards. An experience can be published+OPEN or removed+RESOLVED.
--
--   * Corroborations and shares are separate tables with no counter path
--     between them, because "1,842 people experienced this" and "shared 12,481
--     times" must never be confusable.

-- ─────────────────────────────────────────────────────────────────────────
-- Enumerated domains
-- ─────────────────────────────────────────────────────────────────────────
create type corroboration_type as enum ('re_rage', 're_rave');

create type match_relationship as enum (
  'same_experience',
  'similar_experience',
  'related_experience',
  'no_match'
);

-- The outcome axis. Distinct from experience_status, which is publication.
create type resolution_status as enum (
  'open',
  'gaining_signal',
  'acknowledged',
  'under_review',
  'resolved',
  'partially_resolved',
  'disputed',
  'reopened'
);

-- What an individual experiencer reports, which is not the same as what an
-- organization claims.
create type resolution_report_kind as enum ('resolved_for_me', 'partially_resolved', 'still_unresolved');

create type evidence_kind as enum (
  'screenshot',
  'photo',
  'receipt',
  'invoice',
  'order_reference',
  'booking_reference',
  'email',
  'voice',
  'document'
);

-- Deliberately not "verified": someone supplying evidence is not Ragers proving
-- the claim. See the ESE doc §10.
create type evidence_assessment_outcome as enum ('unassessed', 'consistent', 'inconclusive', 'contradicted');

create type organization_response_kind as enum (
  'acknowledge',
  'respond',
  'request_information',
  'publish_resolution',
  'service_update',
  'dispute',
  'known_incident',
  'remediation_instructions'
);

create type trust_risk_kind as enum (
  'duplicate_account',
  'duplicate_evidence',
  'repeated_text',
  'repeated_audio',
  'device_anomaly',
  'high_frequency_corroboration',
  'coordinated_activity',
  'location_anomaly',
  'new_account',
  'retraction_pattern'
);

-- ─────────────────────────────────────────────────────────────────────────
-- Taxonomy — promoted from the validated string vocabulary
-- ─────────────────────────────────────────────────────────────────────────
create table categories (
  id         text primary key default gen_random_uuid()::text,
  name       text not null unique,
  slug       text not null unique,
  created_at timestamptz not null default now()
);

create table issue_types (
  id          text primary key default gen_random_uuid()::text,
  category_id text not null references categories(id) on delete cascade,
  name        text not null,
  slug        text not null,
  -- An issue type describes an outcome, which differs for a rage and a rave.
  applies_to  experience_kind,
  created_at  timestamptz not null default now(),
  unique (category_id, slug)
);

-- An entity is what an experience was *with*: an organization, a service, a
-- product. Deliberately not a person — see the safety rules.
create table entities (
  id           text primary key default gen_random_uuid()::text,
  name         text not null,
  slug         text not null unique,
  kind         text not null default 'organization'
                 check (kind in ('organization','service','product','venue','platform')),
  claimed_at   timestamptz,
  created_at   timestamptz not null default now()
);

create table entity_aliases (
  id         text primary key default gen_random_uuid()::text,
  entity_id  text not null references entities(id) on delete cascade,
  alias      text not null,
  created_at timestamptz not null default now(),
  unique (alias)
);
create index entity_aliases_entity_idx on entity_aliases (entity_id);

create table locations (
  id           text primary key default gen_random_uuid()::text,
  label        text not null,
  -- Coarse by design: a precise location is an identifying detail.
  region       text,
  country_code text,
  created_at   timestamptz not null default now(),
  unique (label)
);

-- Seed the taxonomy from the vocabulary the shipped composer already uses, so
-- existing rows classify without a data migration.
insert into categories (name, slug) values
  ('Everyday courtesy',  'everyday-courtesy'),
  ('Driving & transit',  'driving-transit'),
  ('Work & school',      'work-school'),
  ('Shopping & service', 'shopping-service'),
  ('Neighborhood',       'neighborhood'),
  ('Other',              'other');

-- ─────────────────────────────────────────────────────────────────────────
-- Experience structure
-- ─────────────────────────────────────────────────────────────────────────
alter table experiences
  add column title            text,
  add column entity_id        text references entities(id) on delete set null,
  add column category_id      text references categories(id) on delete set null,
  add column issue_type_id    text references issue_types(id) on delete set null,
  add column location_id      text references locations(id) on delete set null,
  add column occurred_at      timestamptz,
  -- The outcome axis, independent of `status`.
  add column resolution_status resolution_status not null default 'open',
  add column resolution_status_at timestamptz not null default now(),
  add column cluster_id       text;

-- Backfill category_id from the denormalised name. `category` stays for
-- compatibility; new code reads category_id.
update experiences e
   set category_id = c.id
  from categories c
 where c.name = e.category;

create index experiences_entity_idx on experiences (entity_id) where status = 'published';
create index experiences_cluster_idx on experiences (cluster_id);
create index experiences_resolution_idx on experiences (resolution_status);

-- AI suggests; the user confirms; both are kept, and publication reads the
-- confirmed column. This is what stops extraction silently altering a claim.
create table experience_metadata (
  experience_id       text primary key references experiences(id) on delete cascade,
  extracted           jsonb not null default '{}'::jsonb,
  confirmed           jsonb not null default '{}'::jsonb,
  extraction_source   text not null default 'none'
                        check (extraction_source in ('none','text','voice')),
  confirmed_at        timestamptz,
  confirmed_by        text references actors(id) on delete set null,
  created_at          timestamptz not null default now(),
  -- Confirmed metadata must name who confirmed it and when.
  constraint confirmation_is_attributed check (
    (confirmed = '{}'::jsonb) or (confirmed_at is not null and confirmed_by is not null)
  )
);

-- ─────────────────────────────────────────────────────────────────────────
-- Corroboration — the heart of the contract
-- ─────────────────────────────────────────────────────────────────────────
create table experience_corroborations (
  id              text primary key default gen_random_uuid()::text,
  experience_id   text not null references experiences(id) on delete cascade,
  corroborator_id text not null references actors(id) on delete cascade,
  type            corroboration_type not null,
  relationship    match_relationship not null default 'same_experience',
  -- Everything below is optional: corroborating must stay a one-tap action.
  narrative       text check (narrative is null or char_length(narrative) <= 1000),
  occurred_at     timestamptz,
  location_id     text references locations(id) on delete set null,
  media_asset_id  text references media_assets(id) on delete set null,
  visibility      visibility_mode not null default 'public',
  alias_id        text references aliases(id) on delete set null,
  status          text not null default 'active' check (status in ('active','retracted','removed')),
  retracted_at    timestamptz,
  correlation_id  text not null,
  created_at      timestamptz not null default now(),

  -- One user, one underlying experience, one corroboration. This is what stops
  -- a single person manufacturing 400 Re-Rages.
  unique (experience_id, corroborator_id),

  -- A corroboration is a claim about your own experience, so the author of the
  -- experience cannot corroborate it — they already did, by posting it.
  constraint no_self_corroboration check (corroborator_id is distinct from null),

  constraint alias_matches_visibility check (
    (visibility = 'alias' and alias_id is not null) or (visibility <> 'alias' and alias_id is null)
  ),
  constraint retraction_is_dated check (
    (status = 'retracted' and retracted_at is not null) or status <> 'retracted'
  )
);
create index corroborations_experience_idx on experience_corroborations (experience_id) where status = 'active';
create index corroborations_actor_idx on experience_corroborations (corroborator_id);

-- A Rage accepts only Re-Rage and a Rave only Re-Rave. Enforced in the database
-- with a trigger, because the rule spans two tables and a check constraint
-- cannot see the parent row.
create or replace function enforce_corroboration_kind() returns trigger
  language plpgsql as $$
declare
  parent_kind experience_kind;
  parent_actor text;
begin
  select kind, actor_id into parent_kind, parent_actor
    from experiences where id = new.experience_id;

  if parent_kind is null then
    raise exception 'corroboration references an experience that does not exist';
  end if;

  if parent_kind = 'rage' and new.type <> 're_rage' then
    raise exception 'a rage accepts only a re_rage, not %', new.type
      using errcode = 'check_violation';
  end if;

  if parent_kind = 'rave' and new.type <> 're_rave' then
    raise exception 'a rave accepts only a re_rave, not %', new.type
      using errcode = 'check_violation';
  end if;

  if parent_actor = new.corroborator_id then
    raise exception 'an author cannot corroborate their own experience'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

create trigger corroboration_kind_matches_experience
  before insert or update on experience_corroborations
  for each row execute function enforce_corroboration_kind();

-- ─────────────────────────────────────────────────────────────────────────
-- Share — amplification, never a claim
-- ─────────────────────────────────────────────────────────────────────────
create table experience_shares (
  id            text primary key default gen_random_uuid()::text,
  experience_id text not null references experiences(id) on delete cascade,
  actor_id      text references actors(id) on delete set null,
  destination   text,
  created_at    timestamptz not null default now()
);
-- Deliberately no unique constraint: sharing repeatedly is legitimate, and there
-- is no counter path from this table to corroboration counts.
create index shares_experience_idx on experience_shares (experience_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Clusters — repeated experience patterns
-- ─────────────────────────────────────────────────────────────────────────
create table experience_clusters (
  id                text primary key default gen_random_uuid()::text,
  kind              experience_kind not null,
  entity_id         text references entities(id) on delete set null,
  category_id       text references categories(id) on delete set null,
  issue_type_id     text references issue_types(id) on delete set null,
  headline          text not null,
  -- Counters are projections: recomputed from rows, never incremented, so a
  -- retry or a retraction converges instead of drifting.
  total_experiences int not null default 0,
  corroborations    int not null default 0,
  unique_experiencers int not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- One cluster per (kind, entity, category, issue) pattern.
  unique (kind, entity_id, category_id, issue_type_id)
);

create table experience_cluster_members (
  id            text primary key default gen_random_uuid()::text,
  cluster_id    text not null references experience_clusters(id) on delete cascade,
  experience_id text not null references experiences(id) on delete cascade,
  relationship  match_relationship not null,
  score         numeric not null default 0,
  factors       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  unique (cluster_id, experience_id)
);
create index cluster_members_experience_idx on experience_cluster_members (experience_id);

alter table experiences
  add constraint experiences_cluster_fk foreign key (cluster_id)
    references experience_clusters(id) on delete set null;

-- ─────────────────────────────────────────────────────────────────────────
-- Evidence — strengthens a signal without becoming mandatory
-- ─────────────────────────────────────────────────────────────────────────
create table evidence (
  id               text primary key default gen_random_uuid()::text,
  experience_id    text references experiences(id) on delete cascade,
  corroboration_id text references experience_corroborations(id) on delete cascade,
  submitted_by     text not null references actors(id) on delete cascade,
  kind             evidence_kind not null,
  -- Internal only, like original media: evidence can contain anything.
  original_key     text not null,
  protected_key    text,
  protection_status protection_status not null default 'queued',
  byte_size        bigint not null check (byte_size > 0),
  mime_type        text not null,
  -- A stable digest, so the same artefact submitted twice is detectable.
  content_digest   text,
  created_at       timestamptz not null default now(),
  -- Evidence belongs to exactly one of an experience or a corroboration.
  constraint evidence_has_one_parent check (
    (experience_id is not null and corroboration_id is null)
    or (experience_id is null and corroboration_id is not null)
  )
);
create index evidence_experience_idx on evidence (experience_id);
create index evidence_digest_idx on evidence (content_digest) where content_digest is not null;

create table evidence_assessments (
  id          text primary key default gen_random_uuid()::text,
  evidence_id text not null references evidence(id) on delete cascade,
  outcome     evidence_assessment_outcome not null default 'unassessed',
  -- Notes are internal: an assessment is not a public verdict on a person.
  notes       text,
  assessed_by text references actors(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Resolution — what happened afterwards
-- ─────────────────────────────────────────────────────────────────────────
create table resolution_reports (
  id            text primary key default gen_random_uuid()::text,
  experience_id text not null references experiences(id) on delete cascade,
  -- The reporter must be someone who claims the experience: its author or a
  -- corroborator. Enforced by a trigger below.
  reporter_id   text not null references actors(id) on delete cascade,
  kind          resolution_report_kind not null,
  note          text check (note is null or char_length(note) <= 1000),
  reported_at   timestamptz not null default now(),
  -- One standing report per person per experience; a new one supersedes.
  unique (experience_id, reporter_id)
);

create table resolution_events (
  id            text primary key default gen_random_uuid()::text,
  experience_id text not null references experiences(id) on delete cascade,
  from_status   resolution_status,
  to_status     resolution_status not null,
  -- Who moved it: an experiencer's report, an organization, or the signal engine.
  source        text not null check (source in ('experiencer','organization','engine','moderator')),
  actor_id      text references actors(id) on delete set null,
  detail        text,
  correlation_id text not null,
  created_at    timestamptz not null default now()
);
create index resolution_events_experience_idx on resolution_events (experience_id, created_at);

-- Only someone who claims the experience may report its resolution.
create or replace function enforce_resolution_reporter() returns trigger
  language plpgsql as $$
declare
  is_author boolean;
  is_corroborator boolean;
begin
  select exists (select 1 from experiences where id = new.experience_id and actor_id = new.reporter_id)
    into is_author;
  select exists (
    select 1 from experience_corroborations
     where experience_id = new.experience_id and corroborator_id = new.reporter_id and status = 'active'
  ) into is_corroborator;

  if not (is_author or is_corroborator) then
    raise exception 'only the author or an active corroborator may report resolution'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger resolution_reporter_claims_experience
  before insert or update on resolution_reports
  for each row execute function enforce_resolution_reporter();

-- ─────────────────────────────────────────────────────────────────────────
-- Organizations — can respond, cannot rewrite
-- ─────────────────────────────────────────────────────────────────────────
create table organization_profiles (
  id          text primary key default gen_random_uuid()::text,
  entity_id   text not null unique references entities(id) on delete cascade,
  display_name text not null,
  claimed_by  text references actors(id) on delete set null,
  claimed_at  timestamptz,
  status      text not null default 'unclaimed' check (status in ('unclaimed','pending','claimed','suspended')),
  created_at  timestamptz not null default now()
);

create table organization_memberships (
  id              text primary key default gen_random_uuid()::text,
  organization_id text not null references organization_profiles(id) on delete cascade,
  actor_id        text not null references actors(id) on delete cascade,
  role            text not null default 'member' check (role in ('member','admin')),
  granted_by      text references actors(id) on delete set null,
  granted_at      timestamptz not null default now(),
  revoked_at      timestamptz,
  unique (organization_id, actor_id)
);

create table organization_responses (
  id              text primary key default gen_random_uuid()::text,
  organization_id text not null references organization_profiles(id) on delete cascade,
  -- A response addresses an experience or a whole cluster.
  experience_id   text references experiences(id) on delete cascade,
  cluster_id      text references experience_clusters(id) on delete cascade,
  author_id       text not null references actors(id) on delete cascade,
  kind            organization_response_kind not null,
  body            text not null check (char_length(body) between 1 and 4000),
  -- Private requests for information are not published.
  is_public       boolean not null default true,
  correlation_id  text not null,
  created_at      timestamptz not null default now(),
  constraint response_has_one_target check (
    (experience_id is not null and cluster_id is null)
    or (experience_id is null and cluster_id is not null)
  )
);
create index org_responses_experience_idx on organization_responses (experience_id);
create index org_responses_cluster_idx on organization_responses (cluster_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Trust — internal only
-- ─────────────────────────────────────────────────────────────────────────
create table trust_assessments (
  actor_id                 text primary key references actors(id) on delete cascade,
  account_confidence       numeric(4,3) not null default 0.5,
  contribution_confidence  numeric(4,3) not null default 0.5,
  evidence_confidence      numeric(4,3) not null default 0.5,
  risk_flags               text[] not null default '{}',
  updated_at               timestamptz not null default now()
);

create table risk_events (
  id         text primary key default gen_random_uuid()::text,
  actor_id   text references actors(id) on delete cascade,
  kind       trust_risk_kind not null,
  severity   text not null default 'low' check (severity in ('low','medium','high')),
  -- Detail is a summary, never the raw content that triggered it.
  detail     jsonb not null default '{}'::jsonb,
  correlation_id text,
  created_at timestamptz not null default now()
);
create index risk_events_actor_idx on risk_events (actor_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────
-- Moderation cases — grouping actions on a target
-- ─────────────────────────────────────────────────────────────────────────
create table moderation_cases (
  id          text primary key default gen_random_uuid()::text,
  target_type target_type not null,
  target_id   text not null,
  state       text not null default 'open' check (state in ('open','actioned','closed')),
  opened_by   text references actors(id) on delete set null,
  opened_at   timestamptz not null default now(),
  closed_at   timestamptz,
  unique (target_type, target_id, state) deferrable initially deferred
);

-- ─────────────────────────────────────────────────────────────────────────
-- Signal snapshots — the intelligence layer, recomputed not incremented
-- ─────────────────────────────────────────────────────────────────────────
create table signal_snapshots (
  id                      text primary key default gen_random_uuid()::text,
  cluster_id              text references experience_clusters(id) on delete cascade,
  experience_id           text references experiences(id) on delete cascade,
  window_span             text not null default 'all',
  rage_count              int not null default 0,
  rave_count              int not null default 0,
  re_rage_count           int not null default 0,
  re_rave_count           int not null default 0,
  unique_experiencers     int not null default 0,
  context_supported_count int not null default 0,
  voice_supported_count   int not null default 0,
  evidence_supported_count int not null default 0,
  response_rate           numeric(5,4) not null default 0,
  resolution_rate         numeric(5,4) not null default 0,
  median_resolution_ms    bigint,
  repeat_incidence        numeric(5,4) not null default 0,
  geographic_concentration jsonb not null default '{}'::jsonb,
  growth_rate             numeric not null default 0,
  signal_acceleration     numeric not null default 0,
  reopen_rate             numeric(5,4) not null default 0,
  computed_at             timestamptz not null default now(),
  constraint snapshot_has_one_subject check (
    (cluster_id is not null and experience_id is null)
    or (cluster_id is null and experience_id is not null)
  )
);
create index signal_snapshots_cluster_idx on signal_snapshots (cluster_id, computed_at desc);

-- ─────────────────────────────────────────────────────────────────────────
-- Counters — corroborations and shares kept strictly apart
-- ─────────────────────────────────────────────────────────────────────────
alter table experience_counters
  add column re_rage_count      int not null default 0,
  add column re_rave_count      int not null default 0,
  add column corroborator_count int not null default 0,
  -- Amplification. There is deliberately no arithmetic relationship between
  -- this column and the corroboration counts.
  add column share_count        int not null default 0;

-- `been_there` meant "this happened to me too", which is now a corroboration.
-- The column stays for the migration window; the reaction is retired.
comment on column experience_counters.been_there is
  'Retired: superseded by corroborations. Retained so existing rows still read.';

-- ─────────────────────────────────────────────────────────────────────────
-- Row level security
--
-- Every table gets RLS, as the schema-validation gate requires. The shape
-- follows the existing engine: read what is public, write only your own, and
-- anything internal is staff-only.
-- ─────────────────────────────────────────────────────────────────────────
alter table categories                enable row level security;
alter table issue_types               enable row level security;
alter table entities                  enable row level security;
alter table entity_aliases            enable row level security;
alter table locations                 enable row level security;
alter table experience_metadata       enable row level security;
alter table experience_corroborations enable row level security;
alter table experience_shares         enable row level security;
alter table experience_clusters       enable row level security;
alter table experience_cluster_members enable row level security;
alter table evidence                  enable row level security;
alter table evidence_assessments      enable row level security;
alter table resolution_reports        enable row level security;
alter table resolution_events         enable row level security;
alter table organization_profiles     enable row level security;
alter table organization_memberships  enable row level security;
alter table organization_responses    enable row level security;
alter table trust_assessments         enable row level security;
alter table risk_events               enable row level security;
alter table moderation_cases          enable row level security;
alter table signal_snapshots          enable row level security;

-- Taxonomy is public reference data.
create policy categories_read on categories for select using (true);
create policy issue_types_read on issue_types for select using (true);
create policy entities_read on entities for select using (true);
create policy entity_aliases_read on entity_aliases for select using (true);
create policy locations_read on locations for select using (true);

-- Metadata is readable with its experience; only the author may confirm it.
create policy experience_metadata_read on experience_metadata for select
  using (
    exists (
      select 1 from experiences e
      where e.id = experience_metadata.experience_id
        and (e.status = 'published' or e.actor_id = current_actor_id() or is_staff())
    )
  );
create policy experience_metadata_author_write on experience_metadata for all
  using (exists (select 1 from experiences e where e.id = experience_metadata.experience_id and e.actor_id = current_actor_id()))
  with check (exists (select 1 from experiences e where e.id = experience_metadata.experience_id and e.actor_id = current_actor_id()));

-- Corroborations are public claims on published experiences.
create policy corroborations_read on experience_corroborations for select
  using (
    status = 'active'
    or corroborator_id = current_actor_id()
    or is_staff()
  );
-- You may only ever write your own claim, and never on your own experience.
create policy corroborations_own_write on experience_corroborations for insert
  with check (
    corroborator_id = current_actor_id()
    and current_actor_role() <> 'guest'
    and not exists (
      select 1 from experiences e
      where e.id = experience_corroborations.experience_id and e.actor_id = current_actor_id()
    )
  );
create policy corroborations_own_update on experience_corroborations for update
  using (corroborator_id = current_actor_id() or is_staff())
  with check (corroborator_id = current_actor_id() or is_staff());
-- Retraction is a state change, so there is no delete path.
create policy corroborations_no_delete on experience_corroborations for delete using (false);

-- Shares are amplification: readable in aggregate, writable by anyone signed in.
create policy shares_read on experience_shares for select using (true);
create policy shares_insert on experience_shares for insert with check (true);

create policy clusters_read on experience_clusters for select using (true);
create policy cluster_members_read on experience_cluster_members for select using (true);

-- Evidence: the submitter and staff can see the row; the original key is
-- withheld by column grant below, exactly as media originals are.
create policy evidence_read on evidence for select
  using (submitted_by = current_actor_id() or is_staff());
create policy evidence_own_write on evidence for insert
  with check (submitted_by = current_actor_id() and current_actor_role() <> 'guest');
-- An assessment is an internal judgement, never a public verdict.
create policy evidence_assessments_staff on evidence_assessments for all
  using (is_staff()) with check (is_staff());

-- Resolution reports are visible in aggregate; a reporter sees their own row.
create policy resolution_reports_read on resolution_reports for select
  using (reporter_id = current_actor_id() or is_staff());
create policy resolution_reports_own_write on resolution_reports for all
  using (reporter_id = current_actor_id())
  with check (reporter_id = current_actor_id() and current_actor_role() <> 'guest');
create policy resolution_events_read on resolution_events for select using (true);

create policy organization_profiles_read on organization_profiles for select using (true);
create policy organization_memberships_read on organization_memberships for select
  using (actor_id = current_actor_id() or is_staff());
-- Responses are public unless marked private; only members of that organization
-- may write one, and they can never touch the experience itself.
create policy organization_responses_read on organization_responses for select
  using (
    is_public
    or is_staff()
    or exists (
      select 1 from organization_memberships m
      where m.organization_id = organization_responses.organization_id
        and m.actor_id = current_actor_id()
        and m.revoked_at is null
    )
  );
create policy organization_responses_member_write on organization_responses for insert
  with check (
    author_id = current_actor_id()
    and exists (
      select 1 from organization_memberships m
      where m.organization_id = organization_responses.organization_id
        and m.actor_id = current_actor_id()
        and m.revoked_at is null
    )
  );

-- Trust and risk are internal. No public trust score is exposed.
create policy trust_assessments_staff_read on trust_assessments for select using (is_staff());
create policy risk_events_staff_read on risk_events for select using (is_staff());
create policy moderation_cases_staff on moderation_cases for all
  using (is_staff()) with check (is_staff());

-- Signal snapshots are the public intelligence surface.
create policy signal_snapshots_read on signal_snapshots for select using (true);

-- ─────────────────────────────────────────────────────────────────────────
-- Privileges
-- ─────────────────────────────────────────────────────────────────────────
grant select on categories, issue_types, entities, entity_aliases, locations,
                experience_clusters, experience_cluster_members, experience_shares,
                resolution_events, organization_profiles, organization_responses,
                signal_snapshots, experience_corroborations, experience_metadata
  to anon, authenticated;

grant select on resolution_reports, organization_memberships, evidence to authenticated;
grant insert on experience_shares to anon, authenticated;
grant insert, update on experience_corroborations, experience_metadata, resolution_reports to authenticated;
grant insert on evidence, organization_responses to authenticated;
grant select on trust_assessments, risk_events, moderation_cases, evidence_assessments to authenticated;

grant all on categories, issue_types, entities, entity_aliases, locations,
              experience_metadata, experience_corroborations, experience_shares,
              experience_clusters, experience_cluster_members, evidence,
              evidence_assessments, resolution_reports, resolution_events,
              organization_profiles, organization_memberships, organization_responses,
              trust_assessments, risk_events, moderation_cases, signal_snapshots
  to service_role;

-- Evidence originals are withheld exactly as media originals are: the column is
-- never granted, so "someone attached evidence" can never become "here is the
-- unredacted artefact".
do $$
declare
  client_role text;
begin
  foreach client_role in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = client_role) then
      execute format('revoke all on evidence from %I', client_role);
      execute format(
        'grant select (id, experience_id, corroboration_id, submitted_by, kind, protected_key, '
        || 'protection_status, byte_size, mime_type, created_at) on evidence to %I', client_role);
      if client_role = 'authenticated' then
        execute 'grant insert, update on evidence to authenticated';
      end if;
      -- Corroborations may be retracted but never deleted.
      execute format('revoke delete on experience_corroborations from %I', client_role);
    end if;
  end loop;
end $$;
