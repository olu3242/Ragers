# Ragers — persona engine access

**Classification:** Internal.

**Server-side authorization is authoritative.** Navigation and page guards are
conveniences; the policy matrix in `src/policy/policy.ts` decides. Every cell below
is enforced on the server, and the refusals are proved in
`tests/integration/persona.authorization.test.ts`.

Capabilities: **Read · Create · Respond · Moderate · Resolve · Propose · Approve · Admin**

| Engine | Consumer | Community | Business | Operator | Intelligence |
|---|---|---|---|---|---|
| E1 Experience | Read, Create (own) | Read, Create | Read | Read, Moderate | Read |
| E2 Capture | Create (own) | Create | — | Read | — |
| E3 Declaration | Create (confirm own) | — | — | Read | Propose |
| E4 Trust | — | Create (report) | — | Read, Moderate | Propose |
| E5 Publishing | Read | Read | Read | Moderate | — |
| E6 Community | Read | Create (corroborate, relate, reply, react) | Read | Moderate | Propose |
| E7 Clustering | Read | Read | Read | Read | Propose |
| E8 Signals | Read | Read | Read | Read (+internal) | Propose |
| E9 Business Response | Read | Read | **Respond** | Read | Propose |
| E10 Outcomes | **Resolve** (own), Create (dispute) | **Resolve** (if corroborated), Create (dispute) | Create (dispute) | **Moderate** (review dispute) | Propose |
| E11 Reputation | Read (public) | Read (public) | Read (own record) | Read (+internal) | Propose |
| E12 Intelligence | — | — | — | **Propose, Approve** | — |

## The five refusals, proved

| Property | How it is enforced | Test |
|---|---|---|
| A business cannot resolve or delete a consumer experience | no write path to `experiences`; `resolution.report` needs experiencer standing; `applyResolution` refuses an organization source | `persona.authorization` |
| A consumer cannot reach operator APIs | `moderation.*`, `dispute.review`, `proposal.*` are moderator-gated in the matrix; the queue read checks the same predicate | `persona.authorization`, `personas.spec.ts` |
| Intelligence cannot bypass the target engine | approval dispatches through the bus; a proposal to grant its reviewer `admin` is approved as a decision and refused as an action | `persona.authorization` |
| A pending claim or revoked membership grants nothing | `organizationFor` requires `status = 'claimed'` and `revokedAt = null` | `persona.authorization`, `resolution.organization` |
| Dispute ownership is enforced | withdrawal is the raiser's alone — not even a moderator; review excludes the raiser | `persona.authorization`, `contracts.live` (RLS) |

## What each persona is *offered* versus *allowed*

`lib/persona.ts` resolves personas server-side and `lib/nav.ts` builds navigation
from them. `navFor` takes personas and organizations and **no actor**, so it cannot
become the thing that protects a surface — asserted by test. Hiding a tab is never
the reason something is safe.

Personas are not exclusive: one person can be a consumer, a community participant
and organization staff at once, and the navigation shows every surface they hold.
