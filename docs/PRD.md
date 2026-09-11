# Product Requirements Document — Ragers

**Status:** Draft v1.0
**Owner:** Product
**Classification:** Internal — do not publish or link from public surfaces

---

## 1. Summary

Ragers is a consumer social platform for reacting to everyday behavior. Users post a short observation — something that should happen **less** (a **Rager**) or something that should happen **more** (a **Rave**) — and the community reacts. Posting can be public, under a persistent alias, or fully anonymous. The product's core promise is expressive catharsis without personal targeting: **critique the behavior, protect the human.**

## 2. Problem statement

People constantly encounter small, shareable moments of good and bad behavior — the person who held the door, the driver who blocked a crosswalk — but existing outlets are poor fits:

- General social media (X, Instagram, TikTok) rewards naming and shaming, escalates conflict, and exposes identifiable people.
- Local/community apps (Nextdoor, Citizen) skew toward complaints about neighbors and property, not universal social behavior, and often exposes location/identity.
- Review platforms (Yelp, Google Reviews) are tied to businesses, not people or moments.

There's no low-stakes, identity-safe outlet for "this happened, and I have a reaction to it" that works for both positive and negative moments.

## 3. Goals

1. Give users a fast, low-friction way to post a behavioral observation (under 30 seconds from open to post).
2. Make identity protection the default, not an opt-in — anonymous and alias posting are first-class, not buried settings.
3. Build a community-moderation loop ("Fair Rager?") that keeps posts about behavior, not people.
4. Reach a self-sustaining content loop (enough Ragers/Raves posted daily that the "Live social proof" feed feels alive) before spending on paid acquisition.

## 4. Non-goals (v1)

- Not a business review platform — posts are about behavior/moments, not rating a named business.
- Not a dispute-resolution or reporting-to-authorities tool.
- Not a public figure / celebrity commentary platform.
- Not, at this stage, a B2B/enterprise "organizational behavior intelligence" product — any enterprise layer is a possible future direction, tracked separately, and is explicitly out of scope for the public-facing v1 described in this document.

## 5. Target users / personas

**The Observer (primary)**
Everyday person, mobile-first, posts occasionally when something notable happens (a few times a month). Wants a fast way to vent or praise without a confrontation and without their name attached.

**The Scroller (primary)**
Reads more than posts. Comes for the "Live social proof" / "As Seen on Ragers" feed as light entertainment and social validation ("yes, that's annoying / that's wholesome"). Drives virality by sharing cards externally.

**The Regular (secondary)**
Builds a recognizable alias and posting history. Cares about their Fair Rager approval rate and follower-style social standing within the app.

## 6. Core user flows

### 6.1 Post a Rager or a Rave
1. User taps **Rager It** or **Rave It**.
2. User writes a short observation (character-limited, text-first; optional photo).
3. If a photo is attached, identifying details are protected before the post can go public.
4. User selects visibility: **Public**, **Alias**, or **Anonymous**.
5. Post publishes to the relevant feed.

### 6.2 React to a post ("Fair Rager?")
1. User views a post in the feed.
2. User can vote **Fair** / **Not Fair**, and/or react (🔥 / 🙌 style reactions).
3. Aggregate result displays on the card ("Fair Rager? 84% yes").

### 6.3 Report a post
1. User taps report on any post.
2. Selects a reason (naming/shaming a specific person, harassment, spam, other).
3. Post enters the moderation queue; user receives no further UI detail about internal handling.

### 6.4 Delete own post
1. From profile, user selects a post and deletes it.
2. Post is removed immediately from all public surfaces.

## 7. Feature list (v1)

| Feature | Description | Priority |
|---|---|---|
| Rager posting | Text (+ optional photo) post flagged as a Rager | P0 |
| Rave posting | Text (+ optional photo) post flagged as a Rave | P0 |
| Visibility control | Public / Alias / Anonymous, selected per post | P0 |
| Identity protection on photos | Automatic protection of identifying details before a photo is shown publicly | P0 |
| Fair Rager? voting | Binary community vote surfaced as a percentage | P0 |
| Reactions | Lightweight emoji-style reactions on posts | P1 |
| Report flow | User-initiated report with reason codes | P0 |
| Delete own post | Immediate self-service removal | P0 |
| Public share cards | Shareable image export of a post for external social platforms | P1 |
| Alias profiles | Persistent pseudonymous identity with a posting history | P1 |
| "People are Raging/Raving about" trends | Lightweight aggregate view of common categories | P2 |
| Public profiles | Optional public-facing profile for users who post as themselves | P2 |

## 8. Public landing page requirements

The landing page (this repo's `index.html`) must:

- Answer, in plain language: what is Ragers, why use it, how to use it, can I post anonymously, can I share a photo safely, what is a Rager, what is a Rave, what will other people see, how does Ragers protect people, why join.
- Include: navigation, hero, live social proof examples, the two core actions, a 3-step "how it works," a privacy section, share-card examples, a lightweight optional trends section, the community principle statement, an FAQ, a final CTA, and a footer.
- Never explain internal implementation, scoring, moderation architecture, or business strategy. See `CLAUDE.md` for the full rule and banned-terms list — this applies to every public surface, not just the homepage.

## 9. Success metrics

- **Activation:** % of new signups who post a Rager or Rave within 24 hours.
- **Retention:** week-2 return rate for users who have posted at least once.
- **Content health:** ratio of posts removed for naming/shaming to total posts (target: trending down over time).
- **Virality:** external shares of "As Seen on Ragers" cards per active user.
- **Trust:** average Fair Rager? participation rate per post (a proxy for whether the community feels engaged in the moderation loop rather than passive).

## 10. Risks

- **Harassment vector:** even with identity protection, users could describe enough detail to identify someone. Mitigated by community guidelines, reporting, and moderation — not solved by UI copy alone.
- **Negativity skew:** if Ragers significantly outpace Raves, the app can feel like a complaint board rather than a "social mirror." Product and content-surfacing decisions should actively balance the two.
- **Novelty decay:** the core loop is simple and could be copied quickly by an incumbent platform. Defensibility work is tracked in internal strategy docs, out of scope here.

## 11. Open questions

- Should alias identities be portable/reusable across visibility levels, or fully separate personas per alias?
- What's the minimum viable moderation SLA before public launch?
- Does the trends section (§7, P2) ship in v1 or wait for enough volume to be meaningful?
