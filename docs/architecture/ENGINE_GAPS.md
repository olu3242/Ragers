# Ragers — engine gaps

**Classification:** Internal. A gap is only marked closed with implementation *and*
evidence.

## Closed in this slice

| Gap | Engine | Implementation | Evidence |
|---|---|---|---|
| Formal dispute | E10 | `src/domain/dispute.ts`, `src/engines/dispute.engine.ts`, `experience_disputes` | `dispute.relate.proposal` (10) · `contracts.engine` (6) · `persona.authorization` · `contracts.live` (2) |
| Relate | E6 | `src/domain/relation.ts`, `src/engines/relation.engine.ts`, `experience_relations` | `dispute.relate.proposal` (5) · `contracts.engine` (3) · `contracts.live` (1) |
| Responsiveness read | E11 | `src/engines/responsiveness.engine.ts`, `responsiveness_snapshots` | `contracts.engine` (2) · `contracts.live` (1) |
| Reputation read | E11 | `contributionViewOf` in `src/engines/reputation.engine.ts` | `contracts.engine` (1) |
| Governed proposal lifecycle | E12 | `src/domain/proposal.ts`, `src/engines/proposal.engine.ts`, `intelligence_proposals` | `dispute.relate.proposal` (7) · `contracts.engine` (5) · `persona.authorization` (1) |
| Governed recommendation surface | E12 | `components/RecommendationCard.tsx`, `lib/proposals.ts`, `app/operate/proposals/page.tsx` | `proposal.review` (10) · `accessibility.surfaces` (1) · `personas` browser (2) |
| Structured enrichment (P31) | E1 | `src/domain/enrichment.ts`, `src/engines/enrichment.engine.ts`, `experience_enrichments` | `severity.escalation` (8) · `governance.action` (7) · `governance.action.live` (2) |
| Content fingerprint / near-duplicate detection | E3, E7 | `fingerprintOf` in `src/domain/enrichment.ts` — ported from PR #6, confirmed-structure only, non-unique index | `severity.escalation` (4) · `governance.action` (2) · `governance.action.live` (1) |
| Severity classification (P32) | E8 | `src/domain/severity.ts`, `src/engines/severity.engine.ts`, `experience_severities` | `severity.escalation` (7) · `governance.action` (3) · `governance-action` browser (2) |
| Resolution aging (P33) | E10 | `src/domain/aging.ts`, derived on read | `severity.escalation` (4) |
| Escalation (P34) | E10 | `src/domain/escalation.ts`, `src/engines/escalation.engine.ts`, `experience_escalations` | `severity.escalation` (6) · `governance.action` (3) · `governance.action.live` (2) |
| Organization case management (P35) | E9 | `src/domain/case.ts`, `src/engines/case.engine.ts`, `organization_cases` | `severity.escalation` (5) · `governance.action` (2) · `governance.action.live` (2) |
| Minimum-sample floors (P38) | E4 | `src/domain/sampling.ts` — one policy, consulted by every reader | `sampling.aggregation` (7) |
| Benchmark-safe aggregation (P39) | E11 | `src/domain/aggregation.ts` — row floor, person floor, differencing guard | `sampling.aggregation` (10) |
| Resolution & dispute evidence (P37) | E10 | fourth evidence parent, `resolution_report_id` | `governance.action` (2) · `governance.action.live` (1) |
| Governed intelligence handoff (P40) | E12 | `src/engines/handoff.engine.ts`, `intelligence_handoffs` | `sampling.aggregation` (1) · `governance.action` (4) · `governance.action.live` (1) |
| Urgency (P41) | E8 | `src/domain/urgency.ts` — the only gap P32 left | `urgency.impact.priority` (8) · `governance.action` (1) · `governance-action` browser (1) |
| Impact estimation (P42) | E8 | `src/domain/impact.ts`, derived on read across a pattern | `urgency.impact.priority` (9) · `governance.action` (3) |
| Explainable prioritisation (P43) | E8 | `src/domain/priority.ts`, `src/engines/priority.engine.ts`, `experience_priorities` | `urgency.impact.priority` (11) · `governance.action` (2) · `governance.action.live` (2) · browser (1) |
| Agent framework (P45) | E12 | `src/domain/agent.ts`, `src/engines/agent.engine.ts`, `agent_runs` | `agent.benchmark` (9) · `governance.action` (5) · `governance.action.live` (2) |
| Copilot provider boundary (P44) | E12 | `AssistanceProvider` port, `createDeterministicAssistanceProvider` | `agent.benchmark` (5) · `governance.action` (2) |
| Organization resolution agent (P46) | E9/E12 | the `organization_response` declaration | `agent.benchmark` (3) · `governance.action` (1) |
| Benchmarking (P47) | E11 | `src/engines/benchmark.engine.ts` over the certified P39 aggregation | `agent.benchmark` (1) · `governance.action` (1) — **CODE_READY_DATA_BLOCKED** |
| Entitlement boundary (P48) | — | `src/domain/entitlement.ts`, `organization_entitlements` | `entitlement.integration` (5) · `governance.action` (1) |
| Platform integrations (P49) | E12/E9 | `src/domain/integration.ts`, `src/engines/integration.engine.ts`, `integration_subscriptions`, `integration_deliveries` | `entitlement.integration` (7) · `governance.action` (4) |
| Experience OS certification (P50) | — | 5 band gates + the fourth status | `certification.harness` (2) · replay proved by re-draining |
| Entitlement guard by discovery | — | `INTEGRITY_SCAN_ROOTS` + `COMMERCIAL_SURFACES` in `src/domain/entitlement.ts` | `entitlement.integration` (4) — all three failure modes verified by introducing each |
| Dead subscription: `ReportResolved` | E4/E9 | emitted per resolved report in `safety.engine.ts` | `convergence.circular` · enumeration now reports zero dead subscriptions |
| 1–50 convergence | — | `docs/architecture/CONVERGENCE_1_50.md`, `tests/integration/convergence.circular.test.ts` | `convergence.circular` (3) — one lap for Rage and one for Rave |
| Experience relationship graph (P51) | E6 | `src/domain/relationship.ts`, `src/engines/relationship.engine.ts` — a read over `experience_relations` and `cluster_members`, no new table | `relationship.memory.history` (7) · `experience.loop` (3) · `experience.loop.live` (1) |
| Rager context memory (P52) | E1 | `src/domain/memory.ts`, `src/engines/memory.engine.ts` — derived on read, no actor id and no free text | `relationship.memory.history` (6) · `experience.loop` (2) |
| Organization pattern history (P53) | E11 | `src/domain/history.ts`, `src/engines/history.engine.ts` — the P38 floors and a differencing guard over *time* | `relationship.memory.history` (8) · `experience.loop` (2) |
| Signal lifecycle (P54) | E8 | `src/domain/signal-lifecycle.ts` — five states, derived, no command sets one | `lifecycle.decay` (11) · `experience.loop` (2) · `loop.certification` (2) |
| Signal decay & recovery (P55) | E8 | `src/domain/decay.ts`, `src/engines/lifecycle.engine.ts` — 90-day half-life, order-independent, no row changed | `lifecycle.decay` (9) · `experience.loop` (1) |
| Reputation evolution (P56) | E11 | `src/domain/evolution.ts`, `src/engines/evolution.engine.ts` — a series per named component, no composite | `evolution.conclusion.plan` (7) · `loop.intelligence` (2) |
| Cross-experience intelligence (P57) | E12 | `src/domain/conclusion.ts`, `src/engines/conclusion.engine.ts` — evidence-backed, refuses an expired signal | `evolution.conclusion.plan` (8) · `loop.intelligence` (2) |
| Proactive recommendations (P58) | E12 | the `recommendations` ledger, keyed on the conclusion | `loop.intelligence` (3) · `experience.loop.live` (1) |
| Governed action plans (P59) | E12 | `src/domain/plan.ts`, `src/engines/plan.engine.ts`, `action_plans`, `action_plan_steps` | `evolution.conclusion.plan` (10) · `loop.intelligence` (7) · `experience.loop.live` (2) |
| Experience loop certification (P60) | — | 5 band gates + the fifth status | `loop.certification` (3) — one lap for Rage and one for Rave |
| Public read of a removed experience through `relatedTo` | E6 | status re-checked on read in `relation.engine.ts` and `relationship.engine.ts` | `experience.loop` (1) — asserted by removing one and re-reading |
| Command boundary refusals | all | shape guard in `src/runtime/bus.ts`; `checkNote` in `src/domain/types.ts`; per-field guards in the seven modules that lacked them | `command.boundaries` (11) · `command.boundaries.live` (6) — nine defects, each verified red before the fix |

## Open

| Gap | Engine | Status | Note |
|---|---|---|---|
| Real transcription provider | E2 | BLOCKED | Needs credentials. Port and fail-closed behaviour certified against a fake. |
| Real PII provider | E2, E4 | BLOCKED | Same. The entity-alias exemption for person-name detection is in place. |
| Private object storage | E2 | BLOCKED | Needs a bucket and credentials. |
| Deployment target | — | BLOCKED | Deployment and rollback certification gates remain blocked on it. |
| Independent-signal tiers | E8 | ABSENT | Considered; would be a presentation tier over `uniqueExperiencers`, never a composite score. PR #6's thresholds survive as reference in `ENGINE_RUNTIME_CONFLICT.md`; the branch itself is closed. |
| Autonomous agents | E12 | ABSENT by choice | The framework exists (P45) and agents may read, propose and escalate. `AgentAction` has no write verb, so autonomy in the sense of *acting* is not expressible; nothing here is a gap to close. |
| Real model provider | E12 | BLOCKED | Needs credentials. The port and the deterministic fallback are certified; live-provider behaviour is not, and `live: false` is what says so. |
| Benchmark sample volume | E11 | DATA-BLOCKED | The code is certified. Twenty distinct contributors per comparison set do not exist in any environment the harness runs in, which is the engine being correct rather than failing. |
| Cross-organization comparison | E11 | DATA-BLOCKED | P53 gives one organization its own history over time, deliberately. Ranking organizations against each other is P47's question and stays where it is. |
| Rate limits on request-shaped commands | E17/E12 | ABSENT | Surfaced by the boundary sweep rather than caused by it: `creator.requestExport` accepted 21 successive requests, since nothing dedupes or throttles one. Not an input-validation defect — the input was valid every time — so it is recorded here rather than fixed under a boundary slice. `export_requests` has no partial unique index, so memory and Postgres agree. |
| Reply moderation | E4 | ABSENT | `safety.applyModerationAction` on a reply target loads an *experience* and so can never act. The boundary fix stops a report against a nonexistent reply being written and queued; actioning a real reply remains unimplemented, and is a feature rather than a gap in the refusal contract. |
| SLA thresholds | E11 | ABSENT by choice | No service-level agreement exists. Responsiveness is measured; nothing is called an SLA and no overdue indicator is shown, because there is nothing to be overdue against. |

## Deliberate non-gaps

Things that look missing and are absent on purpose:

- **Public trust score.** A number beside a person's name turns every contribution
  into a referendum on the contributor, and falls hardest on new and anonymous
  accounts. Trust exists internally, for moderators.
- **A composite signal score.** Metrics stay named and separate; one number is how a
  system starts optimising for the loudest thing rather than the most serious one.
- **`verified` as an evidence outcome.** No artefact establishes that events happened
  as described, and labelling some experiences verified brands the rest as doubted.
- **`been_there`.** Retired: it meant "this happened to me too", which is a Re-Rage.
  Migrated by `0006`.
- **Consumer "dispute" as a resolution report kind.** Rejecting a fix and disputing
  an account are different acts, so a dispute is its own object rather than a fourth
  report value.
