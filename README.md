# Ragers

Ragers is a focused Rage/Rave behavioral network: a place to call out behavior that should happen less and celebrate behavior that should happen more, without turning the product into a generic discussion network.

> Critique the behavior. Protect the human.

## Repository layout

This repository is deliberately two things, kept separate:

| Path | What it is |
|---|---|
| `index.html`, `styles.css`, `script.js` | The public marketing landing page. Plain HTML/CSS/JS, no build step, deploys to any static host. |
| `app.html`, `app.css`, `app.js` | The browser-local app shell / preview client. Framework-free. |
| `engine/` | **The Ragers Engine** — the product runtime. Next.js 15 + TypeScript, with a dependency-free domain core. |
| `docs/` | Internal PRD, BRD, data model, engine roadmap, operations runbook and certification evidence. Never published. |

The landing page stays framework-free on purpose, and the engine's Next.js build is human-approved: both halves of that are recorded in [`AGENTS.md`](AGENTS.md) constraint 2. The engine lives in its own directory so the product can use a real stack without the marketing surface inheriting a build step, and so neither decision has to be re-litigated by whoever reads the tree next.

## The engine

`engine/` implements the 20 dependency-ordered engine phases specified in [`docs/ROADMAP.md`](docs/ROADMAP.md), from the canonical Experience aggregate through to certification. A few properties are worth knowing before reading the code:

- **One canonical aggregate.** Text and voice are *creation modes* of the same Rage/Rave/Experience aggregate, not separate entities. Voice is first-class from Phase 1.
- **One write path.** Every state change flows through `Command → Authorization → Domain Transition → Persistence → Outbox → Orchestration → Consumers → Success | Retry | Dead Letter`. Handlers are only reachable through the command bus, so authorization cannot be skipped.
- **Ragers-native engagement.** `Been There`, `Same`, `Fair Point`, `Disagree`, plus the `Fair Rager?` vote. Generic Like/Upvote/Repost is rejected by name.
- **Privacy is structural, not procedural.** The feed and search projections have no actor column at all; original media keys and raw transcripts are unreadable on every path for every role, enforced in both the policy layer and by Postgres column grants.
- **Fail closed.** If media protection or moderation screening cannot complete, the experience is never published.

The domain core is authored as dependency-free TypeScript and runs directly under Node's type stripping, so the whole suite needs no build step and no external services.

## Run it

```bash
# The static landing page and app shell
npm install
npm start            # http://localhost:8080
npm test             # public-surface smoke checks

# The engine
cd engine
npm install
npm run lint         # architecture, hygiene and content-separation rules
npm run typecheck    # strict TypeScript, zero errors
npm test             # 229 assertions, no external dependencies
npm run test:live    # 54 assertions against a real Postgres (see docs/OPERATIONS.md §2)
npm run dev          # http://localhost:3001
npm run worker       # the delivery worker, for a separate process
npm run test:e2e     # browser E2E against a production build
npm run certify      # every gate, then rewrite docs/EVIDENCE.md
```

## Current status

`RAGERS_ENGINE_E2E_READY_WITH_EXTERNAL_BLOCKERS`

20 certification gates pass, including everything that needs a real database: migrations applied to live Postgres, adapter parity between the in-memory and Postgres stores, RLS policies executed as real `anon`/`authenticated` roles, durable orchestration with worker-restart recovery, and a backup/restore drill.

2 gates remain blocked, both on the same missing thing — a deployment target. Deploying to an environment and the rollback drill cannot be performed without somewhere to deploy. They are named in [`docs/EVIDENCE.md`](docs/EVIDENCE.md) and the procedures are in [`docs/OPERATIONS.md`](docs/OPERATIONS.md) §5.

Persistence is durable when a database is supplied and in-process otherwise; the engines never see the difference, because they only hold the ports. Every push runs the full gate set in CI.

## Product constraint

Ragers is not intended to become Reddit, X, or a generic social network. The MVP stays centered on the Rager/Rave loop and on protecting the person being described.

## Reading order

1. [`docs/PRD.md`](docs/PRD.md) — what the product is
2. [`docs/BRD.md`](docs/BRD.md) — why, and the launch sequence
3. [`docs/ROADMAP.md`](docs/ROADMAP.md) — the 20 engine phases
4. [`docs/schema-diagram.md`](docs/schema-diagram.md) — the data model
5. [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — running and recovering it
6. [`docs/EVIDENCE.md`](docs/EVIDENCE.md) — what is actually proven
7. [`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md) — the content-separation rules, before editing any public copy
