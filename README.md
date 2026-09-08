# Ragers

Ragers is a focused Rage/Rave behavioral network: a place to call out behavior that should happen less and celebrate behavior that should happen more, without turning the product into a generic discussion network.

## Phase 1 foundation

This branch establishes the first executable product slice:

- Public landing surface
- App shell with feed, composer, profile, and settings views
- Rager and Rave creation
- Public, Alias, and Anonymous identity modes
- Reusable aliases
- Local preview session persistence
- Self-delete for authored posts
- Deep links such as `app.html#create`
- Smoke checks for the core product contract

## Run locally

```bash
npm install
npm start
```

Or open `index.html` directly in a browser.

## Test

```bash
npm test
```

## Current status

`PHASE_1_EXECUTABLE_FOUNDATION_READY_WITH_BACKEND_BLOCKER`

The current persistence/authentication layer is intentionally browser-local. Production authentication, server-authoritative authorization, durable persistence, moderation, protected media processing, and cross-user engagement belong to the next dependency-ordered implementation batches.

## Product constraint

Ragers is not intended to become Reddit, X, or a generic social network. The MVP stays centered on the Rager/Rave loop and the principle:

> Critique the behavior. Protect the human.
