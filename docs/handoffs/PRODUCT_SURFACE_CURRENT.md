# Ragers — Product Surface, current state

**Classification:** Internal. Never linked from a public surface (`CLAUDE.md`).
**Owner:** product surfaces (Claude Code). Backend contracts are not owned here.

---

## 0. Blocking dependency: the authoritative contract documents do not exist

The brief names five documents to read first. **None exists on any branch** —
checked `main`, `claude/affectionate-archimedes-3ex8ws`,
`feat/experience-integrity-engine`, `feat/phase-1-foundation`,
`feat/phase-2-server-core-loop`:

| Required document | Status |
|---|---|
| `docs/architecture/ENGINE_PHASE_MAP.md` | absent |
| `docs/architecture/RAGERS_12_ENGINE_ARCHITECTURE.md` | absent |
| `docs/architecture/PERSONA_ENGINE_ACCESS.md` | absent |
| `docs/architecture/EXPERIENCE_LIFECYCLE.md` | absent |
| `docs/handoffs/ENGINE_CONTRACTS_CURRENT.md` | absent |

Rule 1 says consume `ENGINE_CONTRACTS_CURRENT.md`; rule 2 says do not invent
replacement APIs or state machines. Those cannot both be satisfied by writing the
missing documents, so they have **not** been written here. This slice consumes only
contracts that demonstrably exist in the running system — routes that respond and
commands that are certified — and every gap is recorded in §4 rather than filled
in with an assumption.

### There are two divergent engine implementations in flight

`origin/feat/experience-integrity-engine` (PR #6) contains
`engine/durable-runtime.js`, `engine/experience-integrity-engine.js` and its own
`server.js` — plain JavaScript with a bespoke HTTP server. This branch contains
`engine/` as a Next.js 15 + TypeScript package with 6 SQL migrations and a
certified command bus.

**They collide on the `engine/` path.** Whichever merges second will conflict at
the directory level, not just in content. The 12-engine model in the brief maps
cleanly onto neither naming scheme. This needs an owner decision before either
merges; it is not a product-surface call.

---

## 1. Surfaces implemented in slice 2 — Relate and reputation views

**Surface:** Relate control and related-experience list
**Phase:** product surface slice 2
**Persona:** Community Participant
**Engines consumed:** E6
**Endpoints/events consumed:** `GET|POST|DELETE /api/experiences/[id]/relations`
**States represented:** `same_occurrence · same_pattern · related_context`; active/retracted
**Implemented:** `components/RelateControl.tsx`. Visually quieter than the claim controls, because relating is a weaker statement. Says in words that it does not count as a Re-Rage, because the count sits near numbers that *do* mean "people this happened to" and placement alone would not carry it. Asserts `trustWeight: 0` back from the API.
**Backend dependency:** none — E6 contract landed in the contract slice.
**Browser evidence:** relating moves `reRages`/`corroborators` not at all; the reverse pair is refused 409; the note is asserted verbatim.

**Surface:** Experience detail page
**Phase:** product surface slice 2
**Persona:** all
**Engines consumed:** E1 E4 E6 E7 E9 E10
**Endpoints/events consumed:** feed projection, counters, `resolutionSummaryFor`, `disputesFor`, `relatedTo`, `publicResponsesFor`, `evidenceSummaryFor`
**States represented:** publication, outcome (all seven presentations), contested, evidence assessment
**Implemented:** `app/experiences/[id]/page.tsx`. Read from the feed projection, so it cannot leak an author. Ordering is the argument: the account, then what people claimed, then what the organization said, then what the people it happened to reported. A response never sits above the account it answers.
**Backend dependency:** none

**Surface:** Dispute control
**Phase:** product surface slice 2
**Persona:** Consumer, Community, Business
**Engines consumed:** E10
**Endpoints/events consumed:** `GET|POST /api/experiences/[id]/disputes`
**States represented:** `open · under_review · upheld · declined`; contested badge
**Implemented:** `components/DisputeControl.tsx`. Kept visibly separate from resolution reporting because they are different acts. Reasons offered depend on which side the viewer is; somebody who is both sees a "Disputing as" selector so they choose which hat. Says that a moderator reviews it, that neither side can decide it, and that it is not a finding about who is right. Refreshes server state on success rather than leaving half the page optimistic.
**Backend dependency:** none

**Surface:** Contribution view
**Phase:** product surface slice 2
**Persona:** Consumer, Community
**Engines consumed:** E11
**Endpoints/events consumed:** `GET /api/actors/[id]/contribution`
**States represented:** four named counts; explicit insufficient-sample state
**Implemented:** `components/ContributionView.tsx`. No composite, nothing from the trust layer, nothing about popularity. `approvalRate` renders as "not enough votes yet" when withheld.
**Backend dependency:** none

**Surface:** Responsiveness panel
**Phase:** product surface slice 2
**Persona:** Business, and public
**Engines consumed:** E11
**Endpoints/events consumed:** `GET /api/organizations/[id]/responsiveness`
**States represented:** cases total/answered/confirmed-resolved/open; medians when the sample supports them
**Implemented:** `components/ResponsivenessPanel.tsx`, replacing the counted-in-page figures on the organization page so staff see the same record a viewer does. Not called an SLA and no overdue indicator, because none exists. Durations are worded plainly ("2 days"), never falsely precise.
**Backend dependency:** none

**Browser evidence (slice 2):** `e2e/relate-reputation.spec.ts` — 4 tests on their own server. Relating moves no claim count; a dispute is offered separately, reads as a disagreement, and leaves the outcome axis at `open`; responsiveness withholds timings below the floor and shows how far off; no reputation payload key matches `score|rating|rank|grade|trust|risk`.

---

## 1b. Surfaces implemented in slice 1

**Surface:** Persona navigation and shell
**Phase:** product surface slice 1
**Persona:** all five
**Engines consumed:** E1 Experience (identity/role), E9 Business Response (membership)
**Endpoints/events consumed:** none — server-side read of `actors`, `organization_memberships`, `organization_profiles`
**States represented:** which personas a viewer holds
**Implemented:** `lib/persona.ts`, `lib/nav.ts`, `components/PersonaNav.tsx`, `app/layout.tsx`. Personas are non-exclusive; a pending organization claim and a revoked membership both confer nothing. Scoping is presentation only — `navFor` takes no actor and makes no capability decision, asserted by test.
**Backend dependency:** none

**Surface:** Outcome state presentation (rule 7)
**Phase:** product surface slice 1
**Persona:** consumer, community, organization
**Engines consumed:** E10 Outcomes, E9 Business Response
**Endpoints/events consumed:** `GET /api/experiences/[id]/resolution`
**States represented:** unresolved (unreported) · unresolved (reported) · response · **proposed resolution** · partly resolved · resolved · disputed
**Implemented:** `src/domain/outcome-presentation.ts`, `components/OutcomeBadge.tsx`, and `resolutionSummaryFor` now returns `resolutionProposed` and `presentation`. Derived from existing state — no new column, no new enum. `proposed_resolution` is the case where an organization described a fix and nobody it happened to has confirmed it; it is styled as pending, never as settled.
**Backend dependency:** none

**Surface:** Consumer resolution review
**Phase:** product surface slice 1
**Persona:** Rager / consumer
**Engines consumed:** E10 Outcomes
**Endpoints/events consumed:** `GET|POST /api/experiences/[id]/resolution`
**States represented:** all seven above; review framing when a fix has been proposed
**Implemented:** `components/ResolutionRow.tsx` reframes to *accept / partly / reject* when a proposal is outstanding, and recomputes the badge locally so a person's own answer is not reported back to them stale.
**Backend dependency:** consumer-initiated **dispute** — `resolution_report_kind` has only `resolved_for_me | partially_resolved | still_unresolved`. "Reject" maps to `still_unresolved`. Asserting that an organization's account is *untrue* (as opposed to the problem not being fixed) has no representation. Not faked.

**Surface:** Organization case inbox and response composer
**Phase:** product surface slice 1
**Persona:** Business / Organization
**Engines consumed:** E9 Business Response, E10 Outcomes, E7 Clustering, E8 Signals
**Endpoints/events consumed:** `GET /api/organizations/[id]/cases` (new), `POST /api/organizations/[id]/responses`
**States represented:** all eight response kinds with the commitment each carries; per-case outcome state; responsiveness counters
**Implemented:** `app/organizations/[id]/page.tsx`, `app/api/organizations/[id]/cases/route.ts`, `components/OrganizationCaseInbox.tsx`. Membership resolved through `organizationFor`, the same helper the respond command uses. No control exists to hide, edit, delete or resolve, because no endpoint does. Volume is stated as "N people say this happened to them" — never as verified truth (rule 8).
**Backend dependency:** SLA / responsiveness metrics are counted in the page from cases; there is no time-to-first-response or time-to-resolution measure in the engine. A real SLA dashboard needs those.

**Surface:** Operator review queue
**Phase:** product surface slice 1
**Persona:** Operator / Moderator
**Engines consumed:** E4 Trust, E5 Publishing
**Endpoints/events consumed:** `GET /api/moderation/queue` (new), `POST /api/moderation/claim` (new), `POST /api/moderation/action` (new) — all dispatching pre-existing certified commands `safety.claimQueueItem`, `safety.applyModerationAction`
**States represented:** queued · claimed (by me / by another) · publication status · screening signals · report count
**Implemented:** `app/operate/page.tsx`, `components/ModerationQueue.tsx`. Each row shows *why* it is queued. "No action needed" is offered as a first-class outcome — a queue that only offers removal biases toward it. Reason text is required into the audit trail.
**Backend dependency:** none. The commands existed and were certified; only the HTTP surface was missing.

**Surface:** Governed proposals — two kinds, on one page, never one list
**Phase:** product surface slice 1 (unconfirmed structure) · slice 3 (recommendations)
**Persona:** Intelligence / governed review surface
**Engines consumed:** E3 Declaration (normalization) · E12 Intelligence (governed proposals)
**Endpoints/events consumed:** `GET /api/experiences/[id]/normalization` · `GET /api/proposals` · `POST /api/proposals/[id]/decision`
**States represented:** proposed · escalated · approved-and-carried-out · approved-and-refused · rejected · expired
**Implemented:** `app/operate/proposals/page.tsx`, `components/RecommendationCard.tsx`, `lib/proposals.ts`.

Two sections, deliberately not merged, because only one of them is a reviewer's to
decide:

- **Recommendations for you to decide** (E12) — approve / reject / escalate over
  `intelligence_proposals`. Each card names the *action* and the engine that would
  carry it out, so approval authorises a specific command rather than a sentiment.
  Rejecting requires a reason (the domain refuses one without). Evidence is a link
  to a durable row, never a paraphrase.
- **Structure only its author can confirm** (E3) — extracted structure nobody has
  confirmed. **No approve control at all**, deliberately: the person whose
  experience it is confirms their own, and an operator doing it on their behalf is
  the substitution the design forbids (rule 9). The E2E assertion for that is
  scoped to this section rather than the page, because a page-wide "no approve
  button" rule would be asserting the wrong rule in the wrong place.

**The distinction the surface exists to hold:** a decision is not an effect.
Approving dispatches the target engine's own command, which can refuse — so the card
reports the decision and the outcome separately, shows the engine's refusal verbatim,
and never says an action happened when it did not. `describeEffect` is a pure
function in `lib/proposals.ts` precisely so that property is unit-testable; the
browser test proves it end to end by approving a removal of the reviewer's *own*
account, which `moderation.action` forbids.

The card deliberately does **not** refresh after a decision: a decided
recommendation leaves the open queue, so a refresh would take the card away at the
moment it carries the one thing the reviewer needs to read.

**Backend dependency:** none remaining for this surface. Autonomous agents (E12
phase 45+) are still absent and deliberately not built — the governed proposal is
the floor.

---

## 2. Engines consumed, against the 12-engine model

Observational mapping from the product side. **Not authoritative** — it describes
what the running system provides, and does not define a contract.

| Engine | Backing implementation | Surface status |
|---|---|---|
| E1 Experience | `experiences` aggregate + state machine | consumed |
| E2 Capture | composer, voice recorder, upload targets | consumed (pre-existing) |
| E3 Declaration | Rage/Rave kind + normalization confirm | consumed |
| E4 Trust | trust assessments, risk events, screening | consumed (internal only) |
| E5 Publishing | screening → publish, fails closed | consumed |
| E6 Community | corroboration, reactions, replies, fair vote | consumed (pre-existing) |
| E7 Clustering | cluster + members | consumed |
| E8 Signals | signal snapshots | consumed |
| E9 Business Response | organization profiles/memberships/responses | consumed |
| E10 Outcomes | resolution reports + events | consumed |
| E11 Reputation | `actor_reputation`, `responsiveness_snapshots` | consumed — `ContributionView`, `ResponsivenessPanel` |
| E12 Intelligence | `intelligence_proposals` | consumed — governed recommendation cards |

---

## 3. Product flow coverage

Capture → Rage/Rave → validation state → publication → Relate/Validate/Re-Rage/Re-Rave
→ cluster + signal → organization response → resolution review → outcome → reputation
→ intelligence recommendations.

Covered end to end except:

- ~~**Relate**~~ **Closed** — `experience_relations`, canonicalised pair, zero trust weight.
- ~~**Reputation** (E11)~~ **Closed** — `ContributionView` and `ResponsivenessPanel`.
- ~~**Intelligence recommendations** (E12)~~ **Closed** — governed recommendation cards over `intelligence_proposals`, with the decision and its effect reported separately.

---

## 4. Backend dependencies recorded

1. Five authoritative contract documents absent (§0). Blocking for contract-conformance.
2. Divergent `engine/` implementation on PR #6, colliding on path (§0). Needs an owner decision.
3. ~~**E12 Intelligence**~~ **Closed** — engine, proposal ledger and approve/reject/escalate commands exist and now have a surface. The agent framework remains deliberately absent.
4. ~~**E11 Reputation** — no read contract shaped for a viewer surface.~~ **Closed** — `contributionViewOf`, `publicResponsivenessFor`.
5. ~~**Consumer dispute**~~ **Closed** — `experience_disputes` is its own object on a third axis; `dispute.open` accepts consumer and organization origins.
6. ~~**SLA measures**~~ **Closed as responsiveness**, deliberately not as an SLA: acknowledgement, first-response and resolution medians with a sample floor. No overdue indicator, because no agreement exists to be overdue against.
7. ~~**Relate**~~ **Closed** — `experience_relations`, canonicalised pair, zero trust weight.
8. **Deployment target** — still absent; deployment and rollback gates remain blocked.
9. ~~**E12 recommendation cards**~~ **Closed** — `components/RecommendationCard.tsx` over `/api/proposals` and `/api/proposals/[id]/decision`, in its own section of `/operate/proposals`.
10. **`engine/` path collision with PR #6** — unresolved; see `docs/architecture/ENGINE_RUNTIME_CONFLICT.md`.

---

## 5. Browser evidence

```
23 browser tests passed across 4 isolated servers
  golden-path (11) · experience-signal-engine (2) · personas (6) · relate-reputation (4)
```

`e2e/personas.spec.ts` covers: a consumer offered no operator or organization
surface *and refused when navigating there anyway* (403 from both APIs);
organization staff seeing their cases, responding, and a described fix reading as
**Resolution proposed** rather than resolved until the Rager accepts it; an
operator seeing why an item is queued and deciding no action is needed; unconfirmed
structure visibly unapplied with no approve control in its section; a reviewer
approving a recommendation and seeing the governed engine *carry it out*, then
approving one the same engine **refuses** and seeing the refusal verbatim with the
account still unremoved; and a rejection refused until a reason is given.

## 6. Other tests

```
440 offline (unit 279 + integration 161) · live suites against Postgres 16 in CI
static validation: PASS (142 source files, 7 migrations)
typecheck: clean · production build: clean
```

**SHA (slice 3):** this commit
**SHA (slice 2):** `2c56a7b`
**SHA (slice 1):** `1d34b09`
