# Ragers Engine — E2E Architecture Roadmap (Phases 1–50)

**Status:** v1.0
**Classification:** Internal — never published, never linked from a public surface. See `CLAUDE.md`.
**Source of truth:** `docs/PRD.md`, `docs/BRD.md` (Phase 0–3), `docs/schema-diagram.md`, and the shipped repository at the time of writing.

This roadmap decomposes the Ragers Engine into **20 dependency-ordered engine boundaries**. It is not an arbitrary
decomposition: each phase is a bounded context with its own aggregate ownership, commands, events, policies and
acceptance criteria. Phases are ordered so that no phase depends on a later phase.

---

## 0. Reconciliation against BRD Phase 0–3 and the shipped repository

BRD Phase 0–3 is a **business/launch sequence**, not an engineering decomposition. It is preserved, not replaced:

| BRD phase | Business meaning | Engine phases that satisfy it |
|---|---|---|
| Phase 0 | Landing page live, core app in closed beta | Engine P1–P4 |
| Phase 1 | Public launch of posting + reaction + reporting loop | Engine P5–P10 |
| Phase 2 | Alias profiles, share-card virality, trends | Engine P11–P17 |
| Phase 3+ | Beyond the consumer product | Engine P18–P20 (governance, analytics, operations) |

**Already shipped in this repository (do not rebuild — harmonize and extend):**

| Capability | Where | Verdict |
|---|---|---|
| Public marketing landing surface | `index.html`, `styles.css`, `script.js` | Keep as-is. Framework-free per `AGENTS.md` #2. Extend copy only. |
| App shell, 4 views, deep links (`app.html#create`) | `app.html`, `app.css`, `app.js` | Keep as the **local preview client**. Becomes a thin client over the engine. |
| Rager/Rave creation, text-only, 280 chars, category | `app.js` composer | Extend: becomes one *creation mode* of the canonical Experience aggregate. Voice is a peer mode. |
| Visibility modes public / alias / anonymous | `app.js` `currentIdentity()` | Extend: promote from render-time concern to authorization-enforced projection (P3). |
| Reusable aliases | `app.js` alias CRUD | Extend: server-owned, one-way-linked to actor (P3). |
| Self-delete of authored posts | `app.js` `data-delete-post` | Extend: becomes deletion **propagation** across all projections (P17). |
| Browser-local persistence | `localStorage` key `ragers.preview.v1` | Retain as preview adapter only. Superseded as source of truth by P5 persistence. |
| Banned-term leak audit | `tests-smoke.js` | Keep and extend into the certification harness (P20). |

**Known gaps at start (all 20 phases exist to close these):** no server-authoritative identity, no durable
persistence, no RLS, **no voice capability at all**, no moderation, no media/PII processing, no Ragers-native
reactions, no conversation, no search, no notifications, no reputation, no ranking, no admin surface, no analytics,
and no durable runtime (no idempotency, outbox, retry, or dead-letter handling).

---

## 1. The shared durable runtime (applies to every phase)

Every state change in every engine flows through one pipeline. A phase that bypasses it is not complete.

```
Command
  → Authorization / Policy        (deny by default; actor + resource + intent)
  → Domain Transition             (pure; state machine guards; no I/O)
  → Persistence                   (aggregate row + outbox row, one transaction)
  → Outbox / Domain Event         (at-least-once, ordered per aggregate)
  → Orchestration                 (routes events to consumers)
  → Async Consumers               (projections, enrichment, fan-out)
  → Success | Retry (backoff) | Dead Letter
```

**Required runtime primitives**, available to all phases:

- **Idempotency** — every command carries an idempotency key; replay returns the first result, never a second effect.
- **Correlation IDs** — one correlation ID spans a command and every event, job and log line it causes.
- **Outbox delivery** — domain events are persisted in the same transaction as the state change, then delivered.
- **Retry with backoff** — bounded attempts, deterministic backoff schedule.
- **Dead-letter handling** — exhausted work moves to a dead-letter store with its failure history, never vanishes.
- **Audit events** — every privileged or destructive action writes an immutable audit record.
- **Structured logs** — machine-readable, correlation-tagged, never containing raw PII or original media URLs.
- **Metrics** — counters/durations per command, per consumer, per failure class.
- **Health status** — per-dependency readiness, aggregated to one status.
- **Explicit async states** — `queued | processing | ready | failed | dead_letter` on every async-backed record.

## 2. Product invariants (binding on every phase)

1. **One canonical aggregate.** Text and voice are *creation modes* of the same Rage/Rave/Experience aggregate.
   There is no separate "voice post" entity.
2. **Voice is first-class from Phase 1**, not retrofitted.
3. **Ragers-native engagement only.** `Been There`, `Same`, `Fair Point`, `Disagree`, plus `Fair Rager?`.
   Generic Like / Upvote / Repost is **not** the primary engagement loop.
4. **Critique the behavior. Protect the human.** Original media and raw transcripts are never publicly reachable;
   only protected derivatives are.
5. **Anonymous means anonymous.** `visibility = anonymous` never exposes an actor identifier on any read path,
   while retaining internal attribution for safety.
6. **A phase is not complete because the UI exists.** Implementation **plus** automated evidence, or it is not done.

---

## 3. Phase catalogue

Each phase is specified against the same 16 fields.

---

### Phase 1 — Experience Engine

- **Objective:** Establish the canonical `Experience` aggregate (a Rage or a Rave) with a single lifecycle
  state machine, independent of creation mode, so every later engine has one thing to attach to.
- **Dependencies:** None (root phase).
- **Existing capability:** `app.js` creates post objects `{id, type, body, category, visibility, aliasId, createdAt}`
  in `localStorage`; type and category vocabularies already exist and are reused verbatim.
- **Gaps:** No aggregate identity beyond a client-generated string; no lifecycle states; no invariants; no
  separation of domain from rendering; no server ownership.
- **Schema/data:** `experiences` (id, actor_id, kind `rage|rave`, creation_mode `text|voice`, category, body_text,
  status, visibility, alias_id, correlation_id, created_at, updated_at, published_at, deleted_at, version).
- **Domain model / state machine:**
  `draft → validating → pending_media → pending_moderation → published → (hidden | removed | deleted)`;
  terminal states are `deleted` and `removed`. `pending_media` is skipped for text-only creation.
- **Commands / services:** `CreateExperience`, `UpdateExperienceBody`, `PublishExperience`, `HideExperience`.
- **Domain events:** `ExperienceDrafted`, `ExperienceValidated`, `ExperiencePublished`, `ExperienceHidden`.
- **Async jobs:** None owned by this phase; it emits the events others consume.
- **UI surfaces:** Existing composer in `app.html` (`#composerForm`) re-pointed at the command bus.
- **Authorization:** Only the authoring actor may draft, update or publish; body length and kind are validated
  server-side, never trusted from the client.
- **Failure/retry/recovery:** Validation failure is a terminal command rejection (no retry — invalid input is not
  transient). Publish is idempotent: replaying `PublishExperience` on a published aggregate is a no-op success.
- **Observability:** Counters per kind and creation mode; rejection counter by reason code.
- **Tests:** State-machine transition table (legal and illegal), body validation bounds, publish idempotency,
  version increment on mutation.
- **E2E acceptance:** A text Rage and a text Rave can each be created and published through the command bus and
  read back with correct status and version.
- **Certification evidence:** `experience.aggregate.test.ts`, `experience.statemachine.test.ts` green.

---

### Phase 2 — Voice Engine

- **Objective:** Make voice a first-class creation mode of the Phase 1 aggregate — capture, validate, upload and
  attach audio without introducing a parallel entity.
- **Dependencies:** P1.
- **Existing capability:** **None.** There is no audio capture, upload, storage or playback anywhere in the repo.
- **Gaps:** Entire capability. Microphone permission handling, recorder state machine, duration/size/mime
  validation, upload with resumability, asset lifecycle, authorized playback.
- **Schema/data:** `media_assets` (id, experience_id, kind `audio|image`, original_key *(internal only)*,
  protected_key *(public-facing)*, duration_ms, byte_size, mime_type, processing_status, attempt_count,
  failure_reason, created_at). Original and protected keys are separate columns by design.
- **Domain model / state machine:** Recorder: `idle → permission_pending → (permission_denied | ready) → recording
  ⇄ paused → stopped → preview → (re_record → ready | submitted)`.
  Asset: `queued → processing → ready | failed | dead_letter`.
- **Commands / services:** `RequestVoiceUploadTarget`, `AttachVoiceAsset`, `ValidateVoiceAsset`,
  `RequestPlaybackUrl`.
- **Domain events:** `VoiceAssetAttached`, `VoiceAssetValidated`, `VoiceAssetRejected`.
- **Async jobs:** `voice.validate` (probe duration/mime/size), feeding the P10 protection pipeline.
- **UI surfaces:** Recorder in the composer — permission prompt, live elapsed timer, waveform/level meter,
  pause/resume/stop, preview player, re-record, explicit submit. Keyboard-operable and reduced-motion safe.
- **Authorization:** Upload targets are single-use, scoped to one actor and one experience, and expire.
  Playback URLs are short-lived, issued per authorized viewer, and never point at `original_key`.
- **Failure/retry/recovery:** Permission denial degrades to text mode without losing typed content. Upload failure
  is retryable and resumable. Validation failure marks the asset `failed` and blocks publish with a clear reason.
  Exhausted validation → `dead_letter`, aggregate stays in `pending_media`, never silently published.
- **Observability:** Permission grant/deny rates, recording durations, upload failure classes, validation
  failure reasons, dead-letter count.
- **Tests:** Recorder state machine including denial and re-record loops; duration/size/mime bound rejection;
  upload-target single-use and expiry; playback URL never resolves to `original_key`.
- **E2E acceptance:** The voice golden path completes: choose Rage/Rave → choose Voice → permission → record →
  pause/resume/stop → preview → re-record → validate → upload → persist canonical Experience → publish.
- **Certification evidence:** `voice.recorder.test.ts`, `voice.validation.test.ts`, `voice.playback.authz.test.ts`.

---

### Phase 3 — Identity & Access Engine

- **Objective:** Server-authoritative actors, sessions, aliases and the three visibility modes, with a single
  policy layer every other engine calls.
- **Dependencies:** P1.
- **Existing capability:** `app.js` local "auth" (email + display name in `localStorage`), alias create/list,
  and `currentIdentity()` which resolves display identity for the three visibility modes at render time.
- **Gaps:** No real authentication, no sessions, no server-side authorization, no RLS. Visibility is currently a
  *rendering* decision, which is not a privacy guarantee.
- **Schema/data:** `actors` (id, email, auth_provider, default_visibility, role, status, created_at,
  last_active_at); `aliases` (id, actor_id, alias_name, is_active, created_at) with a uniqueness constraint on
  active alias names; `sessions` (id, actor_id, issued_at, expires_at, revoked_at).
- **Domain model / state machine:** Actor: `pending → active → (suspended → active | closed)`.
  Session: `active → (expired | revoked)`.
- **Commands / services:** `RegisterActor`, `AuthenticateActor`, `IssueSession`, `RevokeSession`, `CreateAlias`,
  `RetireAlias`, `SetDefaultVisibility`. Policy service: `can(actor, action, resource) → Allow | Deny(reason)`.
- **Domain events:** `ActorRegistered`, `SessionIssued`, `SessionRevoked`, `AliasCreated`, `AliasRetired`.
- **Async jobs:** `session.reap` (expire stale sessions).
- **UI surfaces:** Existing `#authForm` re-pointed at real authentication; alias management in Settings;
  default-visibility control.
- **Authorization:** **Deny by default.** Every read and write path resolves through the policy layer. RLS
  policies in Postgres mirror the application policy so the database is not a second, weaker gate.
- **Failure/retry/recovery:** Authentication failures are rate-limited and never disclose whether an account
  exists. Session revocation takes effect immediately on the next command.
- **Observability:** Auth success/failure by reason, active sessions, alias churn, policy-denial counters by
  action.
- **Tests:** Policy matrix over (actor role × action × resource ownership × visibility); alias name uniqueness;
  session expiry and revocation; **anonymity leakage** — no read projection of an anonymous experience contains
  `actor_id` or alias data.
- **E2E acceptance:** An actor authenticates, creates an alias, and publishes one experience in each of the three
  visibility modes; each read projection exposes exactly the intended identity and nothing more.
- **Certification evidence:** `identity.policy.test.ts`, `identity.anonymity.test.ts`, `identity.session.test.ts`.

---

### Phase 4 — Content Runtime / Orchestration Engine

- **Objective:** Implement the shared durable runtime itself — the command bus, idempotency, outbox,
  orchestration, retry and dead-letter machinery every other phase depends on.
- **Dependencies:** P1, P3.
- **Existing capability:** None. `app.js` mutates state and calls `saveState()` synchronously.
- **Gaps:** Entire runtime. No command envelope, no idempotency, no events, no workers, no failure taxonomy.
- **Schema/data:** `idempotency_keys` (key PK, actor_id, command_name, result_hash, response_body, created_at);
  `outbox` (id, aggregate_type, aggregate_id, sequence, event_name, payload, correlation_id, status,
  attempt_count, next_attempt_at, created_at, delivered_at); `dead_letters` (id, source, event_name, payload,
  failure_history, created_at); `audit_events` (id, actor_id, action, resource, before, after, correlation_id,
  created_at).
- **Domain model / state machine:** Work item: `queued → processing → ready | failed → (retry → queued |
  dead_letter)`. Outbox rows are delivered in `sequence` order per aggregate.
- **Commands / services:** `CommandBus.dispatch(envelope)`; `Orchestrator.drain()`; `Consumer.handle(event)`;
  `RetryPolicy.nextAttempt(attempt)`; `DeadLetterStore.record()`.
- **Domain events:** Meta-events only: `WorkItemRetried`, `WorkItemDeadLettered`.
- **Async jobs:** `outbox.drain` (the delivery loop), `deadletter.sweep` (reporting).
- **UI surfaces:** None user-facing; feeds the P18 admin surface and P19 health endpoint.
- **Authorization:** The bus enforces policy *before* any domain transition — authorization cannot be skipped by
  calling a handler directly, because handlers are only reachable through the bus.
- **Failure/retry/recovery:** Bounded attempts with deterministic backoff; poison messages dead-letter with full
  failure history; at-least-once delivery means **all consumers must be idempotent** — enforced by test.
- **Observability:** Outbox depth and lag, attempts per event, dead-letter rate, per-command duration.
- **Tests:** Idempotent replay returns the identical first response; outbox ordering per aggregate; retry
  schedule determinism; dead-letter after exhaustion with history intact; consumer re-delivery causes no double
  effect; authorization cannot be bypassed.
- **E2E acceptance:** A command produces exactly one state change and one delivered event under duplicate
  dispatch, and a permanently failing consumer lands in the dead-letter store without losing the event.
- **Certification evidence:** `runtime.idempotency.test.ts`, `runtime.outbox.test.ts`, `runtime.retry.test.ts`,
  `runtime.deadletter.test.ts`, `runtime.concurrency.test.ts`.

---

### Phase 5 — Feed Engine

- **Objective:** Durable, privacy-correct read projections of published experiences — the first surface where the
  engine replaces `localStorage` as source of truth.
- **Dependencies:** P1, P3, P4.
- **Existing capability:** `renderFeed()` + `renderPostCard()` render from local state; filter chips already
  implement All / Ragers / Raves, and that vocabulary is reused.
- **Gaps:** No server projection, no pagination, no visibility filtering at the data layer, no cursor stability.
- **Schema/data:** `feed_entries` (experience_id PK, kind, creation_mode, category, excerpt, has_voice,
  duration_ms, identity_label, alias_name, published_at, rank_score, status) — a projection deliberately
  containing **no** `actor_id`, so an anonymity bug in the feed is structurally impossible.
- **Domain model / state machine:** Entry: `absent → present → (suppressed → present | purged)`.
- **Commands / services:** `GetFeed(cursor, filter)`, `GetExperience(id)`; internal `ProjectFeedEntry`.
- **Domain events:** Consumes `ExperiencePublished`, `ExperienceHidden`, `ExperienceDeleted`; emits
  `FeedEntryProjected`.
- **Async jobs:** `feed.project` (consumer, idempotent by experience_id).
- **UI surfaces:** Existing feed view and filter chips, now cursor-paginated with a voice affordance on cards.
- **Authorization:** Reads are policy-filtered; suppressed and removed entries are invisible to non-moderators.
- **Failure/retry/recovery:** Projection lag is tolerated (published experience appears when projected); retry on
  transient failure; dead-letter leaves the experience published but unlisted, and the gap is reported.
- **Observability:** Projection lag, feed query latency, entries by kind/mode.
- **Tests:** Cursor pagination stability under concurrent inserts; anonymous entries carry no actor identifier;
  suppressed entries excluded; projection idempotency under re-delivery.
- **E2E acceptance:** Published text and voice experiences appear in the feed with correct identity labels and
  survive a full projection rebuild.
- **Certification evidence:** `feed.projection.test.ts`, `feed.pagination.test.ts`, `feed.privacy.test.ts`.

---

### Phase 6 — Reaction Engine

- **Objective:** Ragers-native engagement mechanics — `Been There`, `Same`, `Fair Point`, `Disagree` — plus the
  `Fair Rager?` fairness vote. Explicitly **not** a generic Like/Upvote/Repost loop.
- **Dependencies:** P1, P3, P4, P5.
- **Existing capability:** None. The PRD names `Fair Rager?` and reactions; nothing is implemented.
- **Gaps:** Entire capability, including one-per-actor-per-kind semantics and aggregate counters.
- **Schema/data:** `reactions` (id, experience_id, actor_id, reaction_type
  `been_there|same|fair_point|disagree`, created_at) with `UNIQUE(experience_id, actor_id, reaction_type)`;
  `fair_votes` (id, experience_id, actor_id, is_fair, created_at) with `UNIQUE(experience_id, actor_id)`;
  `experience_counters` (experience_id PK, been_there, same, fair_point, disagree, fair_yes, fair_no).
- **Domain model / state machine:** Reaction: `absent ⇄ present` (toggle). Fair vote: `absent → cast → recast`
  (a vote may be changed, never duplicated).
- **Commands / services:** `ToggleReaction`, `CastFairVote`, `GetExperienceEngagement`.
- **Domain events:** `ReactionAdded`, `ReactionRemoved`, `FairVoteCast`, `FairVoteChanged`.
- **Async jobs:** `counters.recompute` (idempotent counter projection).
- **UI surfaces:** Reaction row on every card with the four named mechanics; `Fair Rager?` control with the
  aggregate percentage shown after the viewer votes.
- **Authorization:** Authenticated actors only; an actor may not react to their own experience's fairness vote;
  reactions on hidden or removed experiences are rejected.
- **Failure/retry/recovery:** Uniqueness violations resolve idempotently to the current state rather than
  erroring. Counter drift is repairable by replaying `counters.recompute`.
- **Observability:** Reactions per type, fairness participation rate, self-vote rejection count.
- **Tests:** Double-toggle returns to the original state; duplicate concurrent reactions produce one row;
  fair-vote recast does not inflate totals; counters converge after out-of-order event delivery; no generic
  Like/Upvote/Repost type is accepted.
- **E2E acceptance:** Two actors react and vote on one experience; counters and the fairness percentage are exact
  under concurrent submission.
- **Certification evidence:** `reaction.mechanics.test.ts`, `reaction.counters.test.ts`, `fairvote.test.ts`.

---

### Phase 7 — Conversation Engine

- **Objective:** Threaded replies on an experience, in both text and voice, reusing the same media pipeline.
- **Dependencies:** P1, P2, P3, P4, P5.
- **Existing capability:** None.
- **Gaps:** Entire capability, including depth limits and reply-level moderation.
- **Schema/data:** `replies` (id, experience_id, parent_reply_id, actor_id, creation_mode, body_text, visibility,
  alias_id, status, depth, created_at); replies reuse `media_assets` via `reply_id`.
- **Domain model / state machine:** Same lifecycle as an experience:
  `draft → pending_media → pending_moderation → published → (hidden | removed | deleted)`. `depth` is capped.
- **Commands / services:** `CreateReply`, `PublishReply`, `DeleteReply`, `GetThread`.
- **Domain events:** `ReplyPublished`, `ReplyHidden`, `ReplyDeleted`.
- **Async jobs:** Reuses `voice.validate`, the P10 protection pipeline, and `search.index`.
- **UI surfaces:** Thread view with nested replies, a text/voice reply composer, and inline playback.
- **Authorization:** Replies inherit the parent's visibility constraints; replying to a removed experience is
  rejected; anonymous replies leak no actor identifier.
- **Failure/retry/recovery:** Depth-cap breach is a terminal rejection. Orphan prevention: deleting a parent
  cascades per P17 deletion propagation rather than leaving dangling threads.
- **Observability:** Replies per experience, depth distribution, voice-reply share.
- **Tests:** Depth cap enforced; reply to removed parent rejected; anonymous reply projection carries no actor;
  voice replies traverse the same validation and protection path.
- **E2E acceptance:** A voice reply on a voice experience publishes, appears in the thread, and plays back only
  for authorized viewers.
- **Certification evidence:** `conversation.thread.test.ts`, `conversation.authz.test.ts`.

---

### Phase 8 — Voice Intelligence Engine

- **Objective:** Enrich voice content — transcription, language detection, duration/quality signals — as async
  consumers that never block publish and never leak raw output.
- **Dependencies:** P2, P4, P10.
- **Existing capability:** None.
- **Gaps:** Entire capability, plus the provider-boundary abstraction so no vendor is load-bearing in the domain.
- **Schema/data:** `transcripts` (id, media_asset_id, raw_text *(internal only)*, redacted_text
  *(public-facing)*, language, confidence, processing_status, attempt_count, failure_reason, provider,
  created_at).
- **Domain model / state machine:** `queued → processing → ready | failed | dead_letter`.
- **Commands / services:** `RequestTranscription`, `GetTranscript` (returns `redacted_text` only);
  `TranscriptionProvider` port with a deterministic fake used in tests.
- **Domain events:** `TranscriptionRequested`, `TranscriptionCompleted`, `TranscriptionFailed`.
- **Async jobs:** `voice.transcribe`, then `privacy.redact_transcript` (P10) before anything is readable.
- **UI surfaces:** Caption/transcript toggle under the player; explicit "transcript unavailable" state rather
  than a silent empty box.
- **Authorization:** `raw_text` is never returned by any read path — only `redacted_text`, and only to viewers
  authorized for the parent experience.
- **Failure/retry/recovery:** Transcription failure never blocks publish or playback; retries with backoff;
  exhaustion → `dead_letter` and the UI shows the unavailable state.
- **Observability:** Transcription latency, failure classes, provider error rates, dead-letter count.
- **Tests:** Publish succeeds while transcription is `queued`; retry then dead-letter path; **`raw_text` never
  appears in any API response or search document**; provider fake determinism.
- **E2E acceptance:** A published voice experience becomes searchable and captioned via redacted transcript text
  only, with the raw transcript unreachable from every read path.
- **Certification evidence:** `voice.transcription.test.ts`, `voice.transcript.leakage.test.ts`.

---

### Phase 9 — Trust & Safety Engine

- **Objective:** Reporting, the moderation queue, moderation actions, and enforcement of "critique the behavior,
  protect the human" as executable policy.
- **Dependencies:** P1, P3, P4, P5, P7.
- **Existing capability:** None. PRD §6.3 specifies the flow; nothing is implemented.
- **Gaps:** Entire capability, including pre-publish screening and moderator authorization.
- **Schema/data:** `reports` (id, target_type `experience|reply`, target_id, reporter_actor_id, reason_code
  `naming_shaming|harassment|spam|other`, status `open|reviewed|closed`, created_at);
  `moderation_actions` (id, target_type, target_id, moderator_id, action `warn|remove|restore|no_action`,
  reason, correlation_id, created_at); `moderation_queue` (target_type, target_id, priority, state, claimed_by,
  claimed_at).
- **Domain model / state machine:** Report: `open → reviewed → closed`. Queue item: `queued → claimed →
  actioned | released`. Target: `pending_moderation → published | removed`, and `published → under_review →
  (published | removed)`.
- **Commands / services:** `FileReport`, `ClaimQueueItem`, `ApplyModerationAction`, `ReleaseQueueItem`,
  `ScreenContent`.
- **Domain events:** `ReportFiled`, `ContentScreened`, `ModerationActionApplied`, `ContentRemoved`,
  `ContentRestored`.
- **Async jobs:** `moderation.screen` (pre-publish), `moderation.enqueue`, `moderation.propagate` (removal fans
  out to feed, search, notifications).
- **UI surfaces:** Report control with reason codes and a neutral confirmation that discloses **no** internal
  handling detail (PRD §6.3); moderator queue in the P18 admin surface.
- **Authorization:** Only `moderator`/`admin` roles may claim or action; reporters learn nothing about internal
  state; a moderator cannot action their own content.
- **Failure/retry/recovery:** **Screening failure fails closed** — the experience stays in `pending_moderation`
  and is never published by default. Retry with backoff; exhaustion → `dead_letter` plus an operator alert, still
  unpublished. Removal propagation is idempotent and retried until every projection agrees.
- **Observability:** Queue depth and age, time-to-action, actions by type, screen failure rate, fail-closed count.
- **Tests:** Screening failure never publishes; removal propagates to feed, search and notifications; moderator
  authorization matrix; reporter receives no internal detail; self-moderation rejected; propagation idempotent.
- **E2E acceptance:** A reported experience is removed by a moderator and disappears from every read surface —
  feed, thread, search, notifications — with an audit record written.
- **Certification evidence:** `safety.moderation.test.ts`, `safety.failclosed.test.ts`,
  `safety.propagation.test.ts`, `safety.authz.test.ts`.

---

### Phase 10 — Privacy & PII Engine

- **Objective:** Deliver the landing page's "Identity Protected" promise as real machinery: detect and redact
  identifying detail in media and transcripts before anything is publicly reachable.
- **Dependencies:** P2, P4, P8.
- **Existing capability:** Landing-page privacy copy only. The BRD names this a hard dependency for that copy.
- **Gaps:** Entire pipeline: detection, redaction, original/protected separation, verified non-exposure.
- **Schema/data:** Extends `media_assets` with `protection_status`, `protection_findings` (counts by class, never
  raw values), `protected_key`; extends `transcripts` with `redacted_text` and `redaction_findings`.
- **Domain model / state machine:** `queued → processing → protected | failed | dead_letter`. Publish is gated on
  `protected`.
- **Commands / services:** `ProtectMediaAsset`, `RedactTranscript`, `GetProtectedAssetUrl`; `PiiDetector` port
  with a deterministic fake for tests.
- **Domain events:** `MediaProtected`, `MediaProtectionFailed`, `TranscriptRedacted`.
- **Async jobs:** `privacy.protect_media`, `privacy.redact_transcript`.
- **UI surfaces:** "Protecting your audio…" progress state in the composer; `Identity Protected` badge on cards;
  a blocking explanation when protection fails, never a silent publish.
- **Authorization:** `original_key` and `raw_text` are unreachable from every public read path, by both
  application policy and RLS. Only protected derivatives are servable.
- **Failure/retry/recovery:** **Fails closed** — protection failure blocks publish. Retries with backoff;
  exhaustion → `dead_letter`, the aggregate stays `pending_media`, and the author is told it could not be
  protected.
- **Observability:** Protection latency, findings by class, failure rate, fail-closed count, dead-letter count.
- **Tests:** Publish blocked while protection is pending or failed; **no read path returns `original_key` or
  `raw_text`** (exhaustive projection sweep); redaction applied before search indexing; findings never contain
  raw detected values.
- **E2E acceptance:** A voice experience containing identifying detail publishes only its protected asset and
  redacted transcript; the originals are unreachable from every read path and from search.
- **Certification evidence:** `privacy.protection.test.ts`, `privacy.leakage.test.ts`,
  `privacy.failclosed.test.ts`.

---

### Phase 11 — Search Engine

- **Objective:** Search over privacy-safe projections only, so search can never become a de-anonymization or
  leakage vector.
- **Dependencies:** P5, P8, P9, P10.
- **Existing capability:** None.
- **Gaps:** Entire capability, including index invalidation on moderation and deletion.
- **Schema/data:** `search_documents` (experience_id PK, kind, category, searchable_text *(redacted only)*,
  subject_terms, identity_label, has_voice, published_at, status) — no `actor_id`, no raw transcript, by design.
- **Domain model / state machine:** Document: `absent → indexed → (stale → indexed | purged)`.
- **Commands / services:** `Search(query, filters, cursor)`; internal `IndexExperience`, `PurgeDocument`.
- **Domain events:** Consumes `ExperiencePublished`, `TranscriptRedacted`, `ContentRemoved`,
  `ExperienceDeleted`; emits `DocumentIndexed`, `DocumentPurged`.
- **Async jobs:** `search.index`, `search.purge`.
- **UI surfaces:** Search input with kind/category filters and voice-only toggle; empty and no-results states.
- **Authorization:** Results are policy-filtered per viewer; removed, hidden and deleted content is never
  returned; anonymous results expose no actor identifier.
- **Failure/retry/recovery:** Indexing lag is tolerated for *additions*; **purges are treated as urgent** and
  retried aggressively, because a stale index entry after removal is a privacy incident, not a latency issue.
- **Observability:** Index lag, purge lag, query latency, zero-result rate.
- **Tests:** Removed content is unsearchable; deleted content is purged; only redacted text is indexed;
  anonymous documents carry no actor identifier; index rebuild is idempotent.
- **E2E acceptance:** A published voice experience is searchable by its redacted transcript, and becomes
  unsearchable immediately after moderation removal or author deletion.
- **Certification evidence:** `search.indexing.test.ts`, `search.purge.test.ts`, `search.leakage.test.ts`.

---

### Phase 12 — Subject Graph Engine

- **Objective:** Extract and relate *behavioral subjects* (the behavior being critiqued or celebrated) without
  ever building a graph of identified people.
- **Dependencies:** P1, P8, P10, P11.
- **Existing capability:** The `category` vocabulary in the composer is the seed taxonomy and is reused.
- **Gaps:** Term extraction, subject normalization, subject↔experience edges, and the guardrail that subjects
  are behaviors, never persons.
- **Schema/data:** `subjects` (id, canonical_term, kind `behavior|context|place_type`, parent_subject_id,
  experience_count); `experience_subjects` (experience_id, subject_id, weight, source `category|extracted`).
- **Domain model / state machine:** Subject: `candidate → canonical → (merged | retired)`.
- **Commands / services:** `ExtractSubjects`, `MergeSubjects`, `GetSubject`, `GetExperiencesBySubject`.
- **Domain events:** `SubjectsExtracted`, `SubjectsMerged`.
- **Async jobs:** `subject.extract` (consumes redacted text only), `subject.recount`.
- **UI surfaces:** Subject chips on cards; a subject detail view listing related experiences.
- **Authorization:** Extraction reads **only** redacted text. Person-identifying candidate terms are rejected at
  extraction, so the guardrail is structural rather than a review step.
- **Failure/retry/recovery:** Extraction failure is non-blocking (the experience keeps its category); retry then
  dead-letter.
- **Observability:** Subjects per experience, candidate rejection rate, merge frequency.
- **Tests:** Extraction never runs on raw transcript text; person-name candidates rejected; merge preserves edge
  counts; recount converges after out-of-order delivery.
- **E2E acceptance:** Two experiences about the same behavior resolve to one canonical subject and are reachable
  from that subject's view.
- **Certification evidence:** `subject.extraction.test.ts`, `subject.guardrail.test.ts`.

---

### Phase 13 — Social Graph Engine

- **Objective:** Follows, mutes and blocks between *actors and aliases*, with block semantics strong enough to be
  a safety primitive rather than a preference.
- **Dependencies:** P3, P4, P5.
- **Existing capability:** Alias identities exist (P3); no relationships.
- **Gaps:** Entire capability, plus its required effect on feed, notifications and conversation.
- **Schema/data:** `follows` (follower_actor_id, followee_ref `actor|alias` + id, created_at,
  `UNIQUE(follower, followee_ref, followee_id)`); `blocks` (actor_id, blocked_ref, blocked_id, created_at);
  `mutes` (actor_id, muted_ref, muted_id, created_at).
- **Domain model / state machine:** Edge: `absent ⇄ present`. A `block` supersedes and removes any `follow` in
  either direction.
- **Commands / services:** `Follow`, `Unfollow`, `Block`, `Unblock`, `Mute`, `Unmute`, `GetGraphFor`.
- **Domain events:** `ActorFollowed`, `ActorUnfollowed`, `ActorBlocked`, `ActorUnblocked`.
- **Async jobs:** `graph.apply_block` (removes follows, suppresses feed entries, cancels pending notifications).
- **UI surfaces:** Follow/block/mute controls on profiles and cards; a following feed filter.
- **Authorization:** Blocks are enforced on **every** read path and in notification fan-out, not just in the UI.
  Following an anonymous experience's author is impossible by construction — there is no author reference to
  follow.
- **Failure/retry/recovery:** Block application is idempotent and retried until every surface reflects it;
  incomplete block application is treated as a safety incident and alerted, not merely logged.
- **Observability:** Graph edge counts, block application latency, notification suppression count.
- **Tests:** Block removes mutual follows; blocked actor's content absent from feed, thread and search results;
  blocked actor receives no notifications; anonymous experiences expose no followable reference; block
  application idempotent.
- **E2E acceptance:** After a block, neither party sees the other on any surface and no notification crosses the
  boundary.
- **Certification evidence:** `graph.block.test.ts`, `graph.follow.test.ts`, `graph.enforcement.test.ts`.

---

### Phase 14 — Notification Engine

- **Objective:** Deliver notifications for reactions, replies and moderation outcomes with dedupe, idempotency and
  strict respect for anonymity and blocks.
- **Dependencies:** P4, P6, P7, P9, P13.
- **Existing capability:** In-app `showToast()` only — ephemeral, local, not a notification system.
- **Gaps:** Entire capability, including fan-out, dedupe, read state and preferences.
- **Schema/data:** `notifications` (id, recipient_actor_id, kind, subject_ref, subject_id, actor_label, payload,
  dedupe_key, state `pending|delivered|read|suppressed`, created_at, delivered_at, read_at) with
  `UNIQUE(recipient_actor_id, dedupe_key)`; `notification_preferences` (actor_id, kind, enabled).
- **Domain model / state machine:** `pending → delivered → read`, or `pending → suppressed` (block, preference,
  or self-notification).
- **Commands / services:** `FanOutNotification`, `MarkNotificationRead`, `MarkAllRead`, `GetNotifications`,
  `SetNotificationPreference`.
- **Domain events:** `NotificationCreated`, `NotificationSuppressed`, `NotificationRead`.
- **Async jobs:** `notify.fanout`, `notify.reap` (retention).
- **UI surfaces:** Notification list with unread count and per-kind preferences.
- **Authorization:** Recipients read only their own notifications. `actor_label` respects the originating
  experience's visibility — a reaction from an anonymous actor never names them.
- **Failure/retry/recovery:** Fan-out is idempotent via `dedupe_key`; at-least-once delivery cannot produce
  duplicates. Retry then dead-letter; a dead-lettered notification never blocks the originating action.
- **Observability:** Fan-out latency, notifications by kind, suppression reasons, duplicate-prevention hits.
- **Tests:** Duplicate event delivery creates one notification; self-actions notify nobody; blocked actors
  suppressed; anonymous reactions produce no identifying label; preferences honored.
- **E2E acceptance:** Reactions and replies notify the author exactly once each, with anonymity and blocks
  respected, under duplicate event delivery.
- **Certification evidence:** `notification.dedupe.test.ts`, `notification.privacy.test.ts`,
  `notification.suppression.test.ts`.

---

### Phase 15 — Reputation & Context Engine

- **Objective:** Derive actor-level standing (PRD's "Regular" persona and their fairness approval rate) and
  per-experience context signals, without exposing raw internal scoring.
- **Dependencies:** P6, P9, P13, P14.
- **Existing capability:** `profilePostCount` / `profileAliasCount` counters in the profile view.
- **Gaps:** Fairness approval rate, contribution history, standing tiers, and the public/internal split of those
  signals.
- **Schema/data:** `actor_reputation` (actor_id PK, experiences_published, fair_yes_received, fair_no_received,
  approval_rate, removals_received, standing `new|established|trusted|limited`, internal_signals *(internal
  only)*, updated_at); `alias_reputation` keyed by alias, deliberately not publicly linkable to the actor.
- **Domain model / state machine:** Standing: `new → established → trusted`, with `→ limited` on enforcement and
  a recovery path back to `established`.
- **Commands / services:** `RecomputeReputation`, `GetPublicReputation` (public fields only),
  `GetInternalReputation` (moderator/admin only).
- **Domain events:** Consumes `FairVoteCast`, `ContentRemoved`, `ExperiencePublished`; emits
  `ReputationRecomputed`, `StandingChanged`.
- **Async jobs:** `reputation.recompute` (idempotent, derived purely from durable facts).
- **UI surfaces:** Approval rate and post count on profiles; standing is **not** displayed as a score to other
  users.
- **Authorization:** `internal_signals` are moderator/admin-only. Alias reputation never discloses the owning
  actor. Public reputation exposes only approval rate and counts.
- **Failure/retry/recovery:** Fully recomputable from source facts, so drift is always repairable by replay;
  recompute failure degrades to the last known values rather than blocking reads.
- **Observability:** Recompute duration, standing distribution, transition counts.
- **Tests:** Recompute is deterministic and idempotent; alias reputation is not linkable to the actor;
  `internal_signals` absent from every public projection; standing transitions follow the machine.
- **E2E acceptance:** Fairness votes across several experiences produce a correct public approval rate, and the
  alias↔actor link is unreachable publicly.
- **Certification evidence:** `reputation.recompute.test.ts`, `reputation.exposure.test.ts`.

---

### Phase 16 — Ranking & Trends Engine

- **Objective:** Order feeds and surface "People are Raging/Raving about" trends (PRD §7, P2) over Ragers-native
  mechanics, with the Rager/Rave balance the PRD calls for as an explicit ranking input.
- **Dependencies:** P5, P6, P12, P15.
- **Existing capability:** Reverse-chronological local ordering and the All/Ragers/Raves filter.
- **Gaps:** Ranking inputs, decay, trend windows, and the balance control that prevents the "complaint board" risk
  named in PRD §10.
- **Schema/data:** `ranking_inputs` (experience_id PK, engagement_score, fairness_score, recency_decay,
  balance_adjustment, final_score, computed_at); `trends` (id, subject_id, window `1h|24h|7d`, kind, volume,
  velocity, computed_at).
- **Domain model / state machine:** Trend: `emerging → trending → cooling → expired`.
- **Commands / services:** `ComputeRanking`, `GetRankedFeed`, `ComputeTrends`, `GetTrends`.
- **Domain events:** `RankingComputed`, `TrendsComputed`.
- **Async jobs:** `ranking.compute` (scheduled + event-triggered), `trends.compute` (windowed).
- **UI surfaces:** Ranked feed ordering; a lightweight trends section gated on volume so it is never shown empty.
- **Authorization:** Ranking inputs and formulas are internal-only; no read path exposes score components. Only
  published, unremoved, non-blocked content is rankable.
- **Failure/retry/recovery:** Ranking failure falls back to reverse-chronological ordering — the feed always
  renders. Trend computation failure hides the trends section rather than showing stale data.
- **Observability:** Ranking compute duration, score distribution, Rager/Rave balance ratio, trend churn.
- **Tests:** Ranking is deterministic for fixed inputs; removed and blocked content is unrankable; decay is
  monotonic in age; balance adjustment measurably counteracts Rager skew; fallback ordering on failure;
  trends suppressed below the volume threshold.
- **E2E acceptance:** A ranked feed orders by the composite score, degrades safely to chronological on failure,
  and trends appear only once the volume threshold is met.
- **Certification evidence:** `ranking.determinism.test.ts`, `ranking.balance.test.ts`,
  `ranking.fallback.test.ts`, `trends.window.test.ts`.

---

### Phase 17 — Creator Control Engine

- **Objective:** Give authors real control — edit windows, visibility change, deletion with full propagation, and
  data export — completing PRD §6.4 properly rather than as a local array splice.
- **Dependencies:** P1, P3, P5, P7, P11, P14.
- **Existing capability:** `data-delete-post` removes a post from local state and re-renders. Correct intent,
  no propagation.
- **Gaps:** Edit windows, visibility change after publish, cascading deletion across every projection, export.
- **Schema/data:** `deletion_requests` (id, actor_id, target_ref, target_id, state, propagation_status per
  surface, created_at, completed_at); `export_requests` (id, actor_id, state, artifact_key, created_at).
- **Domain model / state machine:** Deletion: `requested → propagating → completed | partially_failed`, where
  `partially_failed` is retried until complete and is never a resting state.
- **Commands / services:** `EditExperience` (within window), `ChangeVisibility`, `DeleteExperience`,
  `RequestDataExport`, `GetDeletionStatus`.
- **Domain events:** `ExperienceEdited`, `VisibilityChanged`, `ExperienceDeleted`, `DeletionPropagated`,
  `ExportReady`.
- **Async jobs:** `deletion.propagate` (feed, search, subjects, notifications, media, transcripts, replies),
  `export.build`.
- **UI surfaces:** Edit and delete controls on own content, a visibility switcher, and an export request in
  Settings alongside the existing "Clear Preview Account" control.
- **Authorization:** Only the author may edit, change visibility or delete. Visibility may be tightened
  (`public → alias → anonymous`) freely; **loosening is refused**, because retroactively de-anonymizing content
  the author posted anonymously is a privacy violation. Exports contain only the requester's own data.
- **Failure/retry/recovery:** Deletion is **not complete until every surface confirms**. Partial propagation
  retries indefinitely with backoff and alerts; media and transcript deletion is verified, not assumed.
- **Observability:** Deletion propagation latency per surface, partial-failure count, export duration.
- **Tests:** Deletion removes the experience from feed, search, subjects, notifications, replies, media and
  transcripts; edit window enforced; visibility loosening refused; export contains only own data; propagation
  idempotent and resumable after a mid-propagation crash.
- **E2E acceptance:** Deleting a voice experience with replies and reactions removes every trace from every read
  surface, verified by an exhaustive sweep, with media and transcript rows gone.
- **Certification evidence:** `creator.deletion.propagation.test.ts`, `creator.visibility.test.ts`,
  `creator.export.test.ts`.

---

### Phase 18 — Governance & Admin Engine

- **Objective:** Operator surfaces — moderation queue, audit trail, dead-letter inspection, role administration —
  with every privileged action audited.
- **Dependencies:** P3, P4, P9, P17.
- **Existing capability:** None.
- **Gaps:** Entire capability, including role management and immutable audit.
- **Schema/data:** Reuses `audit_events` and `dead_letters` (P4); adds `role_assignments` (actor_id, role
  `member|moderator|admin`, granted_by, granted_at, revoked_at) and `governance_notes`.
- **Domain model / state machine:** Role assignment: `granted → revoked`. Audit records are append-only.
- **Commands / services:** `GrantRole`, `RevokeRole`, `GetAuditTrail`, `GetDeadLetters`, `ReplayDeadLetter`,
  `GetQueueMetrics`.
- **Domain events:** `RoleGranted`, `RoleRevoked`, `DeadLetterReplayed`.
- **Async jobs:** `audit.retain`.
- **UI surfaces:** Admin console — moderation queue, audit search, dead-letter inspector with replay, role
  management. Separate from the consumer app surface.
- **Authorization:** `admin` only for roles and dead-letter replay; `moderator` for the queue. **Every** action
  writes an audit record including actor, before/after and correlation ID. Audit records are immutable —
  no update or delete path exists, and RLS enforces that.
- **Failure/retry/recovery:** Dead-letter replay is idempotent and safe to repeat. A failed replay re-lands in the
  dead-letter store with appended history rather than being lost.
- **Observability:** Privileged actions per role, audit write failures (alert-worthy), replay success rate.
- **Tests:** Non-admin denied on every admin command; audit written for every privileged action; audit rows are
  immutable; dead-letter replay is idempotent; role revocation takes effect on the next command.
- **E2E acceptance:** An admin grants a moderator role, the moderator actions a report, and both actions are
  present and immutable in the audit trail.
- **Certification evidence:** `governance.authz.test.ts`, `governance.audit.test.ts`,
  `governance.deadletter.replay.test.ts`.

---

### Phase 19 — Analytics & Observability Engine

- **Objective:** Instrument the PRD §9 success metrics and make the system operationally legible — structured
  logs, metrics, health, and an analytics sink that is privacy-safe by construction.
- **Dependencies:** P4, and read-only consumption of all prior phases.
- **Existing capability:** `console.log` in `tests-smoke.js` only.
- **Gaps:** Entire capability.
- **Schema/data:** `analytics_events` (id, event_name, actor_hash *(pseudonymous, not `actor_id`)*, properties,
  correlation_id, occurred_at); `metric_snapshots` (id, metric_name, window, value, computed_at).
- **Domain model / state machine:** Event: `recorded → aggregated`. Snapshots are immutable per window.
- **Commands / services:** `RecordAnalyticsEvent`, `GetMetric`, `GetHealth`; PRD §9 metrics —
  activation, week-2 retention, content health (removal ratio), virality (external shares), fairness
  participation rate.
- **Domain events:** Consumes essentially every domain event; emits `MetricComputed`.
- **Async jobs:** `analytics.ingest`, `metrics.rollup` (windowed).
- **UI surfaces:** Internal metrics dashboard in the admin console; `/health` for operations.
- **Authorization:** Admin-only. Analytics stores `actor_hash`, never `actor_id`, and never body text, transcript
  text, or media keys — the sink is structurally incapable of holding content.
- **Failure/retry/recovery:** Analytics ingestion failure **never** affects the user-facing command path
  (fire-and-forget with a bounded buffer). Rollup failure retries; the dashboard shows staleness explicitly
  rather than presenting stale numbers as current.
- **Observability:** This phase *is* the observability surface; it additionally self-reports ingestion lag and
  buffer saturation.
- **Tests:** Analytics failure does not fail the command; no content or `actor_id` in any analytics payload;
  metric rollups are deterministic; health reports per-dependency status; logs carry correlation IDs and no PII.
- **E2E acceptance:** A full golden-path run emits a correlated event trail, computes the PRD §9 metrics, and
  reports healthy status — with no PII anywhere in logs or analytics.
- **Certification evidence:** `analytics.privacy.test.ts`, `analytics.resilience.test.ts`,
  `observability.health.test.ts`, `observability.logging.test.ts`.

---

### Phase 20 — Certification & Operations Engine

- **Objective:** Prove the whole system, not its parts — one harness that runs every gate, produces the evidence
  ledger, and assigns the certification status. Plus the operational procedures that make it deployable.
- **Dependencies:** P1–P19.
- **Existing capability:** `tests-smoke.js` — 7 contract assertions plus the banned-term leak audit. Retained and
  absorbed as a certification gate rather than replaced.
- **Gaps:** Full-suite orchestration, evidence ledger generation, deployment/rollback/backup procedures.
- **Schema/data:** No production tables. Emits `docs/EVIDENCE.md` and a machine-readable certification report.
- **Domain model / state machine:** Certification run: `pending → running → certified | blocked | no_go`.
- **Commands / services:** `npm run certify` — runs every gate and writes the ledger.
- **Domain events:** `CertificationRunCompleted`.
- **Async jobs:** None (synchronous by design — a certification run must be reproducible).
- **UI surfaces:** None. Output is the evidence ledger and the PR record.
- **Authorization:** N/A (developer tooling).
- **Failure/retry/recovery:** Any red gate blocks the `READY` status. Gates that cannot run in this environment
  are recorded as **external blockers** with the specific reason, never silently skipped and never counted as
  passing.
- **Observability:** Per-gate pass/fail with counts and duration in the ledger.
- **Tests:** The harness itself is tested: a deliberately failing gate must produce a non-`READY` status.
- **E2E acceptance:** `npm run certify` runs green locally and emits a complete ledger with an honest status.
- **Certification evidence:** `docs/EVIDENCE.md`, plus `certification.harness.test.ts`.

**Required gates before `RAGERS_ENGINE_E2E_READY`:** schema/migrations, unit, integration, authorization,
retry/dead-letter, browser E2E, voice, moderation failure-path, privacy/search leakage, concurrency,
accessibility, build, deployment, backup/restore, and rollback.

**Certification status is exactly one of:**

| Status | Meaning |
|---|---|
| `RAGERS_ENGINE_E2E_READY` | Every gate above is green. |
| `RAGERS_ENGINE_E2E_READY_WITH_EXTERNAL_BLOCKERS` | All gates runnable in this environment are green; the remainder are blocked only by unprovisioned external dependencies, each named explicitly. |
| `RAGERS_ENGINE_E2E_NO_GO` | Any runnable gate is red, or a fail-closed privacy/safety invariant is unproven. |


---

## 5. Phases 21–30 — production hardening

Phases 1–20 establish the product. Phases 21–30 make it operable by more than
one process, in more than one environment, with providers that can fail. They
are delivered in three batches:

| Batch | Contents | Status |
|---|---|---|
| A | CI enforcement, live Postgres persistence, live RLS certification, backup/restore, **P21 Distributed Orchestration** | Delivered |
| B | Real provider adapters and failover, private object storage, **P22–P24** | Pending |
| C | Flags, experimentation, anti-abuse, governance, release control, continuous assurance, **P25–P30** | Pending |

---

### Phase 21 — Distributed Orchestration Engine

- **Objective:** Turn delivery from an in-process callback into a durable, leased
  job, so a process dying is a recoverable event rather than lost work.
- **Dependencies:** P4 (runtime), and durable persistence (Batch A).
- **Existing capability:** The P4 orchestrator delivered events per
  (event, consumer) with retry and dead-lettering, but entirely in memory: a
  restart lost the delivery ledger, and two processes would both run every job.
- **Gaps closed:** durable job state, leasing, worker identity and heartbeats,
  lease expiry and reclaim, concurrency limits, checkpoints, execution history,
  causation ids, and single-writer guarantees across workers.
- **Schema/data:** `workers` (id, hostname, started_at, last_heartbeat_at, state);
  `event_deliveries` extended with `state job_state`, `lease_owner`,
  `leased_until`, `checkpoint jsonb`, `causation_id`, plus a
  `lease_matches_state` constraint so a held job must name its holder;
  `job_history` (append-only); `outbox.causation_id`.
- **Domain model / state machine:**
  `queued → leased → running → (completed | failed | waiting)`,
  `failed → (retrying → queued | dead_letter)`, `waiting → queued`,
  and `leased → queued` when a lease expires without the worker acting.
  `completed` and `dead_letter` are terminal.
- **Commands / services:** `DeliveryLedger.claim` (the atomic lease),
  `reclaimExpired`, `countHeldBy`; `WorkerRegistry.register/heartbeat/reapStale/drain`;
  `Orchestrator.announce/drain/drainAll`.
- **Domain events:** none of its own; it emits metrics and history entries
  (`job.contended`, `job.reclaimed`) rather than domain events.
- **Async jobs:** the drain loop itself, plus lease reclamation and worker reaping
  on every pass.
- **UI surfaces:** worker and queue state feed the P18 admin console and the
  health endpoint; no consumer surface.
- **Authorization:** `workers` and `job_history` are worker-owned. RLS is enabled
  with admin-read policies only, and no client role holds insert/update/delete —
  the execution record cannot be rewritten by a client.
- **Failure/retry/recovery:** the lease *is* the recovery mechanism. A worker that
  dies mid-job leaves a lease that lapses; the next drain returns the job to
  `queued` with its attempt count and checkpoint intact, and another worker
  resumes it. Delivery is sticky: a late failure report from a contending worker
  cannot make an already-delivered event look pending again.
- **Observability:** per-job history with worker attribution, drain reports
  carrying `reclaimed` and `contended` counts, worker heartbeat state, and outbox
  depth on the health endpoint.
- **Tests:** job-state transition table; lease exclusivity; expiry and reclaim
  preserving attempt count and checkpoint; terminal jobs never re-claimed;
  checkpoint resumption; concurrency limit; poison-message isolation; two
  workers on one backlog.
- **E2E acceptance:** against a real Postgres, the voice pipeline survives an
  API restart, a worker restart, a duplicate command, a duplicate event, a
  provider timeout and a database error — producing exactly one experience, one
  media asset and one feed entry.
- **Certification evidence:** `jobs.orchestration.test.ts` (12) and
  `tests/live/orchestration.durability.test.ts` (11) green.

---

## 6. Phases 31–50 — the four-band roadmap

The roadmap now has four bands. Each answers a different question, and each is
only worth building once the one before it is true.

| Band | Phases | Question it answers |
|---|---|---|
| Experience Signal Engine | 1–20 | **What happened?** |
| Network & Intelligence | 21–30 | **Is it happening to others?** |
| Trust, Governance & Action | 31–40 | **How serious is it?** |
| Agentic Experience OS & Commercial Intelligence | 41–50 | **What changed because people surfaced it?** |

That last question is the one that makes Ragers more than a social network, and
it is also the one that cannot be faked: it is answerable only if resolution
outcomes are recorded by the people who experienced the problem, which is a
property of Phases 31–40 rather than of the agent layer above them.

### The boundary that governs the whole agent band

**The AI layer is not the source of truth.** The human experience is. The engine
structures, corroborates, measures, detects, assists and coordinates around it —
and every phase below inherits three rules from that:

1. **AI proposes; evidence and governed state decide.** Every recommendation must
   be traceable to platform evidence a person could inspect.
2. **No agent may modify a claim.** Not its text, not its severity, not its
   resolution state.
3. **Consequential external action requires governed approval.** An agent may
   prepare, summarise, route and track. It may not delete, dispute, or declare.

### Classification note

Phases 47–49 describe an organization-facing commercial product. Its vocabulary
— benchmarking, commercial intelligence, monetization, platform APIs — is
internal by `CLAUDE.md`'s rules and must never reach `index.html`, app copy,
onboarding, share cards, alt text, `data-*` attributes or public help content.
The features are legitimate; their language is not public language.

---

> **Phases 31–40 are specified in §6.2.** The band answers *how serious is it?*,
> and it is where the data Phases 41–50 read is actually produced: severity needs
> governed trust signals, prioritisation needs resolution aging, and benchmarking
> needs a sample floor that suppresses rather than estimates.

### 6.1 Sequencing reality

The bands are dependency-ordered, and the dependencies are real rather than
presentational:

- **41 Severity** reads structured experiences with confirmed entity, issue type
  and occurrence time. That is ESE Batch B, which is not built yet.
- **42 Impact** and **43 Prioritization** read resolution aging and unresolved
  exposure. That is ESE Batch C.
- **45 Agent Framework** extends the policy matrix and the leased-job runtime.
  Both exist; the agent boundaries do not.
- **47 Benchmarking** needs enough governed aggregate volume for a minimum-sample
  floor to be satisfiable at all. Below that volume the engine is correct and the
  output is empty.
- **50** certifies the whole chain, so it is last by construction.

Building 41–50 before ESE Batches B and C would mean severity over unstructured
text, prioritisation over resolution data that does not exist, and agents with no
governed state to be bounded by. The order of work therefore stays: **ESE Batch B
→ ESE Batch C → Phases 31–40 → Phases 41–50.**

---

## 6.2 Phases 31–40 — Trust, Governance & Action

The band's question is *how serious is it?* — and the answer must come from what
people asserted and what governed state records, never from how loudly something
was written. Three rules run through every phase here:

1. **Severity is asserted, not inferred.** A furious sentence about a small problem
   is not a severe experience, and a calm sentence about a dangerous one is not a
   mild one.
2. **A measure withheld beats a measure invented.** Below a minimum sample, the
   engine reports *not enough yet* and says how far off it is. It never estimates
   into the gap.
3. **An engine may measure, propose and route. It may not decide an outcome.**
   Escalation opens a review; it never applies a sanction. Handoff creates a
   proposal; it never mutates E1–E11 state.

### Phase 31 — Structured Experience Enrichment

- **Primary engine:** E1 Experience · **Supporting:** E2 Capture, E3 Declaration
- **Dependency:** normalization + confirmation (ESE Batch B), which is built.
- **Input:** a published experience, its confirmed metadata, and enrichment the
  experiencer asserts themselves — money lost, time lost, recurrence, whether
  service was interrupted, whether safety was involved.
- **Output/event:** `ExperienceEnriched`; `experience_enrichments` rows carrying
  each asserted dimension with its own provenance.
- **Persona impact:** the composer and the experience page gain asserted facts, each
  labelled as the experiencer's own account rather than a measurement.
- **Certification:** an enrichment field is only readable as asserted; nothing reads
  an unconfirmed extraction as an assertion, and a near-duplicate re-post of the
  same account is detectable by content fingerprint without being auto-suppressed.

### Phase 32 — Severity Classification

- **Primary engine:** E8 Signals · **Supporting:** E4 Trust, E12 Intelligence
- **Dependency:** Phase 31 enrichment. Severity over free text is refused.
- **Input:** asserted enrichment dimensions plus the count of independent
  experiencers.
- **Output/event:** `SeverityClassified`; a severity **band** (`minor`,
  `significant`, `serious`, `critical`) with an explicit confidence and the
  dimensions that produced it.
- **Persona impact:** severity renders as a named band with its basis on the
  experience and case surfaces — never as a number beside a person.
- **Certification:** two experiences with equal Re-Rage volume and radically
  different asserted impact are never treated as equivalent; and wording alone moves
  no band.

### Phase 33 — Resolution Lifecycle & Aging

- **Primary engine:** E10 Outcomes · **Supporting:** E9 Business Response
- **Dependency:** resolution reports and organization responses, both built.
- **Input:** the resolution event log and response timestamps.
- **Output/event:** `ResolutionAged`; derived durations — time unresolved, time
  since last organization contact, time since a proposed fix went unconfirmed.
- **Persona impact:** organization and operator case views show how long something
  has been waiting, in plain words rather than false precision.
- **Certification:** aging is derived from the event log on read and never stored as
  a truth that can drift; silence is aged as silence and never recorded as rejection.

### Phase 34 — Escalation Rules

- **Primary engine:** E10 Outcomes · **Supporting:** E8 Signals, E9 Business Response
- **Dependency:** Phases 32 and 33.
- **Input:** severity band, aging durations, dispute state.
- **Output/event:** `ExperienceEscalated`; a moderation queue item with the rule that
  fired and the values that satisfied it.
- **Persona impact:** the operator queue gains escalated items that say *why*, next
  to the rule that put them there.
- **Certification:** escalation opens a review and nothing else — it applies no
  sanction, hides nothing, changes no resolution state, and is idempotent so the same
  condition does not queue twice.

### Phase 35 — Organization Case Management

- **Primary engine:** E9 Business Response · **Supporting:** E8 Signals, E10 Outcomes
- **Dependency:** organization memberships and responses, both built.
- **Input:** experiences naming a claimed organization.
- **Output/event:** `CaseOpened`, `CaseAssigned`, `CaseStateChanged`;
  `organization_cases` rows with state and assignee.
- **Persona impact:** the existing organization inbox gains state and assignment, so
  staff can work a queue instead of a list.
- **Certification:** a case is the organization's own workspace and confers no
  authority over the experience — closing a case resolves nothing, and no case
  transition writes to `experiences`.

### Phase 36 — Responsiveness & Service Measures

- **Primary engine:** E11 Reputation · **Supporting:** E9, E10
- **Dependency:** Phases 33 and 35; the responsiveness reads are built.
- **Input:** acknowledgement, first-response and resolution durations, plus case
  throughput.
- **Output/event:** `ResponsivenessRecomputed`; snapshots with sample sizes.
- **Persona impact:** the organization performance panel reports medians, or says how
  far below the floor it is.
- **Certification:** nothing is called an SLA, no overdue indicator exists, and a
  median below the sample floor is withheld rather than shown small.

### Phase 37 — Resolution Evidence & Disputes

- **Primary engine:** E10 Outcomes · **Supporting:** E4 Trust, E9 Business Response
- **Dependency:** the E10 dispute object and the evidence ledger, both built.
- **Input:** evidence attached to a resolution report or to a dispute.
- **Output/event:** `ResolutionEvidenceAttached`; evidence rows parented to a report
  or a dispute.
- **Persona impact:** consumer resolution review shows what each side attached.
- **Certification:** evidence is never labelled *verified*; an organization cannot
  modify or remove consumer evidence; and attaching evidence changes no outcome by
  itself.

### Phase 38 — Minimum-Sample & Confidence Thresholds

- **Primary engine:** E4 Trust · **Supporting:** E7 Clustering, E8 Signals, E11
- **Dependency:** every measure defined above.
- **Input:** a measure, its sample size, and the floor for its kind.
- **Output/event:** none — one governed policy module every reader consults.
- **Persona impact:** every withheld measure says *why* it is withheld and how far
  off it is, in the same words everywhere.
- **Certification:** one floor policy, not per-surface constants; a measure below its
  floor is `withheld` in the payload rather than `0`, and no caller can render a
  withheld measure as a value.

### Phase 39 — Benchmark-Safe Aggregation

- **Primary engine:** E11 Reputation · **Supporting:** E7 Clustering, E8 Signals
- **Dependency:** Phase 38.
- **Input:** governed measures grouped by entity, category or issue type.
- **Output/event:** `AggregateComputed`; aggregates carrying their group size.
- **Persona impact:** comparative reads exist only where the group is large enough to
  be non-identifying.
- **Certification:** a small cell is suppressed, not rounded; an aggregate over a
  single contributor is refused; and no aggregate can be differenced against another
  to recover an individual.

### Phase 40 — Governed Intelligence Handoff

- **Primary engine:** E12 Intelligence · **Supporting:** E4, E8, E9, E10, E11
- **Dependency:** Phases 31–39.
- **Input:** governed state — severity bands, aging, escalations, aggregates.
- **Output/event:** `IntelligenceProposalCreated` via the existing E12 contract.
- **Persona impact:** the existing recommendation cards; no new surface.
- **Certification:** a handoff proposal writes to **no** E1–E11 table, carries
  evidence references a reviewer can open, and is refused at creation without them.
  Approving it dispatches the target engine's own command and can be refused there.

### 6.3 Why this order

31 produces the asserted facts 32 classifies. 33 produces the durations 34 escalates
on. 35 gives an organization somewhere to do the work 36 measures. 37 is what makes a
contested outcome inspectable. 38 is the floor 39 needs before any comparison is
safe, and 40 can only hand off state that the nine phases before it have made
governed. Reversing any pair produces a measure with nothing under it.

---

### 6.4 The 41–50 gate — dependencies verified against what exists

Phases 31–40 are certified (`PHASES_31_40_READY`), so this table is the gate for the
band above. Each row is what 41–50 actually needs, checked against the implementation
rather than against the roadmap's own promises.

| Phase | Needs | Status | True gap |
|---|---|---|---|
| 41 Severity | structured experiences with asserted dimensions and an explicit confidence | **mostly delivered by P32** — `classifySeverity` produces a band with its basis and confidence from asserted dimensions only, and cannot read text | **urgency classification.** Severity says how bad; urgency says how soon, and nothing derives it. Population affected already exists as an asserted dimension. |
| 42 Impact | asserted money, time, people; issue duration; unresolved exposure; minimum-sample safeguards | inputs **all exist** — P31 dimensions, P33 aging, P38 floors | **aggregating them into an estimate with an interval.** No confidence intervals anywhere, and an estimate without one is the thing P42's own design constraint forbids. |
| 43 Prioritization | severity, impact, aging, escalation | severity ✓ (P32), aging ✓ (P33), escalation ✓ (P34) | **impact (P42), and an ordering that is not a composite score.** The band's own rule — metrics stay named and separate — makes a single priority number the wrong shape; a defensible P43 is a *sort with a stated reason*, not a scalar. |
| 44 Copilot | governed proposals; a place to converse | proposals ✓ (E12) and a reviewer surface ✓ | **the whole surface.** Also needs a model provider, which is not configured. |
| 45 Agent framework | the policy matrix and the leased-job runtime | both ✓, certified | **agent boundaries.** Deliberately absent: the governed proposal is the floor, and nothing autonomous exists. |
| 46 Organization resolution agent | organization cases and responses | cases ✓ (P35), responses ✓ (E9) | **the agent.** Its forbidden actions are already structurally impossible — `case.engine.ts` has no write to `experiences` — which is what makes the agent safe to build later rather than dangerous. |
| 47 Benchmarking | benchmark-safe aggregation, and enough governed volume for a floor to be satisfiable | aggregation ✓ (P39), with a row floor, a person floor and a differencing guard | **the comparative reads**, and **volume**. Below the floor the engine is correct and the output is empty, so this is data-blocked rather than code-blocked. |
| 48 Commercial intelligence | 47 | — | entire. Vocabulary is internal-only per `CLAUDE.md`. |
| 49 Platform API | 47, 48 | — | entire. |
| 50 Certification | all of the above | the harness already reports three statuses and 47 gates | the band's own gates, once 41–49 exist. |

Three things this changes about the plan as originally written:

1. **Phase 41 is smaller than it looked.** P32 already delivers the severity engine's
   core, including the constraint that severity is asserted rather than inferred. What
   remains is urgency, which is a different question and should not be folded into the
   band.
2. **Phase 42 is the real blocker for 43.** Prioritisation reads impact, and impact is
   the only 41–43 input with nothing under it. Building 43 first would mean ordering by
   severity and calling it prioritisation.
3. **Phase 47 is data-blocked, not code-blocked.** The aggregation it needs is built and
   certified, including the differencing guard. It produces nothing until there are
   enough contributors, which is the correct behaviour and not a defect to fix.

Nothing in 41–50 requires rebuilding anything certified.

### Phase 41 — Experience Severity Engine

- **Objective:** Distinguish inconvenience from materially serious failure, so
  volume is not the only thing that speaks.
- **Dependencies:** ESE corroboration and normalization; P41 reads structured
  experiences, not free text.
- **Scope:** severity dimensions — financial impact, time lost, service
  interruption, safety relevance, recurrence, population affected — plus urgency
  classification and an explicit severity **confidence**.
- **Design constraint:** severity is asserted by experiencers and bounded by
  confidence, never inferred from wording alone. A furious sentence about a small
  problem is not a severe experience.
- **Certification:** two experiences with equal Re-Rage volume and radically
  different impact are not treated as equivalent anywhere — ranking, prioritisation,
  alerts or organization surfaces.

### Phase 42 — Impact Estimation Engine

- **Objective:** Estimate the practical impact of recurring failures.
- **Scope:** affected-user estimate, reported financial loss, reported time loss,
  operational disruption, unresolved exposure, issue duration, repeat frequency,
  confidence intervals, minimum-sample safeguards.
- **Design constraint:** every figure carries its interval and its sample size,
  and is labelled as reported-by-experiencers rather than measured.
- **Certification:** impact estimates remain explicitly modelled as estimates and
  never masquerade as audited financial facts — including in exports, alerts and
  executive summaries, which is where a number most easily loses its caveat.

### Phase 43 — Prioritization Engine

- **Objective:** Decide which clusters deserve attention first.
- **Scope:** scores over severity, signal strength, growth, recurrence,
  unresolved aging, affected users, evidence support, response absence,
  geographic concentration and confidence. Output `LOW | MEDIUM | HIGH | CRITICAL`.
- **Design constraint:** deterministic and explainable. Same inputs, same
  priority, with the contributing factors recorded alongside the output.
- **Certification:** priority changes deterministically when the underlying
  signals change, and the recorded rationale changes with it.

### Phase 44 — Ragers Copilot

- **Objective:** Contextual assistance for consumers, organizations and operators.
- **Scope:**
  - *Consumer:* structure a Rage/Rave, summarise voice input, find similar
    experiences, explain cluster history, surface resolution patterns.
  - *Organization:* summarise emerging issues, identify recurring friction, draft
    response options, suggest remediation tasks, summarise resolution progress.
  - *Operator:* summarise abuse patterns, surface anomalous clusters, prepare
    moderation context, explain signal changes.
- **Design constraint:** the consumer copilot may never silently replace what a
  person said — the same suggest-and-confirm rule the voice path already follows.
- **Certification:** every recommendation is traceable to underlying platform
  evidence, and a recommendation with no traceable basis is not shown.

### Phase 45 — Experience Agent Framework

- **Objective:** Governed agents that cannot autonomously modify claims.
- **Scope:** Intake, Classification, Matching, Trust, Trend, Resolution,
  Organization Response, Moderation and Intelligence agents. Each declares
  defined inputs, allowed tools and actions, an authorization boundary, a
  confidence threshold, an escalation path, audit history, and a retry and
  idempotency policy.
- **Dependencies:** the existing policy matrix and durable job runtime. An agent
  is a governed actor in the same authorization model, not a bypass around it.
- **Certification:** no agent can exceed its defined domain permissions —
  asserted by attempting the excess and being refused, not by reading the table.

### Phase 46 — Organization Resolution Agent

- **Objective:** Help organizations respond operationally to clusters.
- **Flow:** signal detected → issue summarised → recommended owner → remediation
  options generated → organization approves → action tracked → user-facing update
  prepared → resolution effectiveness measured.
- **Forbidden, structurally:** autonomous deletion, autonomous dispute of a user
  claim, autonomous declaration of resolution. These are the same three
  prohibitions the ESE already enforces against organizations; an agent acting
  for an organization inherits them and cannot be granted more.
- **Certification:** the agent prepares and coordinates remediation, and every
  consequential external action stops at a governed approval.

### Phase 47 — Experience Benchmarking Engine

- **Objective:** Let an organization understand its performance against
  comparable entities.
- **Scope:** category, geography and size-band benchmarks; response-rate,
  resolution-time, recurring-friction and positive-experience benchmarks; sample
  and confidence controls.
- **Design constraint:** benchmarks are built from governed aggregates with
  minimum-sample floors, so a small comparison set cannot be reverse-engineered
  into another organization's individual figures.
- **Certification:** no benchmark exposes another organization's private data,
  including by differencing successive reports.

### Phase 48 — Commercial Intelligence Layer

- **Objective:** A viable organization-facing product that does not corrupt
  consumer trust.
- **Scope:** experience dashboard, emerging-issue alerts, resolution analytics,
  benchmark reports, root-cause intelligence, location intelligence, export
  controls, team workflows, SLA tracking, executive summaries.
- **Non-negotiable:** payment never buys removal of legitimate Rage, ranking
  manipulation, suppression, artificial Rave promotion, or preferential
  moderation. This is not a policy statement to be trusted — the integrity layer
  must have no input for entitlement at all, so there is nothing to switch.
- **Certification:** paid and unpaid entity treatment is identical at the
  integrity layer, demonstrated by running the same content through both.

### Phase 49 — Platform API and Integration Layer

- **Objective:** Let Ragers intelligence reach the systems where work happens.
- **Scope:** governed integrations for CRM, customer support, incident
  management, BI, Slack/Teams, email, webhooks, data warehouse and internal
  ticketing. Example: `cluster.critical_signal_detected` → organization webhook →
  support incident created → owner assigned → Ragers resolution status
  synchronised.
- **Design constraint:** outbound delivery rides the existing durable job
  runtime. A webhook is a leased job with retries and a dead-letter queue, not a
  best-effort HTTP call.
- **Certification:** retries, request signing, authorization, tenant isolation,
  dead-letter handling and auditability all pass, and a hostile tenant cannot
  read another tenant's deliveries.

### Phase 50 — Experience OS Certification

- **Objective:** Certify the whole vertical slice.
- **Required E2E scenario, in a browser against a real database:**

  > Consumer submits voice Rage → Intake Agent transcribes → Classification Agent
  > structures it → Matching Agent finds an existing cluster → Trust Agent
  > evaluates the contribution → Re-Rages increase corroboration → Severity
  > Engine assesses impact → Trend Engine detects acceleration → Prioritization
  > Engine marks HIGH → organization workspace receives the alert → Resolution
  > Agent prepares remediation → organization approves → users receive an update
  > → users report mixed outcomes → Resolution Intelligence recalculates →
  > benchmark changes → entity scorecard changes → Copilot summarises the outcome
  > → webhook pushes the governed result to the organization's CRM → audit
  > history remains intact → replay does not duplicate effects.

- **Decision values:** `RAGERS_EXPERIENCE_OS_READY`,
  `RAGERS_EXPERIENCE_OS_READY_WITH_BLOCKERS`, or
  `RAGERS_EXPERIENCE_OS_NOT_READY`.
- **Standing rule:** "replay does not duplicate effects" is the hardest clause in
  that scenario and the one most likely to be quietly skipped. It is asserted by
  replaying the whole flow, not by inspecting idempotency keys.

---

## 7. Implementation order (Phases 1–20)

Phases are implemented as the **smallest dependency-complete slices**, continuously:

```
P4 runtime ─┬─ P1 experience ─┬─ P3 identity ─┬─ P2 voice ─┬─ P10 privacy ─┬─ P8 voice intel
            │                 │               │            │               │
            └─ P5 feed ───────┴─ P6 reaction ─┴─ P7 convo ──┴─ P9 safety ───┴─ P11 search
                                                                                  │
                          P12 subject ─ P13 graph ─ P14 notify ─ P15 reputation ─ P16 ranking
                                                                                  │
                                        P17 creator ─ P18 governance ─ P19 analytics ─ P20 certification
```

P4 and P1 land together (the runtime is untestable without an aggregate, and the aggregate is unpersistable
without the runtime). Everything after follows the graph above.

---

## 8. Phases 51–60 — the experience loop

**Prerequisite:** Ragers Foundation RC1 (`docs/releases/RAGERS_FOUNDATION_RC1.md`).
Phases 1–50 are frozen; nothing in this band rebuilds them.

### What this band is for

Phases 1–50 built a system that can hold one experience correctly from capture to
outcome. This band is about the **second** experience — what the system may
legitimately remember, connect and conclude once the same organization, the same
failure or the same person appears again.

That is exactly where a product like this goes wrong, so the band's constraints are
narrower than its ambitions:

- **A relationship is between experiences, not between people.** A generic social
  graph is not in scope and is not a stepping stone to anything here.
- **Memory is of an experience, not of a person.** Context that accumulates against
  a *person* is profiling, and it is absent by design rather than deferred.
- **History is not a ranking.** An organization's pattern history is a record of
  what happened, and a record does not become a league table because it is stored.
- **A signal is not permanent truth.** It emerges, stabilises and expires. Nothing
  in 1–50 lets a signal age, so a stale one currently reads exactly like a live one.
- **Decay is not deletion.** A signal's weight falls; the rows behind it stay
  auditable, because "this was true in March" is a fact and erasing it is a lie.
- **Reputation is not popularity, and not one opaque number.** No raw popularity
  score, and no single score at all unless every part of it is explainable.
- **Intelligence stays evidence-backed.** A conclusion drawn across experiences must
  point at the rows a reviewer can open, or it is not shown.
- **A recommendation is still a proposal, and a plan is still a proposal.** A plan's
  steps execute through the authoritative target engines, each facing every check a
  human would.

The non-negotiables from earlier bands hold unchanged, and this band adds nothing
that could route around them:

```
engagement != truth        cluster != signal        signal != fact
response != resolution     recommendation != decision   decision != effect
reputation != popularity   AI proposes; governed engines decide
E12 cannot directly mutate E1–E11        authorization is server-side
```

### 8.1 The 51–60 gate — dependencies verified against what exists

| Phase | Needs | Status in the frozen foundation | True gap |
|---|---|---|---|
| 51 Relationship graph | asserted relations between experiences, canonical pairs, cluster membership | **substantially delivered by E6/E7** — `experience_relations` canonicalises the pair, keys on `(pair, actor)`, carries `assertion` and `status`, and `trustWeightOfRelations` is structurally zero | **reading it as a graph.** There is no traversal, no equivalence between a relation and a shared cluster, and no guard against the same connection being counted twice by two routes. |
| 52 Rager context memory | an experience's own history: enrichment, resolution events, responses, disputes | inputs **all exist** and are already append-only | **a read that assembles them in order**, scoped to the experience. The risk is the shape, not the data: anything keyed on the *person* rather than the experience is out of scope. |
| 53 Organization pattern history | organization cases, responses, resolution events, responsiveness snapshots | all ✓ (P35, E9, E10, E11), and `sampleSize` already travels with every median | **the time dimension.** Responsiveness is a snapshot of now; nothing says whether it is better or worse than it was, and no floor policy currently governs a *trend*. |
| 54 Signal lifecycle | measured signals with windows | `signal_snapshots` ✓ with `windowSpan` and every named metric | **the states.** `emerging · active · stabilizing · resolved · expired` do not exist, so a signal has no way to stop being current. |
| 55 Decay & recovery | 54 | — | entire. Depends on lifecycle states existing first. |
| 56 Reputation evolution | contribution reads, responsiveness reads | ✓ (E11), and no popularity input reaches either | **the series.** Reputation answers "now" and nothing answers "changing how". |
| 57 Cross-experience intelligence | proposals with evidence refs, handoffs, clusters | ✓ (E12, P40), and a proposal with no traceable basis is already refused at creation | **reading across experiences.** Every current proposal is about one subject. |
| 58 Proactive recommendations | 57 | — | entire. Also needs deduplication: the same finding proposed twice is noise that trains reviewers to dismiss. |
| 59 Governed action plans | 58, and the dispatch path | dispatch ✓ — approval already runs the target engine's own command and records `dispatched` / `dispatchError` | **multi-step, and partial failure.** One step succeeding and the next being refused is the normal case, not the exception, and a plan that cannot express that would report success for work that did not happen. |
| 60 Loop certification | all of the above | the harness reports four statuses over 55 gates | the band's own gates, once 51–59 exist, for **both** the Rage and the Rave path. |

Three things this changes about the band as first sketched:

1. **Phase 51 is a read, not a schema.** The relation rows exist and are already
   canonical. Adding a second edge table would create two answers to "are these two
   connected" — which is the duplication its own failure test is meant to catch.
2. **Phase 54 blocks 55, 57 and 60.** Decay needs states to decay between; a
   cross-experience conclusion that cannot tell a live signal from a stale one is
   worse than no conclusion; and the loop cannot be certified while a signal has no
   end.
3. **Phase 59 is where this band can do real damage.** It is the first thing in the
   product that executes more than one governed action from one approval. Its whole
   design is about *not* becoming an autonomous actor: the plan proposes, each step
   dispatches, and a refused step stays refused and visible.

### Phase 51 — Experience Relationship Graph

- **Owner** E6 Community · **support** E1, E7
- **Objective:** read the connections between experiences that already exist —
  asserted relations, shared clusters, shared confirmed entity — as one graph.
- **Design constraint:** **not a social graph.** Nodes are experiences. There is no
  edge between people, and no path by which one could be derived.
- **Design constraint:** one connection is one edge. A pair connected both by an
  assertion and by shared cluster membership is *one* connection with two reasons,
  never two connections.
- **Design constraint:** an edge carries no trust weight. `trustWeightOfRelations`
  already returns zero and that stays true of the graph as a whole.
- **Failure test:** graph duplication — assert the same pair twice by two routes and
  assert the degree does not double.

### Phase 52 — Rager Context Memory

- **Owner** E1 Experience · **support** E6, E12
- **Objective:** assemble an experience's own history in order — what was asserted,
  what was confirmed, who responded, what was reported, what was disputed — as one
  read a reviewer or a copilot can consume.
- **Design constraint:** **no hidden profiling.** The memory is keyed on the
  experience. Nothing accumulates against a person, and there is no column in which
  an inference about a person could be stored.
- **Design constraint:** derived on read from rows that already exist. A second
  store of the same facts would be a second version of the truth.
- **Failure test:** attempt to read a memory keyed on an actor and assert there is no
  such read; assert the memory of a deleted experience is gone with it.

### Phase 53 — Organization Pattern History

- **Owner** E11 Reputation · **support** E8, E9, E10
- **Objective:** what has happened with this organization over time — volume,
  response, resolution, recurrence — as a series rather than a snapshot.
- **Design constraint:** **no unsupported ranking.** A history is not a position in
  a table. Nothing here orders organizations against each other; that is P47's
  question, and P47 is data-blocked for good reasons that apply here too.
- **Design constraint:** the P38 floors and the P39 differencing guard govern every
  point in the series, not just the latest one. A series is exactly how a suppressed
  cell gets recovered by subtraction.
- **Failure test:** a series whose points individually clear every floor but whose
  differences do not, and assert the difference is withheld.

### Phase 54 — Signal Lifecycle

- **Owner** E8 Signals
- **Objective:** give a signal states — `emerging · active · stabilizing · resolved ·
  expired` — so that being current is something a signal can stop being.
- **Design constraint:** **a signal is not permanent truth.** The state is derived
  from measured inputs and elapsed time, never asserted by a person, and never by an
  organization.
- **Design constraint:** `resolved` here means the *signal* is no longer live. It
  does not touch any experience's `resolution_status`, which only experiencers move.
- **Failure test:** stale signal decay — a signal with no new contribution for the
  window must leave `active`, and an expired signal must not present as current.

### Phase 55 — Signal Decay & Recovery

- **Owner** E8 Signals · needs 54
- **Objective:** weight recent contribution over old, and let a signal recover when
  a pattern returns.
- **Design constraint:** **the historical record remains auditable.** Decay changes
  the weight, never the rows. Every contribution that was ever counted is still
  readable, with its date.
- **Design constraint:** recovery is measured, not manual. There is no command that
  revives a signal.
- **Failure test:** replay the same contributions in a different order and assert the
  same weight; assert a decayed signal's underlying rows are all still present.

### Phase 56 — Reputation Evolution

- **Owner** E11 Reputation
- **Objective:** how a contributor's or an organization's standing is *changing*, not
  only where it stands.
- **Design constraint:** **no raw popularity score.** No shares, views or reactions
  reach it — the same rule that already governs every reputation read.
- **Design constraint:** **no single opaque score.** If a number is published, every
  component of it is named and separately readable. Otherwise the answer is the
  components.
- **Design constraint:** no public trust score beside a person's name. That absence
  is a decision recorded in `ENGINE_GAPS.md` and this band does not revisit it.
- **Failure test:** reputation replay — recompute from the event log and assert the
  same series, so evolution is derived rather than accumulated.

### Phase 57 — Cross-Experience Intelligence

- **Owner** E12 Intelligence
- **Objective:** conclusions that span more than one experience — this failure is
  recurring, these two clusters are the same thing, this response pattern changed.
- **Design constraint:** **must remain evidence-backed.** Every conclusion carries
  refs to the rows behind it. A conclusion whose basis cannot be opened is not shown,
  which is already how `proposal.create` behaves.
- **Design constraint:** reads lifecycle state (P54). A conclusion drawn over expired
  signals must say so or not be drawn.
- **Design constraint:** it concludes; it does not act. Output is a proposal.
- **Failure test:** insufficient evidence — assert a conclusion with no openable basis
  is refused at creation, not filtered at display.

### Phase 58 — Proactive Recommendations

- **Owner** E12 Intelligence · needs 57
- **Objective:** surface a recommendation before somebody asks for one.
- **Design constraint:** **recommendations remain proposals.** Proactive changes when
  it appears, not what it is or what it may do.
- **Design constraint:** deduplicated. The same finding recommended twice teaches
  reviewers to dismiss recommendations, which is worse than silence.
- **Design constraint:** no notification pressure. A recommendation is available; it
  does not chase.
- **Failure test:** recommendation duplication — run the generator twice over
  unchanged state and assert one proposal, not two.

### Phase 59 — Governed Action Plans

- **Owner** E12 Intelligence · needs 58
- **Objective:** a plan of more than one step, approved once, executed through the
  engines that own each step.
- **Design constraint:** **each step executes through the authoritative target
  engine**, dispatched on the bus, facing authorization and every domain check. A
  plan has no privileged path and no write of its own.
- **Design constraint:** partial failure is a first-class outcome. A plan records per
  step whether it dispatched and what refused it, exactly as a single proposal
  already does. A plan is never reported as complete because it was approved.
- **Design constraint:** approval is per plan, but authorization is per step and at
  execution time. An actor who could approve the plan and not perform step three
  gets step three refused.
- **Failure tests:** action-plan partial failure (step two refused, and the plan
  reports it); unauthorized action step (the step is refused, the plan does not
  escalate its own privileges); AI direct-mutation attempt (assert there is no path
  from a plan to an E1–E11 write that skips the bus).

### Phase 60 — Experience Loop Certification

- **Owner** E12 Intelligence · **all engines**
- **Objective:** certify the loop that this band creates: a second experience
  arriving, being connected, changing a signal, changing a history, producing a
  conclusion, producing a recommendation, producing a plan, and the plan executing
  through governed engines — with the loop closing without any of the distinctions
  collapsing.
- **Required scenario, run twice — once for a Rage and once for a Rave.** A band that
  only holds its rules for complaints has not held them.
- **Required failure tests, all of them:** graph duplication · stale signal decay ·
  reputation replay · recommendation duplication · action-plan partial failure ·
  unauthorized action step · AI direct-mutation attempt · insufficient evidence ·
  concurrency and idempotency across every new command.
- **Decision values:** `PHASES_51_60_READY`,
  `PHASES_51_60_READY_WITH_EXTERNAL_BLOCKERS`, or `PHASES_51_60_NOT_READY`.
- **Standing rule:** the loop must be provable with no live model provider. If a
  conclusion or a recommendation cannot be produced by the deterministic path, the
  band is not certifiable and no provider will make it so.

### 8.2 Order

```
51 graph ─┬─ 52 memory ─┬─ 54 lifecycle ─ 55 decay ─┬─ 57 cross-experience ─ 58 proactive ─ 59 plans ─ 60 certification
          └─ 53 history ─┘                          │
                                    56 evolution ───┘
```

**Batch A** — 51, 52, 53, 54, 55. Reads and lifecycle: everything that changes what
the system knows, and nothing that acts. Checkpoint commit.

**Batch B** — 56, 57, 58, 59, 60. Evolution, conclusions, recommendations, plans, and
the band's certification. One full certification run at the end, not per phase.

---

## 9. Phases 61–70 — operational integrity

**Prerequisite:** phases 1–60 certified, and the certification evidence hardening
that followed them.

### What this band is for

Phases 1–60 made the system *correct*: it holds its distinctions, it refuses what
it should refuse, and it can now say which subtest failed when a gate goes red.
None of that is the same as being *safe to operate*, and the difference is what
this band closes.

The theme is not a feature list. It is the set of things that must be true before
a deployment target is worth having — which is precisely what the six external
tracks are waiting on. Deploying a system that cannot rate-limit a single actor,
cannot moderate a reply, and audits four engines out of twelve would be shipping
the correctness of 1–60 into an environment that cannot hold it.

Four of the ten phases exist because something in the codebase *declares* a
capability nothing provides. Those are not speculative: each was found by reading
the code rather than by imagining what an operator might want, and each is named
with its evidence in the gate table below.

The band's own constraints:

- **A quota is not a moderation decision.** Being throttled is not being judged.
  A rate limit says *not so fast*, never *not allowed* and never *you are
  suspect* — and it must never reach a trust score, a severity band or a queue.
- **Detection is a signal for review, never an action.** Coordinated corroboration
  is a reason to look, and looking is a person's job. Nothing in this band
  removes, suppresses, downranks or discounts anything on its own.
- **Erasure means erased, including the derived.** A deletion that leaves a stored
  reference behind is not a deletion, and "it is only in an internal table" is the
  argument that makes it a breach later.
- **Retention is a ceiling, not a habit.** Originals and transcripts live for a
  stated period because they must, not until somebody remembers to prune them.
- **Degraded is a state the system knows it is in.** Failing closed is already the
  rule for media; this band makes it a *reported* state rather than a set of
  independent refusals nobody can see the shape of.
- **An audit trail with gaps is a narrative.** Either every governed action is
  attributable or the trail cannot be relied on for the one case it exists for.

Everything the earlier bands hold stays held. Nothing here gains a write path to
an E1–E11 table that a command does not already own, and no phase in this band may
introduce a score, a ranking or an automatic sanction.

### 9.1 The 61–70 gate — dependencies verified against what exists

| Phase | Needs | Status in the frozen foundation | True gap |
|---|---|---|---|
| 61 Request governance | an error kind, an HTTP mapping, a place to count | **the taxonomy already has it and nothing produces it.** `rate_limited` is in `ErrorKind`, is in `RETRYABLE`, and `lib/api.ts` maps it to 429 — and a grep across `src/`, `app/` and `lib/` finds no producer anywhere. A declared capability with no implementation, exactly like the `ReportResolved` dead subscription convergence found | **the counting, and the policy.** No table, column or in-memory window exists to count against; there is no throttle storage in any of the thirteen migrations |
| 62 Coordinated inauthenticity | corroborations with actors and timestamps, trust assessments, a review queue | all ✓ — and `uniqueExperiencers` already counts people rather than rows, which is the primitive this needs | **the detection, as a queue item.** Nothing looks at *how* a set of corroborations arrived. The floor policy protects against small samples, not against a coordinated large one |
| 63 Reply moderation | a reply aggregate, the moderation queue, an action command | replies ✓ (E6), queue ✓, command ✓ | **the action actually working.** `safety.applyModerationAction` resolves a reply target and then calls `loadExperience(targetId)`, so a reply can be reported and queued and never actioned. Recorded as ABSENT in `ENGINE_GAPS.md`; this is where it closes |
| 64 Erasure completeness | the deletion request, the terminal state, the consumers | deletion ✓ and **ten consumers already react to `ExperienceDeleted`** — feed, search, subject, signal, matching, conversation, analytics, responsiveness, creator | **the rows phases 51–60 added.** `recommendations.across_experience_ids` is a stored `text[]` of experience ids with no foreign key and no `ExperienceDeleted` consumer, so an operator surface keeps citing an experience its author deleted. The graph and the memory are derived on read and re-check status, so they self-heal; this one does not |
| 65 Retention | originals, transcripts, evidence, and their protected derivatives | the columns ✓, and `original_key` unreadable on every path ✓ | **any expiry at all.** Nothing states how long an original lives, and nothing removes one. Unreadable is not the same as absent |
| 66 Operator incident surfaces | dead letters, leases, worker heartbeats, job history | all ✓ as tables, with replay ✓ (P18) | **a surface.** An operator reads them with SQL today. The tables are the hard part and they exist; what is missing is the page and the reads behind it |
| 67 Degraded mode | fail-closed media ✓, retry ✓, dead-letter ✓, health ✓ | each dependency refuses correctly on its own | **the whole-system view.** There is no state that says *the system is degraded and here is what is refused*, so three independent correct refusals look like three unrelated bugs |
| 68 Audit completeness | an audit table, a writer, an actor context | `audit_events` ✓ with append-only enforcement ✓ | **coverage.** Four engines call `writeAudit` out of twelve. Whether the other eight *should* is the phase's actual question — an audit of everything is noise, and the answer has to be a stated rule rather than a sweep |
| 69 Tenant isolation | RLS on every table ✓ (77 of 77), a hostile-tenant test ✓ for deliveries | proven for the tables the earlier bands added | **the three tables phases 58–59 added**, and a sweep that is structural rather than a list — the same reasoning that replaced the Phase 48 filename list with discovery |
| 70 Certification | the harness, five statuses, per-gate evidence | ✓, and a failing gate now names its subtest | the band's own gates, once 61–69 exist |

Three things this changes about the band as first sketched:

1. **Phase 61 is closing a dead branch, not adding a feature.** `rate_limited`
   already exists in three places and is produced by nothing. That is the same
   defect shape as the dead `ReportResolved` subscription, and it means the
   surrounding contract — retryable, 429 — is already decided.
2. **Phase 64 has exactly one real target.** Ten consumers already handle
   `ExperienceDeleted` correctly and the 51–60 reads self-heal because they derive
   from published rows. The single stored reference is the recommendation ledger,
   which I added in 58 without a deletion consumer. Finding one target rather than
   a class is the useful outcome of the analysis.
3. **Phase 68's question is which actions deserve an audit, not how to write one.**
   Auditing all forty-seven commands would bury the four that matter. The phase
   delivers a stated rule and the coverage that follows from it.

### Phase 61 — Request Governance & Quotas

- **Owner** runtime, with E4 Trust in support
- **Objective:** produce `rate_limited` — per actor, per command, over a window —
  so the error kind, its retryability and its 429 stop being a contract nothing
  honours.
- **Design constraint:** **a quota is not a judgement.** No throttle event reaches
  a trust assessment, a severity band, a priority or a queue. Being fast is not
  being suspect.
- **Design constraint:** counted at the bus, ahead of the handler and after
  idempotency, so a replay is not charged twice for one intent.
- **Design constraint:** the limit is per *command class*, not global. A read is
  not a corroboration and a corroboration is not an upload.
- **Failure tests:** a burst is refused with `rate_limited` and nothing else; the
  refusal is retryable and writes no row; a replayed idempotency key is charged
  once; an actor at the limit for one command may still use another; nothing in the
  integrity layer can read a throttle count (the Phase 48 discovery guard, extended).

### Phase 62 — Coordinated Inauthenticity Resistance

- **Owner** E4 Trust · **support** E6 Community
- **Objective:** notice when a set of corroborations arrived in a way that does not
  look like people independently recognising their own experience.
- **Design constraint:** **detection opens a review and nothing else.** It writes a
  queue item. It does not remove, suppress, downrank, discount or annotate a claim,
  and there is no column in which it could.
- **Design constraint:** it never adjusts a count. `uniqueExperiencers` keeps
  counting people; a suspicion is not a subtraction.
- **Design constraint:** internal vocabulary only. Nothing about this reaches a
  public surface, per `CLAUDE.md`.
- **Failure tests:** a coordinated set opens exactly one queue item; the
  corroboration count is unchanged; a genuine burst of independent corroborations
  after a news event is not flagged (the false-positive case, asserted); the
  detection is idempotent under a repeated sweep.

### Phase 63 — Reply Moderation

- **Owner** E4 Trust · acts on an E6 object
- **Objective:** make a reported reply actionable. Today the report is written, the
  queue item is created, and the action cannot resolve its target.
- **Design constraint:** a reply is moderated as a reply. Its terminal states are
  the reply's own; nothing here touches the parent experience.
- **Design constraint:** the same reason-required, enum-checked boundary the
  experience path now has — this is not a second, looser moderation path.
- **Failure tests:** a reported reply can be removed and restored; the parent
  experience is untouched; a queue item for a reply that no longer exists is
  refused rather than left unclearable; an action with no reason is refused.

### Phase 64 — Erasure Completeness

- **Owner** E1 Experience · **support** E4, E12
- **Objective:** a deletion removes every stored reference, including the ones
  phases 51–60 added.
- **Design constraint:** **derived reads must not be papered over.** The graph and
  the memory already self-heal by re-checking status; the fix belongs where a row
  is *stored*, not in a filter added to each reader.
- **Design constraint:** the audit trail of the deletion survives the deletion.
  Erasing the record that an erasure happened is not erasure, it is amnesia.
- **Failure tests:** a deleted experience appears in no recommendation, no graph,
  no memory and no history point; the deletion's own audit event remains; a
  recommendation whose every experience is deleted is itself gone rather than empty;
  replaying the deletion event is idempotent.

### Phase 65 — Retention & Data Minimisation

- **Owner** E2 Capture · **support** E4
- **Objective:** state how long an original, a transcript and an evidence artefact
  live, and remove them when that expires.
- **Design constraint:** **a stated ceiling, per class of artefact**, not one
  global sweep. An original and its protected derivative are not the same risk and
  do not get the same clock.
- **Design constraint:** expiry removes the artefact, never the fact. The
  experience, the corroboration and the counts stay; what goes is the bytes.
- **Design constraint:** blocked honestly where object storage is. The policy and
  the ledger of what *would* be removed are certifiable now; the deletion of remote
  bytes is not, and must report `OBJECT_STORAGE_BLOCKED` rather than pretend.
- **Failure tests:** an expired original is unreadable and its row says why; the
  experience survives its original's expiry; a protected derivative outlives the
  original it came from; nothing expires while a dispute or a moderation review is
  open on it.

### Phase 66 — Operator Incident Surfaces

- **Owner** E4 Trust · **support** the shared spine (P21)
- **Objective:** the reads and the page an operator needs during an incident — dead
  letters, stuck leases, worker health, job history — instead of SQL.
- **Design constraint:** reads and existing commands only. Replay already exists
  and is governed; this surfaces it rather than adding a second path.
- **Design constraint:** no new privilege. Everything here is already reachable by
  a moderator or an admin through the policy matrix, or it does not appear.
- **Failure tests:** a consumer is offered no operator surface and is refused when
  navigating there anyway (the existing persona pattern); a dead letter can be
  replayed exactly once from the surface; the page shows nothing a member may not see.

### Phase 67 — Degraded Mode & Backpressure

- **Owner** the shared spine (P21)
- **Objective:** one reported state saying which dependencies are unavailable and
  what is consequently refused.
- **Design constraint:** **derived from health, never asserted.** No command sets
  degraded mode. It is what the health registry already knows, read in one place.
- **Design constraint:** it changes no refusal. Every fail-closed path already
  refuses correctly; this makes the *shape* visible so three correct refusals stop
  looking like three bugs.
- **Failure tests:** with the database unavailable the state says so and the
  refusals are unchanged; recovery clears it without a command; the state is
  readable by an operator and by nobody else.

### Phase 68 — Audit Completeness

- **Owner** E4 Trust · **all engines**
- **Objective:** a stated rule for which actions are audited, and the coverage that
  follows.
- **Design constraint:** **a rule, not a sweep.** Auditing all forty-seven commands
  would bury the ones that matter. The rule this phase must defend: an action is
  audited when it is taken *by one person about another*, or when it changes what
  somebody else may do.
- **Design constraint:** enforced by discovery, like the Phase 48 entitlement
  guard, so a command added later is covered without anybody remembering.
- **Failure tests:** every command matching the rule writes an audit event; a
  command that does not match writes none; a new command matching the rule and
  missing its audit fails the guard; the trail stays append-only.

### Phase 69 — Tenant Isolation Sweep

- **Owner** E9 Business Response
- **Objective:** extend the hostile-tenant certification to every table, including
  `recommendations`, `action_plans` and `action_plan_steps`.
- **Design constraint:** structural, not a list. The sweep enumerates tables from
  the schema and holds each to a stated rule, so a table added later is covered.
- **Failure tests:** a hostile tenant reads none of another's rows on any table; a
  table added without RLS fails the sweep; an operator-only table is unreachable by
  an organization member.

### Phase 70 — Operational Integrity Certification

- **Owner** E4 Trust · **all engines**
- **Objective:** certify that the system is safe to operate, as distinct from
  correct.
- **Required scenario, run twice — once for a Rage and once for a Rave.** A burst
  is throttled without being judged; a coordinated set opens a review without
  changing a count; a reported reply is actioned; an author deletes and nothing
  anywhere still names it; an artefact expires and the account survives; a
  dependency drops and the degraded state says what is refused; every governed
  action in the lap is attributable.
- **Required failure tests, all of them:** throttle-is-not-judgement ·
  detection-is-not-action · false-positive coordination · reply action on a missing
  target · erasure leaves no stored reference · audit-rule coverage by discovery ·
  hostile tenant across every table · degraded mode changes no refusal ·
  concurrency and idempotency across every new command.
- **Decision values:** `PHASES_61_70_READY`,
  `PHASES_61_70_READY_WITH_EXTERNAL_BLOCKERS`, or `PHASES_61_70_NOT_READY`.
- **Standing rule:** retention's remote-byte deletion is expected to report
  `OBJECT_STORAGE_BLOCKED`. That is the honest value, and a `READY` that quietly
  skipped it would be the first time this ledger claimed something it had not done.

### 9.2 Order

```
61 quotas ─┬─ 62 coordination ─┬─ 66 operator surfaces ─┐
           ├─ 63 reply moderation ─┤                    ├─ 70 certification
           ├─ 64 erasure ──────────┼─ 68 audit rule ────┤
           └─ 65 retention ────────┴─ 67 degraded ──────┘
                                     69 tenant sweep ───┘
```

**Batch A** — 61, 62, 63, 64. The four that close a declared-but-absent capability
or a real hole: quotas, coordination review, reply moderation, erasure. Checkpoint
commit.

**Batch B** — 65, 66, 67, 68, 69, 70. Retention, the operator surfaces, degraded
mode, the audit rule, the tenant sweep, and the band's certification. One full
certification run at the end.
