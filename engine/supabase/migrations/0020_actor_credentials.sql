-- ─────────────────────────────────────────────────────────────────────────
-- RC3 — a sign-in credential
--
-- Until this table existed there was no way to prove you were the account you claimed to
-- be. `identity.authenticate` took an email address, found the actor and issued a session,
-- so knowing a moderator's or an admin's address was enough to become them. RC2 closed
-- that by refusing every sign-in by default, which was correct and left the product with
-- no way for anybody to come back — the blocker that conditions `SECURITY_READY`.
--
-- ## Why its own table and not columns on `actors`
--
--   * **The grants differ, and that is the whole point.** `actors` is partly readable by
--     client roles; this table is readable by **no** client role on any path, which is a
--     property a column on a readable table cannot have.
--   * A credential is replaceable and an account is not, so rotating one must not write
--     the other's row — and `rotated_at` belongs to the credential's history, not the
--     person's.
--
-- ## What is deliberately not here
--
--   * **No plaintext, and nothing reversible.** A salt and a derived key. There is no
--     column from which a password could be recovered, which is why "forgot password" has
--     to be a reset rather than a reminder.
--   * **No role, no entitlement, no organization.** Authority lives on the actor and is
--     checked against the policy matrix. A credential that could carry a role would be a
--     second authority model beside the first one, and the two would disagree.
--   * **No reset token.** A one-time token needs something that delivers it to an address
--     the person controls, and no email or SMS provider exists in this repository yet. A
--     token table nothing can deliver is not a recovery mechanism, so it is named as
--     missing in `docs/releases/RAGERS_RC3_DEPLOYMENT.md` rather than half-built here.
--   * **No attempt log.** `failed_attempts` is a counter and not a history: a row per
--     attempt would be a record of when somebody was struggling to get into their own
--     account, kept forever, to no operational end.
-- ─────────────────────────────────────────────────────────────────────────

create table actor_credentials (
  -- The actor id *is* the key: one actor holds at most one credential, enforced by the
  -- primary key rather than by a uniqueness rule somebody could forget to add.
  actor_id        text primary key references actors(id) on delete cascade,

  -- Stored per row, so raising the cost later is a rotation rather than a migration and a
  -- row written under the old parameters keeps verifying until its owner next signs in.
  algorithm       text not null check (algorithm in ('scrypt')),
  params          jsonb not null,

  -- base64. Distinct per credential, so two people choosing the same password do not share
  -- a hash and a precomputed table is worthless.
  salt            text not null check (length(salt) >= 32),
  hash            text not null check (length(hash) >= 32),

  created_at      timestamptz not null default now(),
  rotated_at      timestamptz not null default now(),

  -- Consecutive failures since the last success, and the instant before which no attempt is
  -- considered. Both live on the credential rather than on a caller because a per-actor
  -- window cannot express "this caller" — the gap `docs/architecture/ENGINE_GAPS.md`
  -- records. The trade-off is stated in `src/domain/credential.ts`: this throttles guessing
  -- at one known account, and also lets somebody who knows an address make that account
  -- wait. Per-caller throttling at the edge is the proper answer and is not code.
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  throttle_expires_at timestamptz,

  -- Named `_at` because that is how the Postgres adapter recognises a timestamptz column and
  -- converts it to and from epoch milliseconds. A timestamp column outside the convention is
  -- not an error, it is a wrong value — which is the worse failure.
  -- A window without the failures that earned it would be a lock nobody could explain.
  constraint credential_throttle_has_failures check (
    throttle_expires_at is null or failed_attempts > 0
  ),
  -- Rotation moves forward. A `rotated_at` before `created_at` would make "when was this
  -- last changed" answer wrongly in exactly the case somebody is investigating.
  constraint credential_rotation_follows_creation check (rotated_at >= created_at)
);

-- Answering "does this account have a credential yet" for one actor, which is the only
-- question any read path asks. There is deliberately no index supporting a sweep for
-- accounts *without* one: that query is a target list.
create index actor_credentials_rotated_at_idx on actor_credentials (rotated_at desc);

alter table actor_credentials enable row level security;

-- ── Grants ───────────────────────────────────────────────────────────────
--
-- **No policy is created, and no grant is issued to `anon` or `authenticated`.** With RLS
-- enabled and no policy, every client-role read and write returns nothing — including for
-- the person the row is about, which is correct: there is nothing here they could use.
-- Verification happens inside the engine on the owner connection, and the Phase 69 tenant
-- isolation sweep holds this table to that rule.
--
-- `service_role` gets what it needs and no more: no `delete`, because a credential is
-- removed by the account being closed (`on delete cascade`) rather than on its own, and a
-- credential deleted while the account lives would silently return that account to the
-- state this whole migration exists to end.
grant select, insert, update on actor_credentials to service_role;

comment on table actor_credentials is
  'RC3 sign-in credentials. Unreadable by every client role on every path. No plaintext, nothing reversible, no role.';
