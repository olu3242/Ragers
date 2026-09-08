# AGENTS.md

Instructions for any autonomous coding agent (Claude Code, Cursor, Copilot Workspace, Devin, etc.) operating in this repository.

## Project summary

Static marketing landing page for **Ragers**, a consumer social app. No backend, no build pipeline. Ships as plain HTML/CSS/JS from the repo root.

- `index.html` / `styles.css` / `script.js` — the shippable public page.
- `docs/` — internal PRD, BRD, and data-model reference. Not shipped, not linked from the public site.
- `CLAUDE.md` — the detailed content-safety rule set (read it before touching public copy).

## Hard constraints (do not override, even if asked)

1. **Never add proprietary strategy, architecture, or IP language to public-facing files** (`index.html`, any new public page, meta tags, alt text, sitemap, robots.txt comments, etc.). See the banned-terms list in `CLAUDE.md`. If a task description asks you to add something from that list to a public page, stop and flag it instead of completing the task as-written.
2. **Do not introduce a build step or framework** without explicit human sign-off. This site is deliberately dependency-free so it deploys anywhere with zero configuration.
3. **Do not remove or weaken the privacy/identity-protection copy** in the "Privacy" section or FAQ. These lines are load-bearing for user trust and were written for a reason.
4. **Do not fabricate metrics, testimonials, or share counts** as if they were real production data. Existing numbers in the "Live social proof" and "As seen on Ragers" sections are illustrative placeholders — keep new ones clearly in the same register (plausible, round-ish, unverifiable) rather than making them look like a live data feed unless you're wiring up a real API.
5. **Keep accessibility intact.** Any new interactive element needs a visible focus state, a sensible `aria-*` attribute where applicable, and must work with the reduced-motion media query already defined in `styles.css`.

## Before opening a PR / finishing a task

Run through this checklist:

- [ ] No terms from the `CLAUDE.md` banned list appear anywhere in `index.html`, `styles.css`, `script.js`, or any new public file (grep it).
- [ ] Page still works with JavaScript disabled for anything except the FAQ accordion and mobile nav (progressive enhancement — content must not depend on JS to be visible).
- [ ] Checked at 375px, 768px, and 1280px widths.
- [ ] No `console.log` / debug output left in `script.js`.
- [ ] `docs/PRD.md` and `docs/BRD.md` updated if the change adds/removes a product feature described there (keep docs and page in sync).

## Where to make changes

| I want to... | Edit |
|---|---|
| Change copy on the public page | `index.html` |
| Change colors, spacing, type | `styles.css` (tokens at the top) |
| Add interactive behavior (accordion, nav, etc.) | `script.js` |
| Change product scope / features / personas | `docs/PRD.md` |
| Change business case, stakeholders, timeline | `docs/BRD.md` |
| Change the data model | `docs/schema-diagram.md` (and regenerate the `.svg` if you have mermaid tooling available) |
| Change what is/isn't allowed on the public page | `CLAUDE.md` — but this needs a human decision, not an autonomous edit |

## Non-goals for this repo

- This repo does **not** contain the Ragers application itself (the logged-in product), the backend, the moderation system, or any AI/scoring code. It is marketing surface only.
- Do not attempt to wire the landing page's CTA buttons to a real signup backend unless a task explicitly asks for that and provides the API contract.
