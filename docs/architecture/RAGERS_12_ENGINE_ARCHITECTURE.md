# Ragers — 12-engine architecture

**Classification:** Internal. Never linked from a public surface (`CLAUDE.md`).
**Authoritative runtime:** the TypeScript engine in `engine/`. See
`ENGINE_RUNTIME_CONFLICT.md`.

Engines are **permanent ownership**. Phases are **delivery**. A phase ships and is
done; an engine owns its contract for as long as the product exists.

The Experience Signal Engine is **not a thirteenth engine**. Its functionality is
owned by E3, E4, E7, E8, E9 and E10, mapped below.

---

## E1 Experience

- **Module** `src/domain/experience.ts`, `src/engines/experience.engine.ts`
- **Commands** `experience.create` · `experience.update` · `experience.publish` · `experience.hide`
- **Queries** `loadExperience`, feed projection
- **Events** `ExperienceDrafted` `ExperienceValidated` `ExperiencePublished` `ExperienceHidden` `ExperienceDeleted` `ContentRemoved` `ContentRestored`
- **States** `draft → validating → pending_media|pending_moderation → published → under_review|hidden|removed|deleted`
- **Permissions** create/update/publish member+own · hide/remove moderator · read guest
- **Persistence** `experiences` (+ ESE structure columns: `title`, `entity_id`, `category_id`, `issue_type_id`, `location_id`, `occurred_at`, `resolution_status`, `cluster_id`)
- **Tests** `experience.aggregate` · `experience.statemachine`
- **Status** IMPLEMENTED

## E2 Capture

- **Module** `src/domain/voice.ts`, `src/engines/voice.engine.ts`, `components/Composer.tsx`, `components/VoiceRecorder.tsx`
- **Commands** `voice.requestUploadTarget` · `voice.attach` · `voice.grantPlayback`
- **Queries** upload target, playback grant
- **Events** `ExperienceMediaReady` `ExperienceMediaFailed` `TranscriptReady` `TranscriptRedacted`
- **States** media `queued → processing → protected|failed|dead_letter`
- **Permissions** member+own · `media.read_original` denied to every role including admin
- **Persistence** `media_assets` `upload_targets` `transcripts`
- **Tests** `voice.recorder` · `voice.validation` · `voice.goldenpath`
- **Status** IMPLEMENTED. Real transcription/PII providers are BLOCKED on credentials; ports and fail-closed behaviour are certified against fakes.

## E3 Declaration

- **Module** `src/domain/normalization.ts`, `src/engines/normalization.engine.ts`
- **Commands** `normalization.confirm`
- **Queries** `pendingSuggestions` · `confirmedMetadata`
- **Events** `ExperienceNormalizationConfirmed`
- **States** per field: proposed (in `extracted`) → confirmed (in `confirmed`). **Unconfirmed is `unknown`, never the proposed value.**
- **Permissions** `experience.confirm_metadata` member+own
- **Persistence** `experience_metadata` (`extracted` / `confirmed` jsonb, separate columns), taxonomy: `categories` `issue_types` `entities` `entity_aliases` `locations`
- **Tests** `normalization.trust` · `intelligence.chain`
- **Status** IMPLEMENTED

## E4 Trust

- **Module** `src/domain/trust.ts`, `src/engines/trust.engine.ts`, `src/engines/safety.engine.ts`, `src/engines/evidence.engine.ts`
- **Commands** `safety.fileReport` · `safety.claimQueueItem` · `safety.applyModerationAction` · `evidence.attach` · `evidence.assess`
- **Queries** `internalTrustFor` · `riskEventsFor` · `evidenceSummaryFor` (moderator-only for the first two)
- **Events** `ReportFiled` `ContentScreened` `RiskDetected` `EvidenceAttached` `EvidenceAssessed`
- **States** evidence assessment `unassessed | consistent | inconclusive | contradicted` — **never `verified`**
- **Permissions** moderator for queue/action/assess · `evidence.read_original` denied to all · `trust.read_internal` moderator
- **Persistence** `trust_assessments` `risk_events` `moderation_queue` `moderation_actions` `screenings` `evidence` `evidence_assessments`
- **Tests** `normalization.trust` · `privacy.failclosed` · `intelligence.chain`
- **Status** IMPLEMENTED. No public trust score exists, by design.

## E5 Publishing

- **Module** `src/engines/safety.engine.ts` (screening consumer), `src/engines/feed.engine.ts`
- **Commands** none directly — publication is a consumer outcome
- **Queries** feed projection, ranked feed
- **Events** `ContentScreened` `ExperiencePublished`
- **States** screening `clear | needs_review`; fails closed — an unscreened experience stays unpublished
- **Permissions** read guest
- **Persistence** `feed_entries` (structurally no `actor_id` column)
- **Tests** `privacy.failclosed` · `search.leakage`
- **Status** IMPLEMENTED

## E6 Community

- **Module** `src/domain/corroboration.ts`, `src/domain/relation.ts`, `src/engines/corroboration.engine.ts`, `src/engines/relation.engine.ts`, `src/engines/reaction.engine.ts`, `src/engines/conversation.engine.ts`
- **Commands** `corroboration.create` · `corroboration.retract` · `share.create` · **`relation.assert`** · **`relation.retract`** · `reaction.toggle` · `reaction.castFairVote` · `reply.create`
- **Queries** `corroborationsFor` · `relatedTo`
- **Events** `ExperienceReRaged` `ExperienceReRaved` `CorroborationRetracted` `ExperienceShared` **`ExperienceRelated`** **`ExperienceUnrelated`** `ReactionAdded` `ReactionRemoved` `FairVoteCast` `ReplyPublished`
- **States** corroboration/relation `active | retracted | removed`
- **Permissions** corroborate member+**ownership forbidden** · share guest · relate member · retract own
- **Persistence** `experience_corroborations` (unique per experience+corroborator) · **`experience_relations`** (unique per canonical pair+asserter) · `experience_shares` (no unique) · `reactions` `fair_votes` `replies`
- **Tests** `corroboration.contract` · `corroboration.engine` · `dispute.relate.proposal` · `contracts.engine` · `contracts.live`
- **Status** IMPLEMENTED

## E7 Clustering

- **Module** `src/domain/matching.ts`, `src/engines/matching.engine.ts`
- **Commands** none — clustering is a consumer
- **Queries** `clusterWithMembers`
- **Events** `ClusterMembershipChanged`
- **States** relationship `same_experience | similar_experience | related_experience | no_match`
- **Permissions** `cluster.read` guest
- **Persistence** `experience_clusters` `experience_cluster_members`
- **Tests** `matching.signal` · `intelligence.chain`
- **Status** IMPLEMENTED. Reads **confirmed** metadata only; deterministic gates decide before any score.

## E8 Signals

- **Module** `src/domain/signal.ts`, `src/engines/signal.engine.ts`
- **Commands** none — a consumer
- **Queries** `publicSignalFor`
- **Events** consumes cluster/corroboration/resolution events
- **States** none; snapshots are keyed by (subject, window) and overwritten
- **Permissions** `signal.read` guest · `signal.read_internal` moderator
- **Persistence** `signal_snapshots`
- **Tests** `matching.signal` · `intelligence.chain`
- **Status** IMPLEMENTED. Named metrics only — no composite score anywhere.

## E9 Business Response

- **Module** `src/engines/organization.engine.ts`
- **Commands** `organization.respond` · `organization.claim`
- **Queries** `organizationFor` · `publicResponsesFor` · case inbox
- **Events** `OrganizationResponded` `OrganizationClaimRequested`
- **States** profile `unclaimed | pending | claimed | suspended`; response kinds `acknowledge respond request_information publish_resolution service_update dispute known_incident remediation_instructions`
- **Permissions** `organization.respond` member + **claimed** membership. No write path to `experiences` exists at all.
- **Persistence** `organization_profiles` `organization_memberships` `organization_responses`
- **Tests** `resolution.organization` · `persona.authorization`
- **Status** IMPLEMENTED

## E10 Outcomes

- **Module** `src/domain/resolution.ts`, `src/domain/dispute.ts`, `src/domain/outcome-presentation.ts`, `src/engines/resolution.engine.ts`, `src/engines/dispute.engine.ts`
- **Commands** `resolution.report` · **`dispute.open`** · **`dispute.withdraw`** · **`dispute.review`**
- **Queries** `resolutionSummaryFor` · `disputesFor` · `presentOutcome`
- **Events** `ResolutionReported` `ResolutionStatusChanged` **`DisputeOpened`** **`DisputeWithdrawn`** **`DisputeReviewed`**
- **States** resolution `open gaining_signal acknowledged under_review resolved partially_resolved disputed reopened`; **dispute `open under_review upheld declined withdrawn`** — a separate axis
- **Permissions** report: author or active corroborator only · dispute: standing resolved by the engine · **review: moderator only, and never the raiser**
- **Persistence** `resolution_reports` `resolution_events` **`experience_disputes`** (partial unique index on live disputes)
- **Tests** `matching.signal` · `resolution.organization` · `dispute.relate.proposal` · `contracts.engine` · `persona.authorization` · `contracts.live`
- **Status** IMPLEMENTED

## E11 Reputation

- **Module** `src/engines/reputation.engine.ts`, `src/engines/responsiveness.engine.ts`
- **Commands** none — both are derived
- **Queries** **`contributionViewOf`** (person) · **`publicResponsivenessFor`** (organization) · `publicReputationOf` · `aliasReputationOf`
- **Events** **`ResponsivenessUpdated`** (emitted only when a viewer-visible figure moves)
- **States** standing (internal); no public state
- **Permissions** `responsiveness.read` guest · `reputation.read_internal` moderator
- **Persistence** `actor_reputation` **`responsiveness_snapshots`**
- **Tests** `contracts.engine` · `contracts.live`
- **Status** IMPLEMENTED. No composite score; sample floors explicit; nothing from the trust layer surfaces.

## E12 Intelligence

- **Module** `src/domain/proposal.ts`, `src/engines/proposal.engine.ts`
- **Commands** `proposal.create` · `proposal.decide` (approve/reject/escalate) · `proposal.expire`
- **Queries** `openProposals`
- **Events** `IntelligenceProposalCreated` `IntelligenceProposalApproved` `IntelligenceProposalRejected` `IntelligenceProposalEscalated` `IntelligenceProposalExpired`
- **States** `proposed → approved | rejected | escalated | expired`; escalated is **not** a decision and can still be decided
- **Permissions** moderator for create, decide and read. No member path.
- **Persistence** `intelligence_proposals`
- **Tests** `dispute.relate.proposal` · `contracts.engine` · `persona.authorization`
- **Status** IMPLEMENTED (minimum contract). No autonomous agents exist.

### The E12 boundary

Approving a proposal **does not write to any E1–E11 table**. It dispatches the
target engine's own command through the same bus, policy matrix and outbox, so an
approved action faces every check a human would. Consequently an approval can
fail, and `dispatchedAt` / `dispatchError` record which — an approval the governed
engine refused is visibly distinct from one that took effect.

Proved by test: a proposal to grant its own reviewer `admin` is approved as a
*decision* and refused as an *action*, and the reviewer stays a moderator.

---

## Invariants that hold across all twelve

| | |
|---|---|
| engagement ≠ truth | shares and reactions reach no claim count |
| cluster ≠ signal | membership is a key match; signal is measured |
| signal ≠ verified fact | metrics are named and never composited |
| response ≠ resolution | only experiencers resolve; `publish_resolution` is a proposal |
| rejection ≠ dispute | rejection is `still_unresolved`; dispute is its own object |
| reputation ≠ popularity | no shares, views or reactions in any reputation read |
| AI proposal ≠ authoritative action | approval dispatches; the target engine decides |
