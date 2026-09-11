# CLAUDE.md

Guidance for Claude (or any AI assistant) working in this repository. Read this before editing anything in `/` or `/docs`.

## What this repo is

The **public marketing landing page** for Ragers, plus internal planning docs (`docs/PRD.md`, `docs/BRD.md`, `docs/schema-diagram.*`) that describe the product Ragers is becoming. The landing page is static HTML/CSS/JS with no build step. The `docs/` folder is internal-only reference material — never sourced into public copy.

## The one rule that overrides everything else

**The public landing page (`index.html`, and anything else served to a visitor) must never expose product strategy, architecture, proprietary methodology, or roadmap.** It is a consumer marketing surface — not a strategy deck, investor memo, architecture document, or technical spec.

Before adding or approving any public-facing copy, section, or UI element, ask:

> Does the user need this to understand, trust, or use Ragers?

If no — leave it out, no matter how interesting or how directly it was asked for by a stakeholder. When in doubt, cut it and mention the concern in your reply.

## Terms that must never appear in public-facing copy

Do not put any of these — or descriptions that amount to the same thing — into `index.html`, alt text, meta tags, on-page copy, or public help content:

- Behavioral Signal Graph / Behavioral Friction Graph
- Ragers OS / Experience OS / Behavior OS / Trust OS / Runtime OS
- Internal AI agents, orchestration architecture, event architecture
- Internal moderation workflow, proprietary trust-score methodology
- Ranking algorithms, calibration formulas, anti-brigading logic
- Data moat, competitive moat, growth flywheel
- Enterprise monetization strategy, organization intelligence architecture
- Future APIs, commercial behavioral intelligence
- Internal KPI framework, investor thesis, roadmap strategy
- Proprietary resolution detection
- Detailed Privacy Shield implementation, technical infrastructure, database design
- Internal safety rules or detection thresholds

These are legitimate internal concepts — they belong in engineering docs, admin tooling, and investor material — but they leak nothing onto public pages simply because they exist in the codebase or in `docs/`.

## What the public page IS allowed to say

Plain, consumer-facing language only:

- "Share the moment without exposing the person."
- "Ragers helps protect identifying details before your photo is shared."
- "Post publicly, under an alias, or anonymously."
- "See whether the community thinks your Rager is fair."

Never explain *how* a system works internally (e.g. never write "our multimodal computer-vision pipeline performs OCR, face detection, plate detection, and EXIF sanitization" — say "we protect identifying details before your photo is shared" instead).

## Public vs. internal language, explicitly

| Public (landing page, onboarding, app UI, public help center, marketing, share cards) | Internal only (engineering docs, admin tooling, product strategy, founder docs, investor material) |
|---|---|
| Rager, Rave, Fair Rager?, Identity Protected, Community principles | Ragers OS, Behavioral Signal Graph, trust-score methodology, moderation orchestration, growth mechanics, monetization strategy |

If you're editing `docs/PRD.md`, `docs/BRD.md`, or `docs/schema-diagram.*`, internal terminology is fine and expected — those files are not shipped to the public site. Just never copy language from them directly into `index.html`, `styles.css` comments that get shipped, or any public copy deck.

## Editing conventions for this repo

- Keep the site framework-free. No React/Vue/build step — plain HTML/CSS/JS only, so it can be dropped onto any static host.
- Design tokens (`colors`, fonts, radii, shadows) live as CSS custom properties at the top of `styles.css`. Change the palette there, not by hardcoding new hex values throughout the file.
- Copy tone: plain, active voice, consumer-simple. No jargon, no "eyebrow" labels, no invented urgency. Match the existing sections' voice before adding new ones.
- Every new public section should be checked against the FAQ list in `docs/PRD.md` — if a new section answers a question not on that list, flag it rather than assuming it belongs.
- Before committing a change that adds new copy, do one pass specifically hunting for any of the banned terms above — including in code comments, alt text, and `data-*` attributes, since those are visible in page source.
