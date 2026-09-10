# Ragers — phase to engine map

**Classification:** Internal.

**Phases are delivery. Engines are permanent ownership.** A phase is finished and
never referenced again; the engine that absorbed it owns that contract for as long
as the product exists. This table exists so nobody looks for "Phase 14" in the code.

Each delivered capability maps to one **primary** engine and any supporting ones.

| Delivered as | Capability | Primary | Supporting |
|---|---|---|---|
| P1 | Experience aggregate and lifecycle | E1 | — |
| P2 | Voice capture, upload targets, playback | E2 | E1 |
| P3 | Identity, sessions, aliases, policy matrix | E1 | all |
| P4 | Durable runtime: bus, outbox, retries, dead letters | — (shared spine) | all |
| P5 | Feed projection | E5 | E1 |
| P6 | Reactions and Fair Rager? vote | E6 | — |
| P7 | Conversation and replies | E6 | — |
| P8 | Transcription and voice intelligence | E2 | E3 |
| P9 | Trust & safety, screening, moderation queue | E4 | E5 |
| P10 | Privacy and PII redaction | E4 | E2, E5 |
| P11 | Search | E5 | E7 |
| P12 | Subject graph | E7 | E3 |
| P13 | Social graph | E6 | — |
| P14 | Notifications | E6 | E1 |
| P15 | Reputation | E11 | E4 |
| P16 | Ranking and trends | E8 | E5, E7 |
| P17 | Creator control, deletion, export | E1 | E4 |
| P18 | Governance, roles, audit | E4 | all |
| P19 | Analytics and observability | E8 | — |
| P20 | Certification harness | — (assurance) | all |
| P21 | Distributed orchestration, leases, workers | — (shared spine) | all |
| ESE-A | Corroboration, shares, taxonomy | E6 | E3, E7 |
| ESE-B | Normalization, matching, clustering, signal, evidence, trust | E3, E7, E8 | E4 |
| ESE-C | Resolution, organization response, language guidance | E10, E9 | E5 |
| Product slice 1 | Persona surfaces, outcome states | (surfaces) | E9, E10, E11 |
| Contract slice | Formal dispute, Relate, responsiveness, proposals | E10, E6, E11, E12 | E4, E9 |

## The Experience Signal Engine is not E13

It was delivered as three batches and its functionality is owned as follows:

| ESE concern | Owner |
|---|---|
| Structured experience, normalization, taxonomy | **E3** |
| Trust assessments, risk events, evidence assessment | **E4** |
| Matching, clusters | **E7** |
| Signal snapshots, named metrics | **E8** |
| Organization responses | **E9** |
| Resolution reports, resolution status, disputes | **E10** |
| Corroboration, shares, Relate | **E6** |

`docs/EXPERIENCE_SIGNAL_ENGINE.md` remains the record of *why* those decisions were
made. This file is where ownership lives.

## Shared spine, owned by no single engine

The command bus, transactional outbox, leased job runtime, idempotency store, dead
letters and audit trail are infrastructure every engine rides. They are not an
engine and must not be duplicated — see `ENGINE_RUNTIME_CONFLICT.md`.

## Phases 41–43 — urgency, impact, priority

All three are **E8 Signals**, and all three are derived rather than asserted. They are
listed together because they are one read: priority is a function of urgency and impact,
and computing them apart would mean three passes over the same rows and three chances to
disagree about what the rows said.

| Phase | Primary | Supporting | Module | Persistence |
|---|---|---|---|---|
| 41 Urgency | E8 | E4, E9, E10 | `src/domain/urgency.ts` | none — derived |
| 42 Impact | E8 | E1, E7, E10 | `src/domain/impact.ts` | none — derived |
| 43 Priority | E8 | E4, E10 | `src/domain/priority.ts`, `src/engines/priority.engine.ts` | `experience_priorities` (a cache of a derivation) |

The three questions, kept apart because they disagree constantly:

* **severity** — how bad it was. Asserted by the person it happened to (P32).
* **urgency** — how soon somebody should look. Derived from state and elapsed time.
* **priority** — where it sits relative to everything else.

A minor problem left unanswered for four months is not severe and is urgent. A critical
one already being worked is severe and not urgent. Collapsing any pair produces a queue
that is confidently wrong, so none of the three is stored in terms of another.

**No command writes any of them.** A `priority.set` would be a way to move somebody's
complaint up or down the queue by hand, and Phase 43's whole claim is that a position is
answerable from the rows instead.
