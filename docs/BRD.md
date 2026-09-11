# Business Requirements Document — Ragers

**Status:** Draft v1.0
**Classification:** Internal — do not publish or link from public surfaces

---

## 1. Business objective

Launch Ragers as a consumer social app that captures the everyday moment of "that should happen less / that should happen more," and build a defensible, engaged community around identity-safe behavioral reactions. The near-term business objective is user growth and engagement; monetization and any enterprise layer are deliberately sequenced after the consumer product proves retention.

## 2. Background / opportunity

Consumer appetite for low-stakes, shareable social commentary is proven (see: viral "overheard," "am I the a**hole"-style, and confession-style content across existing platforms), but that content currently lives on platforms not purpose-built for it — meaning no dedicated identity protection, no dedicated moderation model, and no dedicated product surface (it's a subreddit thread, a screenshot, a caption). Ragers is a purpose-built home for this behavior.

## 3. Stakeholders

| Stakeholder | Interest |
|---|---|
| Founder / Product | Define scope, prioritize roadmap, own the public/internal content-separation rule |
| Engineering | Build and ship the app, landing page, and supporting infrastructure |
| Design | Own visual identity and public-facing copy tone |
| Trust & Safety / Moderation | Own the reporting flow, community guidelines enforcement, and identity-protection accuracy |
| Marketing | Own the public landing page content, launch strategy, share-card virality |
| Legal | Review public copy, terms, privacy policy, and community guidelines for compliance |

## 4. Scope

### In scope (v1 business scope)
- Consumer mobile/web app: posting, reacting, reporting, deleting, alias/anonymous identity.
- Public marketing landing page (this repo).
- Community guidelines and a basic moderation workflow.
- Organic/social growth strategy centered on shareable "As Seen on Ragers" cards.

### Out of scope (v1 business scope)
- Paid acquisition strategy.
- Enterprise or B2B product line.
- Any monetization mechanism (ads, subscriptions, data products) — tracked separately, not part of v1 launch scope, and never described on public surfaces per the content-separation rule in `CLAUDE.md`.
- International localization beyond English.

## 5. Success criteria

- Public landing page live and converting visitors to signups at a healthy rate for a pre-network-effect consumer app.
- A visible, self-sustaining daily content loop (enough posts that "Live social proof" reflects real activity, not seeded placeholder content).
- Positive qualitative signal from early users that the anonymity/alias model feels trustworthy (measured via support/feedback channels, not just analytics).
- No public-surface leak of internal strategy, architecture, or roadmap language — audited as part of every landing-page release (see `CLAUDE.md` checklist).

## 6. Constraints

- **Content-separation constraint (hard):** nothing about AI/behavioral-intelligence architecture, trust-scoring methodology, moderation internals, data strategy, or monetization plans may appear on any public-facing surface. This is a standing business requirement, not just a design preference — it protects competitive positioning during the pre-launch and early-growth phase.
- **Trust constraint:** identity-protection claims made publicly must be true of the shipped product. Marketing copy cannot promise privacy guarantees the product doesn't deliver.
- **Timeline:** landing page and core posting/reaction loop are the minimum viable business scope for a public launch; trends/profile features can follow.

## 7. Assumptions

- Enough users are willing to post under an alias or anonymously that the anonymity model doesn't collapse into a mostly-lurking, rarely-posting audience.
- Community-based "Fair Rager?" voting is sufficient as a first-line trust signal without heavy-handed centralized moderation, at least at early scale.
- Organic/share-card virality is a viable primary growth channel before any paid spend.

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Public leak of internal strategy/architecture language | Competitive disadvantage, investor/positioning risk | Standing content-separation rule (`CLAUDE.md`), pre-publish audit checklist |
| Harassment/de-anonymization via detailed descriptions | Trust & Safety incident, reputational damage | Community guidelines, reporting flow, identity-protection tooling on photos |
| Negativity skew reduces "social mirror" feel | Product/brand risk — becomes a complaint board | Balanced content surfacing between Ragers and Raves |
| Low initial content volume undermines "Live social proof" | Poor first impression for new visitors | Seed content strategy for pre-launch, honest labeling if seeded |
| Platform imitation by an incumbent | Competitive risk | Tracked in internal strategy docs, out of scope for this BRD |

## 9. Dependencies

- Landing page (this repo) depends on final public copy sign-off from Marketing and Legal before launch.
- Identity-protection feature (photo handling) is a hard dependency for the "Privacy" section claims on the landing page — copy must not ship ahead of the feature.
- Community guidelines document must exist and be linkable from the footer before public launch.

## 10. Timeline (indicative — not a committed schedule)

1. **Phase 0:** Landing page live (waitlist / early access CTA), core app in closed beta.
2. **Phase 1:** Public launch of posting + reaction + reporting loop.
3. **Phase 2:** Alias profiles, share-card virality push, trends section (if content volume supports it).
4. **Phase 3+:** Anything beyond the consumer product (monetization, enterprise layer) — separate business case, separate document.
