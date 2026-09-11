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

**B — Intelligence** *(delivered — see §6.2)*
Normalization with user confirmation · matching · clustering · signal
aggregation · evidence · trust assessments.

**C — Outcome and surface** *(delivered — see §6.3)*
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

## 6.2 Batch B — intelligence

Normalization, matching, clustering, signal aggregation, evidence and trust.

### The rule that shapes all of it

**Structure comes from confirmation, not from extraction.** Extraction writes to
`extracted`; confirmation writes to `confirmed`; matching, clustering and the
signal read `confirmed` alone. An unconfirmed suggestion is scored as *unknown*
(0.5) rather than as agreement (1), which is why `identifierAgreement`
distinguishes the two at all.

The alternative — using extraction when nobody objected — would let a misread
company name reassign someone's experience to a company they never mentioned, and
would do it most often to the people least likely to check. So an experience
nobody confirmed joins no cluster, however unambiguous its wording, and that is
demonstrated rather than asserted: two experiences with *identical text* about an
unconfirmed entity produce zero clusters.

### Deterministic agreement decides; similarity only refines

`matchExperiences` gates on entity and issue before the score is consulted.
Different entity → `no_match`, whatever the wording. Text similarity can weaken
or qualify a relationship the identifiers already permit; it can never create
one. Cluster membership records the relationship *and* the factor breakdown, so a
person reviewing a cluster can check the reasoning rather than trust it.

### What the signal deliberately is not

Named metrics, never a single score: how many people, how much context, how often
it repeats, how much is unresolved. There is a test asserting the public signal
exposes no key containing `score`, `outrage`, `severity` or `rank`, because
collapsing these into one number is how a system starts optimising for the
loudest thing instead of the most serious one.

### Evidence, without overclaiming

Assessment outcomes are `consistent`, `inconclusive`, `contradicted` — what a
reviewer can actually determine. **`verified` is refused at the boundary**: no
artefact establishes that events happened as described, and labelling some
experiences verified would implicitly brand the rest as doubted. Evidence is also
optional, because requiring it would silence the people least able to produce it.
Re-uploading the same artefact is deduplicated by digest, so a support count is
not inflatable by re-upload, and nothing can be assessed before protection has
run.

### Trust, internal only

Three separate confidences — account, contribution, evidence — never one score,
and never public. A brand-new account with a careful, well-corroborated report is
low on account confidence and high on contribution confidence; flattening that
loses the only part that matters. Everything derives from durable facts (account
age, published experiences, upheld reports, moderation outcomes), never from tone:
a furious, accurate report must not cost its author trust. A member cannot read a
trust assessment even for themselves — asserted against live RLS as a real client
role.

Coordinated-burst detection raises a **flag and an event, never an action**. Six
people corroborating within minutes is recorded as one finding for the window,
and every one of those six corroborations remains active and counted. Arriving in
a burst is not evidence that any individual claim is false, and treating it that
way would punish people for a pattern they did not know they were part of. Risk
rows carry a summary, never the content that triggered them.

### A safety change this work forced

The PII detector reads any pair of capitalised words as a possible person name, so
"Northwind Air" tripped it and every experience naming a company routed to human
review. At any real volume that means the reports most worth reading are the ones
sitting in a queue. Spans matching a **known entity or alias** are therefore no
longer treated as person names. Nothing else is relaxed: an unknown capitalised
pair still stops publication, and a phone number still does even alongside a known
entity. Both directions are tested.

### Two more adapter traps closed

The numeric-column list had the same shape as the timestamp list that failed in
Batch A: hand-maintained, and now missing ten Experience Signal Engine columns.
Postgres returns `numeric` and `bigint` as strings, so an unlisted metric reads
back as `"0.5"`, renders fine, and silently concatenates the first time anything
adds to it. The list is extended and a schema test now asserts every numeric and
bigint column in the migrations appears in it.

Separately, the guard against JavaScript-predicate filtering had a hole: its regex
required the arrow on the same line, so any multi-line predicate call was
invisible to it. Tightening it exposed **eight pre-existing full-table scans** in
governance, graph, notification, ranking, reputation and safety — bounded by a
10,000-row scan limit, which means silently truncated results in production. All
eight are now declarative criteria.

## 6.3 Batch C — outcome and surface

Resolution lifecycle, organization responses, language guidance, the UI, and the
browser certification of the whole flow.

### A response is not a resolution

Enforced in three places, so no single layer is the guarantee. The domain refuses
an organization-sourced move to a resolved state; the engine refuses it again; and
the organization has no write path to `experiences` at all, so there is nothing to
resolve *with*. Even `publish_resolution` — an organization's account of a fix — is
recorded as their account and leaves the outcome where it was. What an
organization *can* do to the outcome axis is acknowledge it, put it under review,
or dispute it, and a dispute is recorded as a disagreement between two accounts
rather than a correction of the first.

The UI states this rather than implying it. Where a response exists, the card says
in words: *"The organization has responded. That is their account, not a
resolution."* Conflating the two is the specific misreading this product cannot
afford, so it is answered on the surface and not only in the schema.

### `resolved` needs everyone who claims the experience

Two changes fell out of building this, both in the conservative direction:

- **Everyone, not every reporter.** If one of three experiencers says it was fixed
  for them and the other two have said nothing, the status is `partially_resolved`.
  Counting only reporters would let an organization close a pattern by satisfying
  whoever complained loudest, and would do it before the others had a chance to
  speak. `resolutionFromReports` now takes the experiencer count.
- **A resolution that stops holding is reopened.** When every report says it is
  still unresolved, that means nothing new on a fresh experience, but on one
  already marked resolved it means the fix did not hold. Leaving it resolved would
  make the outcome a one-way door.

A third change was to the state machine: `open → resolved` is now a legal
transition. Requiring a path through review would have let an organization hold an
outcome open by staying silent, and the invariant is protected by the *source*
guard, not by the path — an organization is refused whichever route it takes.

### Language guidance advises; it never rewrites

The composer offers observations about a draft and returns no rewritten text. The
only finding that blocks is a threat. Everything else — an attack on the person
rather than the behaviour, an absolute claim, an account too short for anyone to
recognise — is advice. A filter that rewrote an account would put words in
someone's mouth, and one that blocked on wording would fall hardest on people
writing in a second language or writing while upset, which is most people when
something has gone wrong. The two things that *do* block publication are unchanged
and live elsewhere: identifying details, and naming a private individual.

### The test-only fixture route

The browser flow needs taxonomy rows and a claimed organization, so there is a
fixture endpoint — and it is a genuine hazard: reachable in a deployment, it would
let anyone enrol themselves as an organization's staff, which is exactly what the
organization rules exist to prevent. It is therefore gated on an explicit
`RAGERS_TEST_SEED` flag rather than on `NODE_ENV`, answers as though it does not
exist when the flag is absent, and a test asserts the guard precedes the first
write. The browser suite runs two servers: one with the flag, one without — and
asserts the route returns 404 on the second, which is the server a deployment
matches.

### Certification

Both statuses are now emitted, and they are separate on purpose: the platform can
be held short of READY by a missing deployment target while the corroboration
contract is fully certified, and conflating them would hide whichever of the two is
actually broken. `npm run certify` exits non-zero on either
`RAGERS_ENGINE_E2E_NO_GO` or `EXPERIENCE_SIGNAL_ENGINE_NOT_READY`.

Against a live Postgres 16 and a real browser:

```
33 gates passed · 0 failed · 2 blocked
RAGERS_ENGINE_E2E_READY_WITH_EXTERNAL_BLOCKERS
EXPERIENCE_SIGNAL_ENGINE_READY
```

The two blocked gates are deployment and the rollback drill, both waiting on the
same missing dependency: no deployment target is configured. Neither is an ESE
gate, which is why the Experience Signal Engine reports a plain READY.

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
