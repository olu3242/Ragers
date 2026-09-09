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

The landing page stays framework-free on purpose (`AGENTS.md` #2). The engine lives in its own directory so the product can use a real stack without the marketing surface inheriting a build step.

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
npm test             # 212 assertions, no external dependencies
npm run typecheck    # strict TypeScript, zero errors
npm run dev          # http://localhost:3001
npm run test:e2e     # browser E2E against a production build
npm run certify      # every gate, then rewrite docs/EVIDENCE.md
```

## Current status

`RAGERS_ENGINE_E2E_READY_WITH_EXTERNAL_BLOCKERS`

13 certification gates pass: schema/migrations (static), unit, integration, authorization, retry/dead-letter, concurrency, voice, moderation failure-path, privacy/search leakage, accessibility, strict typecheck, production build, and browser E2E.

5 gates are blocked, each by a dependency that is not provisioned rather than by a defect: applying migrations to a live database, executing the RLS policies against that database, deploying to a target environment, and the backup/restore and rollback drills. They are named individually in [`docs/EVIDENCE.md`](docs/EVIDENCE.md), and the procedures for the last three are in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

The default persistence adapters are in-memory. A deployment swaps them for the Postgres/Supabase adapters at the composition root; no engine module changes, because they only ever see the ports.

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
