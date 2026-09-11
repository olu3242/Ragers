# Ragers Foundation RC1

**Classification:** Internal. Never linked from a public surface (`CLAUDE.md`).

**Frozen at:** `d4283d8` — *Command boundary hardening: bad input is refused, never
reported as a defect*
**Branch:** `claude/affectionate-archimedes-3ex8ws` (PR #5)
**Date:** 2026-09-10

---

## What RC1 means, and what it does not

RC1 means **the code foundation is frozen**: phases 1–50 are implemented, the twelve
engines own every capability, and the invariants that separate measuring from
deciding are certified by execution rather than asserted in prose.

RC1 **does not mean production-ready.** Nothing here has been deployed, no rollback
has been drilled, no live model or transcription provider has been exercised, no
object storage exists, and no environment holds enough real data to produce a
benchmark. Those are external-readiness tracks, listed below, and they are separate
from this freeze on purpose: freezing the foundation is what makes it possible to
work on them without the ground moving.

Read a claim of readiness in this document as scoped to code. Where the code is
ready and the world is not, the status says so in its own words —
`CODE_READY_DATA_BLOCKED` is a real value, not a euphemism.

---

## Runtime ownership — settled

The **TypeScript engine in `engine/`** is the sole authoritative runtime.

PR #6 is **closed**, not merged and not parked. It proposed a second runtime on the
same `engine/` path, and its `dispute()` / `resolve()` were unguarded — any caller
could mark an experience resolved with no notion of experiencer consent, which
contradicts a rule this branch certifies. Disposition is recorded in three places a
reader is likely to hit, so no future reader can treat both as authoritative:

- the closed pull request itself,
- `docs/architecture/ENGINE_RUNTIME_CONFLICT.md` (§ Settled),
- `docs/architecture/CONVERGENCE_1_50.md`.

One capability was **ported** — `fingerprint()`, over confirmed structure only, with
a non-unique index because two people may legitimately have identical accounts of
the same failure. The independent-signal thresholds survive as **reference**
calibration. Everything else is **discarded**: the bespoke server, snapshot
persistence, in-memory aggregates, the in-process outbox, and the dispute/resolve
state machinery.

---

## The twelve engines

Engines are permanent ownership; phases are delivery. Full contracts —
commands, queries, events, states, permissions, persistence, tests — are in
`docs/architecture/RAGERS_12_ENGINE_ARCHITECTURE.md`.

| | Engine | Owns |
|---|---|---|
| E1 | Experience | the canonical aggregate and its lifecycle |
| E2 | Capture | voice and media, fail-closed protection |
| E3 | Declaration | normalization, confirmation, structure |
| E4 | Trust | safety, PII, moderation, trust assessment |
| E5 | Publishing | feed, search, visibility at read time |
| E6 | Community | corroboration, conversation, relation, graph |
| E7 | Clustering | matching, clusters, near-duplicates |
| E8 | Signals | severity, urgency, impact, priority, aggregation |
| E9 | Business Response | organizations, responses, cases, integrations |
| E10 | Outcomes | resolution, aging, escalation, dispute |
| E11 | Reputation | contribution, responsiveness, benchmarking |
| E12 | Intelligence | proposals, agents, handoff, copilot boundary |

**There is no Engine 13.** The Experience Signal Engine is owned by E3, E4, E7, E8,
E9 and E10. Nothing in phases 31–50 created a new engine either.

Three things are deliberately **not** engines, with the reason stated:

- **Identity** — a cross-cutting concern of the runtime and policy layer, not a
  domain that owns outcomes.
- **Analytics** — observation of the other twelve; giving it a domain would let a
  metric become a decision.
- **Entitlement** — the whole point is that it has no domain. Making it an engine
  would give it one.

---

## Certified phases 1–50

| Band | Delivers | Status |
|---|---|---|
| 1–20 | the engine: aggregate, identity, capture, publishing, community, safety, governance, observability | READY |
| 21–30 | the Experience Signal Engine: corroboration, normalization, matching, clustering, signal, evidence, resolution, organizations | `EXPERIENCE_SIGNAL_ENGINE_READY` |
| 31–40 | trust, governance and action: enrichment, severity, aging, escalation, cases, evidence, sampling floors, aggregation, handoff | `PHASES_31_40_READY` |
| 41–50 | the Experience OS: urgency, impact, priority, copilot boundary, agents, benchmarking, entitlement, integrations, certification | `RAGERS_EXPERIENCE_OS_CODE_READY_DATA_BLOCKED` |

Phase-to-engine mapping: `docs/architecture/ENGINE_PHASE_MAP.md`.
Convergence analysis across all fifty: `docs/architecture/CONVERGENCE_1_50.md` —
no unmapped capabilities, no duplicate ownership, no boundary violations, and the
one dead subscription it found (`ReportResolved`) fixed.

---

## Evidence at the freeze

| | |
|---|---|
| Certification gates | **55** — 53 passed, 0 failed, 2 blocked |
| Blocked gates | deployment, rollback drill — both on the same absent deployment target |
| Unit tests | 398 |
| Integration tests | 207 |
| Live-Postgres tests | 98 across 11 suites |
| Browser tests | 41 across 5 isolated servers, on the shipped production build |
| Assertions counted across gates | 1,259 |
| Migrations | 12, additive, `0001`–`0012` |
| Tables | 74, every one with RLS enabled |
| Commands on the bus | 49 |

Four statuses are reported separately because they answer different questions:

```
RAGERS_ENGINE_E2E_READY_WITH_EXTERNAL_BLOCKERS
EXPERIENCE_SIGNAL_ENGINE_READY
PHASES_31_40_READY
RAGERS_EXPERIENCE_OS_CODE_READY_DATA_BLOCKED
```

Ledger: `docs/EVIDENCE.md` and `docs/certification-report.json`, regenerated by
`npm run certify` and never edited by hand.

---

## Architecture invariants

These hold across all twelve engines and are enforced structurally — by a type, a
constraint, an absent column or an executing test — rather than by convention.

| Invariant | How it is held |
|---|---|
| `engagement != truth` | shares and reactions reach no claim count; separate tables, commands, events and counters |
| `cluster != signal` | membership is a key match; a signal is measured |
| `signal != fact` | metrics stay named and separate; there is no composite score anywhere |
| `response != resolution` | an organization has no write path to `experiences`; `publish_resolution` presents as *Resolution proposed* |
| `rejection != dispute` | rejection is `still_unresolved`; a dispute is its own object on its own axis |
| `recommendation != decision` | a proposal changes only the proposal |
| `decision != effect` | approval dispatches the target engine's own command; `dispatched` / `dispatchError` distinguish a refused approval from one that took effect |
| `reputation != popularity` | no shares, views or reactions reach any reputation read |
| **AI proposes; governed engines decide** | `AgentAction` is `read \| propose \| escalate` — there is no write verb to express autonomy |
| **E12 cannot mutate E1–E11** | approval writes to no E1–E11 table; it goes through the bus and faces every check a human would |
| Authorization is server-side | handlers are private to the bus, so no caller can reach one without passing `authorize` |
| The write path is fixed | `idempotency → resolve → authorize → transition → persist+outbox → complete`, in that order, not negotiable |
| State and event commit together | one transaction; proved by breaking the outbox insert on purpose and asserting the rows are gone too |
| Counters are recomputed, never incremented | one shared `recomputeCounters()`, so consumer ordering cannot corrupt a count |
| Payment reaches nothing that decides an outcome | entitlement blindness enforced by discovery over `src/domain` and `src/engines`, not by a maintained list |
| A measure withheld beats a measure invented | `Measure<T>` carries `value` only in the non-withheld branch, so rendering a withheld figure is a type error |
| `INSUFFICIENT_DATA` is not zero | an insufficient estimate carries no value fields at all |
| Bad input is refused, never reported as a defect | shape checked once at the bus; `internal` is reserved for defects, so `command.threw` means something is actually broken |
| Originals are unreadable on every path | `media_assets.original_key`, `transcripts.raw_text`, `evidence.original_key` withheld from every role including admin, by column grant |

---

## External-readiness tracks — separate from this freeze

Each is blocked on something absent from the environment, not on code. None is
faked, and none is counted as a pass.

| Track | Blocker | What *is* certified |
|---|---|---|
| `DEPLOYMENT_BLOCKED` | no deployment target configured | procedures in `docs/OPERATIONS.md`; the additive-migration rule the rollback depends on is enforced by static validation |
| `ROLLBACK_BLOCKED` | requires a deployed environment | the migration runner refuses drift; drill procedure in `OPERATIONS.md` §5 |
| `OBJECT_STORAGE_BLOCKED` | no bucket, no credentials | the read surface is real; nothing fake was built in its place, which is why there is no browser upload control for resolution evidence |
| `TRANSCRIPTION_PII_PROVIDER_BLOCKED` | no provider credentials | the ports and their fail-closed behaviour, against fakes; the entity-alias exemption for person-name detection |
| `LIVE_MODEL_PROVIDER_BLOCKED` | no provider credentials | the `AssistanceProvider` port and its deterministic fallback; `live: false` is what says the live path is not certified |
| `BENCHMARK_DATA_BLOCKED` | twenty distinct contributors per comparison set do not exist in any environment the harness runs in | every Phase 47 gate; the empty output is the engine being correct, and `RAGERS_BENCHMARK_DATA_READY=1` is how a deployment with real volume flips the status |

---

## Known gaps at the freeze

Open items, absences by choice, and deliberate non-gaps are recorded in
`docs/architecture/ENGINE_GAPS.md`. Two worth naming here because the boundary
sweep surfaced them and deliberately did not widen into them:

- **`creator.requestExport` has no dedupe or rate limit.** The input is valid every
  time, so it is not a boundary defect; it is a missing throttle.
- **Reply moderation is unimplemented.** `safety.applyModerationAction` on a reply
  target loads an *experience*, so it can never act. A report against a nonexistent
  reply is now refused rather than queued as an item no moderator can clear, but
  actioning a real reply remains absent.

---

## What the freeze permits

Work after RC1 proceeds as **phases 51+**, on top of this foundation, without
revisiting 1–50. Each of the six external tracks above proceeds independently and
reports its own status. A change that would break an invariant in the table above
is not a phase; it is a decision to be taken deliberately and recorded here.
