# Ragers — experience lifecycle

**Classification:** Internal.

Two axes, deliberately separate, plus a third object that is neither.

## Axis 1 — publication (`experiences.status`)

Load-bearing for fail-closed media protection and moderation.

```
draft → validating → pending_media ─┐
                  └→ pending_moderation → published → under_review
                                                    → hidden
                                                    → removed → published
  any → deleted (terminal)
```

Publication is a **consumer outcome**, not a command: screening runs after create
and fails closed, so an unscreened experience stays unpublished.

## Axis 2 — outcome (`experiences.resolution_status`)

What happened afterwards. Independent of publication: collapsing the two would let
an experience read as resolved while its media was still unprotected.

```
open ─┬→ gaining_signal ─┐
      ├→ acknowledged ───┼→ partially_resolved ⇄ resolved
      ├→ under_review ───┘                     ↘ reopened
      ├→ partially_resolved                      ↗
      ├→ resolved                    disputed ⇄ (any of the above)
      └→ disputed
```

Rules the transitions encode:

- `open → resolved` is legal. Requiring a path through review would let an
  organization hold an outcome open by staying silent. What protects the invariant
  is the **source guard**: an organization-sourced move to a resolved state is
  refused whichever path it takes.
- `resolved → reopened`, never `resolved → open`. A fix that stopped holding is not
  the same as never having happened.
- `resolved` requires **every experiencer** (author + active corroborators) to have
  reported `resolved_for_me`. One satisfied person is `partially_resolved`.
- Volume moves `open → gaining_signal` and no further. Many people saying it
  happened is a signal, never an outcome.

## The third object — dispute (`experience_disputes.status`)

Not a value on either axis.

```
open ⇄ under_review → upheld
                    → declined
open|under_review   → withdrawn
```

- **rejection ≠ dispute.** Rejecting a proposed fix is a resolution report
  (`still_unresolved`): the problem persists. Disputing claims an *account* is
  untrue.
- **dispute ≠ unresolved, dispute ≠ resolved.** A disputed experience may be any
  outcome state, or none.
- The **disputed party cannot close it.** Review is moderator-only, and the raiser
  cannot decide their own. Withdrawal is the raiser's alone — not even a moderator.
- A settled dispute is final; a fresh grievance is a new dispute, so the history of
  what was contested survives.
- Only *live* disputes mark an experience contested. An upheld or declined one is
  history, not a permanent shadow.

## Presented outcome (viewer-facing)

Derived, not stored — see `src/domain/outcome-presentation.ts`:

| Presented | When |
|---|---|
| Unresolved (nobody has said) | no reports, no response |
| Unresolved (reported) | experiencers say it persists |
| Responded | an organization answered; nobody has reported |
| **Resolution proposed** | an organization described a fix; nobody has confirmed it |
| Partly resolved | some experiencers confirmed |
| Resolved | all experiencers confirmed |
| Disputed | the accounts differ |

`Resolution proposed` is the state with the most at stake: reading it as resolved
would let a company close a case by asserting it closed.

## The circular flow

```
Capture (E2) → Declaration (E3) → Trust (E4) → Publishing (E5)
  → Community: relate · validate · Re-Rage · Re-Rave (E6)
  → Clustering (E7) → Signals (E8) → Business Response (E9)
  → Outcomes: report · dispute (E10) → Reputation (E11)
  → Intelligence proposals (E12) → back through a governed engine
```

E12 closes the loop only by *proposing*: an approved proposal re-enters through the
target engine's own command path, never by writing its state.
