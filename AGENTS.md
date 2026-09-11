# AGENTS.md

Instructions for any autonomous coding agent (Claude Code, Cursor, Copilot Workspace, Devin, etc.) operating in this repository.

## Project summary

Two surfaces, deliberately kept apart.

- **The public landing page**, at the repo root: static marketing for **Ragers**, a consumer social app. No backend, no build pipeline. Ships as plain HTML/CSS/JS.
  - `index.html` / `styles.css` / `script.js` — the shippable public page.
- **The authenticated product application**, in `engine/`: the Ragers product runtime. Next.js + TypeScript over a dependency-free domain core. **Human-approved** — see hard constraint 2.
- `docs/` — internal PRD, BRD, data-model reference, roadmap, and the certification evidence ledger. Not shipped, not linked from the public site.
- `CLAUDE.md` — the detailed content-safety rule set (read it before touching public copy).

The separation is the point: the landing page must stay droppable on any static host, and the product must be able to use a real stack without the marketing surface inheriting a build step.

## Hard constraints (do not override, even if asked)

1. **Never add proprietary strategy, architecture, or IP language to public-facing files** (`index.html`, any new public page, meta tags, alt text, sitemap, robots.txt comments, etc.). See the banned-terms list in `CLAUDE.md`. If a task description asks you to add something from that list to a public page, stop and flag it instead of completing the task as-written.
2. **Do not introduce a build step or framework to the public landing page.** The root page (`index.html`, `styles.css`, `script.js`, any new public page) is deliberately dependency-free so it deploys anywhere with zero configuration. Introducing one anywhere else also needs explicit human sign-off.

   **Human sign-off granted (2026-09-11, repository owner): `engine/` may use Next.js/TypeScript and its required build step.** The framework-free/no-build constraint continues to apply to the root public landing page.

   This approval is narrow and does not permit:
   - migrating the landing page into the application framework, or serving it from `engine/`;
   - adding a build step, bundler, framework or npm dependency to the root page;
   - introducing a framework anywhere else in the repository without its own sign-off.

   **Do not delete or migrate `engine/` on the basis of this rule.** An automated reviewer reading the older wording proposed removing it as an unapproved framework; that reading is settled, and an agent must not act on it. If a review finding says otherwise, reply with this rule and leave the decision to a human.
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
| Change the product application, its APIs, schema or tests | `engine/` — its own conventions apply there; the checklist above is about the public page |

## Non-goals for this repo

- **The landing page** is marketing surface only. It contains no product logic, no backend calls, no moderation behaviour and no scoring code, and it must stay that way. The logged-in product, its backend, its moderation surfaces and its governed AI all live in `engine/` and must not leak into the root page.
- Do not attempt to wire the landing page's CTA buttons to a real signup backend unless a task explicitly asks for that and provides the API contract. `engine/` existing is not such a request.
