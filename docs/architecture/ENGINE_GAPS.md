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
