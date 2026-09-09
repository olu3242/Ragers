# Ragers Experience Signal Engine

**Status:** v1.0 — reconciliation and architecture
**Classification:** Internal. Never published or linked from a public surface (`CLAUDE.md`).

This document reconciles the Experience Signal Engine against the engine already
shipped in this repository, records the decisions that reconciliation forces, and
sets the implementation order. It exists so the ESE is a *migration* of the
existing engine rather than a second system beside it.

---

## 1. The product contract

Five interactions, with distinct meanings that must hold at the database, API,
analytics and UX layers — not only in labels.

| Interaction | Claim | Counts toward |
|---|---|---|
| **RAGE** | "This happened to me and something went wrong." | experiences |
| **RE-RAGE** | "This happened to me too." | corroborations |
| **RAVE** | "This happened to me and something went exceptionally well." | experiences |
| **RE-RAVE** | "I experienced this positive outcome too." | corroborations |
| **SHARE** | "I want others to see this, but I am not claiming I experienced it." | amplification only |

The consequence that drives the whole design: `1,842 Re-Rages` must mean *1,842
people claiming this happened to them*, while `12,481 Shares` means only that it
is being amplified. A single table that conflates the two destroys the product's
central signal, so they are separate tables with separate counters.

## 2. What already exists

The shipped engine is closer to this than it looks: the primary domain object is
already `Experience`, not `Post`.

| ESE requirement | Already shipped | Verdict |
|---|---|---|
| Experience as primary object | `experiences` aggregate, kind `rage`/`rave`, creation mode `text`/`voice` | **Reuse.** Extend with structure. |
| Voice as first-class input | Recorder state machine, upload targets, protection pipeline, transcription behind a provider port | **Reuse.** Add fact extraction and confirmation. |
| Durable event architecture | Command bus, transactional outbox, leased jobs, retries, dead letters, idempotency | **Reuse as-is.** ESE events ride this. |
| Persistence + authorization | Postgres, RLS on every table, live-certified | **Reuse.** Extend with new tables. |
| Language safety / moderation | Pre-publish screening that fails closed; person-naming routes to human review | **Reuse.** Add composer guidance. |
| Feed and ranking | Feed projection, deterministic ranking, Rage/Rave balance adjustment | **Extend** with signal strength and manipulation penalties. |
| Search + subject graph | Privacy-safe index, behaviour-term extraction | **Reuse** as matching inputs. |
| Trust signals | Reputation engine derived from durable facts | **Extend** into trust assessments and risk events. |
| Audit | Append-only, immutable, admin-only | **Reuse as-is.** |
| Corroboration | — | **New.** The heart of the ESE. |
| Entities, categories, issue types, locations | Category exists only as a validated string | **New tables**, seeded from the existing vocabulary. |
| Matching, clustering, signal aggregation | — | **New.** |
| Evidence, resolution, organization responses | — | **New.** |

## 3. Decisions this reconciliation forces

Four collisions have to be resolved deliberately rather than silently. Each is
recorded here with its rationale, because each changes something already
certified.

### 3.1 Two status axes, not one

The ESE specifies `ExperienceStatus` as an *outcome* lifecycle
(`OPEN → GAINING_SIGNAL → ACKNOWLEDGED → UNDER_REVIEW → RESOLVED`, plus
`PARTIALLY_RESOLVED`, `DISPUTED`, `REOPENED`).

The shipped engine already has `status` as a *publication* lifecycle
(`draft → validating → pending_media → pending_moderation → published → …`),
and that column is load-bearing: it is what makes media protection and
moderation screening fail closed. Certified evidence depends on an experience
being unpublishable while its audio is unprotected or its text unscreened.

**Decision: keep both, on separate columns.**

- `status` — publication state. Answers *may anyone see this?*
- `resolution_status` — outcome state. Answers *what happened afterwards?*

Collapsing them into one enum would mean an experience could be `RESOLVED` while
its media was still unprotected, or that publishing and resolving shared a state
machine. Both are wrong. The two axes are genuinely independent: an experience
can be `published` + `OPEN`, or `removed` + `RESOLVED`.

Note that `UNDER_REVIEW` appears on both axes with different meanings —
moderation reviewing the *content* versus an organization reviewing the *issue*.
They are distinct columns and must never be read interchangeably.

### 3.2 Corroboration replaces "Been There"; the other reactions stay

The shipped reaction vocabulary is `been_there`, `same`, `fair_point`,
`disagree`. `been_there` means "this happened to me too" — which is exactly
RE-RAGE.

Keeping both would give the product two different "me too" signals with
different weights and different tables, which is precisely the conflation the
ESE exists to eliminate.

**Decision: retire `been_there`. Re-Rage/Re-Rave replaces it.**

`same`, `fair_point` and `disagree` remain, because they are *responses* to a
claim rather than claims of their own:

| | Meaning | Weight |
|---|---|---|
| Re-Rage / Re-Rave | I experienced this | A claim. Counts as corroboration. |
| Same | I recognise this | A reaction. Never counts as corroboration. |
| Fair Point / Disagree | I judge the framing | A reaction. |
| Fair Rager? vote | Is this fair to the subject? | A fairness signal, unchanged. |

Existing `been_there` rows migrate to corroborations, since that is what their
authors meant. Shipped as `0006_retire_been_there.sql`, which is deliberately
conservative about what it puts in people's mouths: a migrated claim gets
`similar_experience`, not `same_experience`, because a Been There tap never said
anything about whether it was the same incident; and it gets `anonymous`
visibility, because reactions were never identity-scoped and the safe reading is
the least exposing one. The author's own taps migrate to nothing — posting was
already the claim. The `been_there` enum value and counter column both remain
(an enum value cannot be dropped additively, and unreleased clients still read
the column), but nothing writes either again: the boundary refuses the type with
a message naming Re-Rage, and the counter recompute carries the old value
forward untouched.

### 3.3 Category becomes a real taxonomy

`category` is currently a validated string from a six-value list. Matching and
clustering need entity, category and issue type as joinable, aliasable records.

**Decision: promote to tables** (`categories`, `issue_types`, `entities`,
`entity_aliases`, `locations`), seed `categories` from the existing six values,
and keep the denormalised `category` text on `experiences` during migration so
nothing that reads it breaks. New code reads `category_id`.

### 3.4 Subjects feed matching; clusters are new

The shipped subject graph extracts *behaviour terms* from redacted text. A
cluster is a *repeated experience pattern* keyed by (entity, category, issue
type). These are not the same thing and neither replaces the other.

**Decision:** subjects become one input to the matching engine's semantic factor.
Clusters are a new first-class object.

## 4. Domain model

```
              ┌───────────────────────────────────────────────┐
   text ─┐    │  EXPERIENCE INTAKE                            │
  voice ─┼───▶│  validate → protect media → screen            │
  photo ─┤    │  (publication gate: fails closed)             │
evidence ┘    └───────────────────┬───────────────────────────┘
                                  ▼
              ┌───────────────────────────────────────────────┐
              │  NORMALIZATION                                │
              │  entity · category · issue · time · location   │
              │  AI suggests · the user confirms · both kept   │
              └───────────────────┬───────────────────────────┘
                                  ▼
              ┌───────────────────────────────────────────────┐
              │  EXPERIENCE  (rage | rave)                    │
              │  status: publication · resolution_status      │
              └──────┬─────────────────────────┬──────────────┘
                     ▼                         ▼
             CORROBORATION              SHARE (never counts)
           (RE_RAGE | RE_RAVE)
                     │
                     ▼
              ┌───────────────────────────────────────────────┐
              │  MATCHING   deterministic factors + semantic  │
              │  SAME · SIMILAR · RELATED · NO_MATCH          │
              └───────────────────┬───────────────────────────┘
                                  ▼
                            CLUSTER  ──▶  SIGNAL  ──▶  DISCOVERY
                                  │                     ORGANIZATIONS
                                  ▼
                            RESOLUTION REPORTS
```

## 5. Invariants, and where each is enforced

The ESE's invariants are enforced as close to the data as possible, because an
invariant enforced only in application code is one process away from being
violated.

| Invariant | Enforcement |
|---|---|
| One corroboration per user per experience | `unique (experience_id, corroborator_id)` |
| A Rage accepts only Re-Rage | check constraint tying corroboration type to experience kind, plus a domain guard |
| A Rave accepts only Re-Rave | same |
| An author cannot corroborate their own experience | check constraint + RLS `with check` |
| Share never counts as corroboration | separate table; no counter path between them |
| Retry/replay cannot double-count | idempotency keys on commands; counters recomputed from rows, never incremented |
| Retracting a corroboration updates aggregates | recompute-from-rows, so a delete converges like an insert |
| Organization responses cannot modify user claims | responses are their own table; RLS gives organizations no write path to `experiences` |
| AI never silently alters the claim | extracted and confirmed metadata are separate columns; publication reads confirmed |
| Trust and moderation decisions are auditable | existing append-only `audit_events` |

## 6. Implementation order

Dependency-ordered, in three batches.

**A — Foundation and corroboration (the contract itself)**
Taxonomy tables · experience structure · corroboration · shares · the atomic
invariants under concurrency.

**B — Intelligence**
Normalization with user confirmation · matching · clustering · signal
aggregation · evidence · trust assessments.

**C — Outcome and surface**
Resolution lifecycle and reports · organization responses · feed and discovery
ranking · language-safety composer · UI · browser certification of the full
vertical slice.

## 6.1 Batch A — what shipped, and what running it found

Batch A is complete: taxonomy tables, experience structure, corroboration,
shares, and the atomic invariants under real concurrency.

Executing it against a live Postgres — rather than reasoning about it — surfaced
five defects that no amount of static review would have found. They are recorded
here because each one was a property the code claimed to have.

| Defect | Why it mattered | Fix |
|---|---|---|
| The duplicate-corroboration check was read-then-write, on a row keyed by a fresh id per attempt | Eight simultaneous taps produced eight corroborations in memory. One person could manufacture a corroboration count. | Corroborations are keyed on `experience_id:corroborator_id`, and the store gained `compareAndSet` — the one primitive that can tell the winner of a race from the losers. `put` is an upsert and structurally cannot. |
| The Postgres outbox allocated `sequence` as `max(sequence) + 1` | Two people corroborating the same experience at the same moment allocated the same sequence; the unique index turned one of them into a conflict error they had done nothing to earn. Six concurrent claimants: three failed. | An explicit per-aggregate counter (`outbox_sequences`), incremented in the same statement that inserts the event. This is what the in-memory adapter always did — the two were not at parity under concurrency. |
| The adapter's timestamp columns were a hand-maintained list | `retracted_at` was missing from it, so retracting a corroboration wrote epoch milliseconds into a `timestamptz` and failed. Every future timestamp column had the same trap waiting. | Recognised by convention (`<name>_at`), with a schema test asserting the migrations keep to the convention in both directions. |
| Two consumers each wrote the whole `experience_counters` row from its own view | The reaction consumer zeroed `re_rage_count`, and the corroboration consumer zeroed `same` — silently in memory, where a `put` replaces the record, and inconsistently in Postgres, where an omitted column keeps its value. | One `recomputeCounters` shared by both, recomputing every field from rows. |
| The outbox was not transactional with the state change | A process dying between a handler's rows and its event committed a state change whose event never existed — a corroboration whose count never moves. | The Postgres `Db` carries an ambient transaction scope, and the bus opens one transaction around the transition and the append. No engine changed. |
| An optional field absent from a written row cleared in memory but persisted in Postgres | A re-claim after a retraction left `retracted_at` dated in the database and cleared in memory. | The field is written explicitly rather than omitted, and adapter parity now asserts the clearing case. |

The last three are not corroboration bugs. They are adapter-parity bugs that the
corroboration work happened to be the first to exercise, which is the argument
for asserting the same behaviour against both adapters rather than trusting one.

### Closed: the outbox is now transactional with the state change

Batch A found the outbox pattern only half-implemented. The command bus wrote the
handler's rows, then appended to the outbox as a separate statement — so a
process that died between the two committed a state change whose event never
existed, leaving every projection derived from it permanently behind. A
corroboration that exists but whose count never moves is precisely the failure
the ESE exists to prevent, so this could not be deferred.

The fix keeps the burden off the handlers. Threading a transaction-scoped store
through every command would mean each handler had to remember to use it, and one
that forgot is one silent dual write. Instead the Postgres `Db` carries an
ambient transaction scope (`AsyncLocalStorage`): whatever `Db` a store was built
over routes to the current transaction's client while one is open, and to the
pool otherwise. The bus opens one transaction around the domain transition and
the append; no engine changed.

Idempotency completion stays deliberately *outside* that transaction. Rolling it
back with the rest would let a retry re-run a command whose effects had already
committed.

Proven by failing on purpose: `tests/live/outbox.atomicity.test.ts` breaks the
outbox insert with a `not valid` check constraint so the handler's rows are
already written when the failure lands, then asserts the corroboration row is
gone too. With the transaction removed the test fails, which is what makes it
evidence rather than decoration.

## 7. Certification boundary

The ESE is certified on this flow, proven in a browser against a real database:

> Create Rage → publish → another user Re-Rages → corroboration count increases
> → context/voice attaches → the experience appears in a cluster → signal metrics
> update → an organization responds → original experiencers report resolution →
> aggregate resolution metrics update.

Status values are `EXPERIENCE_SIGNAL_ENGINE_READY`,
`EXPERIENCE_SIGNAL_ENGINE_READY_WITH_BLOCKERS`, or
`EXPERIENCE_SIGNAL_ENGINE_NOT_READY`, reported alongside the existing engine
certification rather than replacing it.
