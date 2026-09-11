# Ragers — Phases 1–50 convergence

**Classification:** Internal. Derived by enumerating the implementation, not by reading the
roadmap back to itself.

## Decision on record: one authoritative runtime

**The certified TypeScript engine in `engine/` is authoritative.** PR #6 is **closed** as a
non-authoritative colliding runtime, with its disposition recorded on the pull request itself
and in `ENGINE_RUNTIME_CONFLICT.md`.

A future agent reading this repository should not be able to interpret both as authoritative,
so the resolution is stated in three places that a reader is likely to hit:

1. **Here**, as the convergence decision.
2. **`ENGINE_RUNTIME_CONFLICT.md`**, with the per-capability disposition and the reasons.
3. **On PR #6**, closed with a comment naming what was ported, what is reference, and what is
   discarded — so somebody arriving from the pull request list does not reopen the question.

The path collision is resolved by closure rather than by relocation: nothing lands in
`engine/` from that branch, and the one capability worth keeping (`fingerprint()`) is already
merged into `src/domain/enrichment.ts` with its own tests.

## The twelve engines, and what each owns

No Engine 13. The Experience Signal Engine and the 41–50 band both map into these twelve.

| Engine | Owns | Phases |
|---|---|---|
| **E1 Experience** | the aggregate, its state machine, asserted enrichment | 1, 2, 4, 31 |
| **E2 Capture** | voice, media, upload targets, transcription | 2, 8 |
| **E3 Declaration** | Rage/Rave kind, extraction, confirmation, fingerprint | 3, 31 |
| **E4 Trust** | trust assessments, risk events, screening inputs, sample floors | 9, 10, 38 |
| **E5 Publishing** | screening → publish, fail-closed | 5 |
| **E6 Community** | corroboration, reactions, replies, fair vote, Relate | 5, 6, 7 |
| **E7 Clustering** | matching, clusters, cluster membership | 11, 12, 13 |
| **E8 Signals** | snapshots, severity, urgency, impact, priority | 16, 32, 41, 42, 43 |
| **E9 Business Response** | organization profiles, responses, cases, benchmarks | 17, 35, 46, 47 |
| **E10 Outcomes** | resolution reports and events, aging, escalation, disputes | 18, 33, 34, 37 |
| **E11 Reputation** | contribution reads, responsiveness, aggregation | 15, 36, 39 |
| **E12 Intelligence** | proposals, handoff, agents, integrations | 40, 44, 45, 49 |

## Unmapped capabilities

None. Everything registered on the bus resolves to one of the twelve, and the cross-cutting
concerns are runtime rather than engines:

- **Identity, sessions, aliases** — the authorization substrate every engine sits on, not an
  engine. It has no domain of its own; it decides who may act on somebody else's.
- **Analytics, observability, certification** — reads *over* the engines. They own no state an
  engine could contradict.
- **Entitlement** — a read capability for organization-facing surfaces, and deliberately not
  an engine. Making it one would give it a domain, and the whole point of Phase 48 is that it
  has no input to any domain that decides an outcome.

## Duplicate ownership

None found. The nearest thing is `experience_counters`, written by two consumers — the
corroboration counters and the reaction counters. That is deliberate and already resolved:
both call one shared `recomputeCounters`, because two consumers each writing their own view of
the row zeroed each other's fields, which is a defect this repository has already had and
fixed.

## Orphan contracts and events

Checked in both directions by enumerating emissions and subscriptions.

**Dead subscriptions (a consumer that could never run): one found and fixed.**

`trust.recompute` subscribed to `ReportResolved`, and nothing emitted it. Reports were marked
`reviewed` inside `safety.applyModerationAction` with no event, so a reporter whose report was
resolved by *no action* or a warning never had their contribution history recomputed. Removal
happened to work only because that branch also emits `ContentRemoved`, which the same consumer
listens for — which is how the gap stayed invisible.

Fixed by emitting `ReportResolved` per resolved report. A second inconsistency surfaced while
fixing it: the consumer read a `reporterId` key, while every other actor key in the system
carries the `ActorId` suffix and nothing emitted `reporterId`. Both now agree on
`reporterActorId`.

**Events with no listener: twenty-five, all legitimate.** `RoleGranted`, `SessionIssued`,
`AliasCreated`, `CaseOpened`, `IntelligenceProposalCreated` and the rest are records — the
audit trail and the outbox are their consumers. An event exists to be *recorded*, not only to
be reacted to, and adding a no-op consumer to each would be ceremony.

## Engine boundary violations

None found. The boundaries that could have been crossed, and the structural reason each holds:

- **An organization has no write path to `experiences`.** `case.engine.ts` and
  `organization.engine.ts` contain no write to it, so closing a case resolves nothing.
- **E12 cannot mutate E1–E11.** `handoff.engine.ts` and `agent.engine.ts` dispatch nothing but
  `proposal.create`; `AgentAction` has no write verb.
- **Entitlement reaches no integrity module.** Enforced by discovery over `src/domain` and
  `src/engines` rather than by a maintained list, so a module added or renamed later is covered
  without anybody remembering.
- **Escalation changes no outcome.** It writes to `experience_escalations` and the shared
  moderation queue, and nowhere else.

## The circular flow, certified

`tests/integration/convergence.circular.test.ts` runs one full lap for a **Rage** and again for
a **Rave** — the Rave deliberately, because a system that only holds its rules for complaints
has not held them.

Each lap: capture → confirm → assert what it cost → corroborate → cluster → measure →
organization responds → both experiencers report → severity, urgency and priority derive →
reputation recomputes → an agent proposes → nothing mutates → a second account joins the same
pattern.

The six distinctions asserted inside the lap rather than in isolation:

| Distinction | How the lap proves it |
|---|---|
| engagement ≠ truth | shares counted apart from claims, with no path between them |
| cluster ≠ signal | the pattern and its measurement are separate rows |
| response ≠ resolution | the organization answered *and* the outcome stayed where the experiencers put it |
| one of two is partial | `partially_resolved` after the first report, `resolved` only after both |
| recommendation ≠ decision | the proposal is `proposed`, and pre-authorises no command |
| decision ≠ effect | the experience row is byte-identical after an agent runs |
