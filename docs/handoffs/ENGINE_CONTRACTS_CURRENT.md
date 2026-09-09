# Ragers — engine contracts, current

**Classification:** Internal.
**Purpose:** what the product surfaces may consume. Authoritative runtime is the
TypeScript engine in `engine/`.

Read alongside `docs/architecture/RAGERS_12_ENGINE_ARCHITECTURE.md` (full per-engine
contracts) and `docs/architecture/PERSONA_ENGINE_ACCESS.md` (who may do what).

This file documents the four contracts that were previously missing.

---

## E10 — formal dispute

**States** `open · under_review · upheld · declined · withdrawn` — a **third axis**,
neither publication nor outcome.

**Reasons**, and which side may raise each:

| Reason | Consumer | Organization |
|---|---|---|
| `account_inaccurate` | ✅ | ✅ |
| `fix_not_delivered` | ✅ | — |
| `response_misleading` | ✅ | — |
| `not_our_organization` | — | ✅ |
| `already_resolved` | — | ✅ |
| `wrong_entity` | — | ✅ |
| `other` (detail required) | ✅ | ✅ |

**Commands**

| Command | Who | Notes |
|---|---|---|
| `dispute.open` | member with standing | standing = author, active corroborator, or staff of the entity the experience is about |
| `dispute.withdraw` | the raiser only | not even a moderator; idempotent |
| `dispute.review` | moderator only, never the raiser | `upheld` / `declined` / `under_review` |

**Endpoints**

```
GET    /api/experiences/[id]/disputes    → { contested, disputes[] }
POST   /api/experiences/[id]/disputes    → { disputeId, origin, status, contested }   201
POST   /api/disputes/[id]/review         → { status, contested }
DELETE /api/disputes/[id]/review         → { withdrawn, contested }   (withdraw)
```

**Events** `DisputeOpened` · `DisputeWithdrawn` · `DisputeReviewed`

**For the surface:** `contested` is true only while a dispute is live. Show *that*
it is contested, by which side, and on what grounds — the `detail` is never returned
by the read, because it can quote either party at length. `rejection ≠ dispute`:
rejecting a proposed fix is `resolution.report` with `still_unresolved`.

Only one live dispute per person per experience; a second returns
`dispute_already_open` (409).

---

## E6 — Relate

**Assertions** `same_occurrence · same_pattern · related_context`
**Status** `active · retracted · removed`

**Not corroboration.** Corroboration is a claim about the actor's *own* experience;
Relate can be asserted by somebody who experienced neither. It therefore carries
**zero** weight in corroboration counts, unique-experiencer counts and every trust
confidence. `trustWeightOfRelations` returns `0` and a test holds it.

The pair is canonicalised, so relating A→B and B→A is one assertion.

**Commands** `relation.assert` (member) · `relation.retract` (asserter only)

**Endpoints**

```
GET    /api/experiences/[id]/relations   → { related: [{ experienceId, assertion, assertedByCount }] }
POST   /api/experiences/[id]/relations   → { relationId, assertion, assertedByCount, trustWeight: 0 }   201
DELETE /api/experiences/[id]/relations   → { retracted, assertedByCount }   body: { relationId }
```

**Events** `ExperienceRelated` · `ExperienceUnrelated`

**For the surface:** show `assertedByCount` as "N people say these are connected" —
never alongside or summed with a corroboration count. Both experiences must be
published. Re-asserting returns `already_related` (409).

---

## E11 — responsiveness and contribution

**Not an SLA.** No service-level agreement exists, so nothing is named after one and
there is no overdue indicator.

```
GET /api/organizations/[id]/responsiveness
  → { casesTotal, casesAnswered, casesConfirmedResolved, casesOpen,
      responseRate, resolutionRate,
      medianAcknowledgementMs?, medianFirstResponseMs?, medianResolutionMs?, oldestOpenMs?,
      sampleSize, insufficientSample, caption }
```

Medians are **absent** when `insufficientSample` is true (`sampleSize < 5`). Render
the `caption` rather than composing your own: below the floor it says how far off it
is, and above it states that answering does not move `casesConfirmedResolved`.

```
GET /api/actors/[id]/contribution
  → { experiencesPublished, corroboratedExperiences, corroborationsGiven,
      consistentEvidence, approvalRate?, totalFairVotes,
      insufficientSample, caption }
```

Separately-named counts, **no composite**. `approvalRate` is withheld below three
experiences or three votes. Nothing from `trust_assessments` or `internalSignals`
appears, and nothing about popularity — no shares, views or reactions.

**Events** `ResponsivenessUpdated`, emitted only when a viewer-visible figure moves.

---

## E12 — governed proposals

**States** `proposed → approved | rejected | escalated | expired`. Escalated is not
a decision and can still be approved or rejected.

**The boundary.** Approving does **not** write to any E1–E11 table. It dispatches
the target engine's own command through the bus, so the action faces every check a
human would — and can fail:

```
POST /api/proposals/[id]/decision  { outcome, note? }
  → { status, dispatched, dispatchError? }
```

`status: "approved"` with `dispatched: false` means **the decision was recorded and
the action was refused**. Render those differently. A proposal with no
`proposedCommand` is advice: approving it changes no governed state and `dispatched`
is false.

```
GET  /api/proposals            → { proposals[] }   moderator only
POST /api/proposals            → { proposalId, status }   201, moderator only
```

Every proposal carries `rationale` and at least one `evidenceRefs` entry — a
proposal with no traceable basis is refused at creation, not shown. `evidenceRefs`
kinds: `experience · corroboration · evidence · cluster · signal_snapshot ·
risk_event`.

**Events** `IntelligenceProposalCreated · …Approved · …Rejected · …Escalated ·
…Expired`. The approve/reject/escalate payloads carry `dispatched`.

**For the surface:** approve / reject / escalate are the only controls, and a
rejection requires a note. Where a proposal concerns somebody's own experience
structure, the person confirms it themselves — an operator approving on their behalf
is the substitution the design forbids, which is why `/operate/proposals` has no
approve button for normalization suggestions.

---

## Persona permissions, summary

| | Consumer | Community | Business | Operator |
|---|---|---|---|---|
| open dispute | ✅ (own/corroborated) | ✅ | ✅ (own entity) | ✅ |
| withdraw dispute | own only | own only | own only | own only |
| review dispute | — | — | — | ✅ |
| relate | — | ✅ | ✅ | ✅ |
| read responsiveness | ✅ | ✅ | ✅ | ✅ |
| read contribution | ✅ | ✅ | ✅ | ✅ |
| read / create / decide proposals | — | — | — | ✅ |

Server-side authorization is authoritative. UI visibility is never authorization.
