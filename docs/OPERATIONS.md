# Ragers Engine — Operations Runbook

**Classification:** Internal. Never published or linked from a public surface (`CLAUDE.md`).

This is the operational half of Phase 20. It covers running, deploying, and
recovering the engine. The certification gates that depend on a live
environment (deployment, backup/restore, rollback) are documented here and are
recorded as external blockers in `docs/EVIDENCE.md` until an environment exists.

---

## 1. Topology

```
                        ┌──────────────────────────┐
  visitor ──────────────▶  Static landing page      │  index.html / styles.css / script.js
                        │  (any static host)        │  no build step, deploys anywhere
                        └──────────────────────────┘
                                    │  "Create" / "Sign in"
                                    ▼
                        ┌──────────────────────────┐
  member ───────────────▶  Next.js web tier         │  engine/app  (App Router)
                        │  route handlers → bus     │  RAGERS_DISABLE_WORKER=1
                        └──────────┬───────────────┘
                                   │ commands (idempotent, correlated)
                                   ▼
                        ┌──────────────────────────┐
                        │  Postgres / Supabase      │  experiences, outbox, projections
                        └──────────┬───────────────┘
                                   │ outbox rows
                                   ▼
                        ┌──────────────────────────┐
                        │  Delivery worker          │  engine/scripts/worker.ts
                        │  orchestrator.drain()     │  projections, protection, enrichment
                        └──────────────────────────┘
```

The web tier and the delivery worker are the same code with different entry
points, so a consumer cannot drift from the command that emits its event.

**Run exactly one drain loop.** The web tier starts one in-process by default,
which is correct for a single node. Once you run a separate worker, set
`RAGERS_DISABLE_WORKER=1` on the web tier — otherwise both drain, which is
harmless (consumers are idempotent) but doubles redundant work.

## 2. Local development

```bash
cd engine
npm install
npm test          # 200+ assertions, no external dependencies
npm run typecheck # strict, zero errors expected
npm run dev       # http://localhost:3001
npm run certify   # runs every gate and rewrites docs/EVIDENCE.md
```

The default adapters are in-memory: state lives in the process and is lost on
restart. That is deliberate for development and for the test suite. It also
means **a multi-node deployment must configure the Postgres adapters** — with
in-memory adapters, two nodes cannot see each other's data.

## 3. Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | production | Postgres connection string. |
| `SUPABASE_URL` | production | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | production | Server-side key. Bypasses RLS, so it must never reach a browser bundle. |
| `SUPABASE_ANON_KEY` | production | Client key. Subject to RLS. |
| `RAGERS_ANALYTICS_SALT` | production | Salt for analytics pseudonymisation. Rotating it re-pseudonymises future rows; it does not de-anonymise past ones. |
| `RAGERS_DISABLE_WORKER` | when running a separate worker | Set to `1` on the web tier. |
| `RAGERS_MEDIA_BUCKET` | production | Object storage bucket for media. |
| `RAGERS_CHROMIUM` | optional | Chromium path for the browser E2E gate. |

Only `NEXT_PUBLIC_`-prefixed variables reach the browser. No key above carries
that prefix, and none should.

## 4. Deploying

1. **Migrate first, deploy second.** Every migration to date is additive, so the
   previous release keeps working against the new schema — which is what makes
   rollback possible without a data restore.
   ```bash
   psql "$DATABASE_URL" -f engine/supabase/migrations/0001_engine_core.sql
   psql "$DATABASE_URL" -f engine/supabase/migrations/0002_rls_policies.sql
   ```
2. **Certify.** `cd engine && npm run certify`. Do not deploy on a
   `RAGERS_ENGINE_E2E_NO_GO`.
3. **Deploy the web tier**, then the worker. Web first is safe: commands queue in
   the outbox and are delivered when the worker arrives. Worker first is also
   safe — it simply has nothing to do.
4. **Verify.** `curl -fsS https://<host>/api/health` must report `healthy`. A
   `degraded` state names the dependency; `unhealthy` returns 503.
5. **Watch the outbox.** Rising `pendingCount` after deploy means the worker is
   not draining. Check that exactly one drain loop is running.

### Post-deploy checks

| Check | Expectation |
|---|---|
| `/api/health` | `state: healthy`, both dependencies healthy |
| Outbox depth | Returns to near zero within a minute |
| Dead letters | No new records; any new one is an incident, not noise |
| Publish a test Rage and Rave | Both appear on the feed |
| Publish a voice note | Reaches `protected` and appears with a duration |

## 5. Rollback

Rollback is code-only. **Do not roll back a migration to roll back a release.**

```bash
# 1. Redeploy the previous image/commit for the web tier and the worker.
#    Migrations are additive, so the previous release runs against the new schema.
# 2. Confirm health and outbox drain.
curl -fsS https://<host>/api/health
```

Because the migrations are additive, the only rollback that needs a schema
change is one that removed or narrowed a column — which is why a migration that
does either must ship as its own release, after the code that stopped using it.

**If the outbox has grown during a bad release:** leave it. Consumers are
idempotent and delivery is at-least-once, so the restored release drains the
backlog correctly. Do not truncate the outbox to make a graph look better —
that discards state changes that already happened.

**Dead letters accumulated during a bad release:** fix the cause, then replay
them from the admin console (`governance.replayDeadLetter`). Replay is
idempotent, so replaying more than once is safe.

## 6. Backup and restore

**What must be backed up**

| Data | Why it cannot be reconstructed |
|---|---|
| `experiences`, `replies`, `actors`, `aliases` | Source of truth. |
| `reactions`, `fair_votes`, `reports`, `moderation_actions` | Source of truth. |
| `audit_events` | Append-only and legally meaningful. |
| `outbox`, `dead_letters` | In-flight state changes that have not been delivered. |
| Media objects | The protected derivatives are what the product serves. |

**What need not be backed up** — every projection (`feed_entries`,
`search_documents`, `experience_counters`, `experience_subjects`,
`ranking_inputs`, `trends`, `actor_reputation`). All of them are derived, and
all of them are rebuilt by replaying the source facts. Restoring them is an
optimisation, never a requirement.

**Backup**

```bash
pg_dump "$DATABASE_URL" --format=custom --file="ragers-$(date -u +%Y%m%dT%H%M%SZ).dump"
# Media is versioned in object storage; mirror the bucket on the same schedule.
```

Managed Postgres point-in-time recovery covers the same ground; the dump exists
so a restore does not depend on one provider being available.

**Restore drill** — this is the gate marked blocked in `docs/EVIDENCE.md`. Run it
against a scratch database, never production:

```bash
createdb ragers_restore_test
pg_restore --dbname=ragers_restore_test --clean --if-exists ragers-<timestamp>.dump
```

Then assert:

1. Row counts for `experiences`, `actors`, `audit_events` match the source.
2. `select count(*) from outbox where state not in ('ready','dead_letter')` —
   undelivered events survived, so nothing in flight was lost.
3. Point a worker at the restored database and drain. Projections rebuild.
4. Spot-check that `media_assets.protected_key` values resolve in object storage.
5. Confirm RLS is still enabled: every table in `0002_rls_policies.sql` should
   report `relrowsecurity = true` in `pg_class`. A restore that loses RLS is a
   privacy incident, not a configuration detail.

**Recovery objectives** (to be agreed with the business, recorded here as the
current working assumption): RPO 5 minutes via PITR, RTO 1 hour.

## 7. Incident response

| Symptom | First check | Action |
|---|---|---|
| Feed empty but posts succeed | Outbox depth rising | No drain loop is running. Start the worker. |
| Voice notes stuck "protecting" | `media_assets.protection_status` | `failed` retries on its own; `dead_letter` needs the provider fixed, then replay. |
| Publishes stuck in `pending_moderation` | Dead letters from `moderation.screen` | Screening is failing closed, which is correct. Fix screening, then replay. |
| Removed content still visible | `search_documents` / `feed_entries` for that id | Purge propagation failed. Replay `ContentRemoved`. Treat as a privacy incident. |
| Notifications duplicated | `notifications.dedupe_key` uniqueness | The constraint is missing; the migration did not fully apply. |
| Dead-letter count climbing | Which consumer | Fix the cause before replaying; replaying into a broken consumer just re-fails. |

**Escalate as a privacy incident, not a bug**, if any of these is ever observed:
content readable after removal or deletion, an `original_key` or `raw_text`
reaching a client, an actor identifier on an anonymous experience, or a
notification crossing a block boundary. Each has a dedicated regression test —
so start by finding out why the test did not catch it.

## 8. Scaling notes

- The web tier is stateless once the Postgres adapters are configured; scale it
  horizontally.
- The drain loop claims **one pending event per aggregate**, which preserves
  per-aggregate ordering. Multiple workers are safe (consumers are idempotent)
  but will do redundant work; partition by aggregate before adding workers.
- Head-of-line blocking is intentional: an aggregate whose earliest event is
  backing off holds its own later events, and nothing else.
- `counters.recompute`, `reputation.recompute` and `ranking.compute` recompute
  from rows rather than incrementing, so they are safe to re-run at any time and
  are the repair tool for drift.
