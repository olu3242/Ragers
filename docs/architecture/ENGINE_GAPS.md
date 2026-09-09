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

## Open

| Gap | Engine | Status | Note |
|---|---|---|---|
| Real transcription provider | E2 | BLOCKED | Needs credentials. Port and fail-closed behaviour certified against a fake. |
| Real PII provider | E2, E4 | BLOCKED | Same. The entity-alias exemption for person-name detection is in place. |
| Private object storage | E2 | BLOCKED | Needs a bucket and credentials. |
| Deployment target | — | BLOCKED | Deployment and rollback certification gates remain blocked on it. |
| Independent-signal tiers | E8 | ABSENT | Considered; would be a presentation tier over `uniqueExperiencers`, never a composite score. PR #6's thresholds remain the calibration data point. |
| Autonomous agents | E12 | ABSENT | Deliberately not built. The proposal contract is the governed floor. |
| Impact estimation and prioritisation | (E8 extensions) | ABSENT | Roadmap phases 42–43. The 31–40 band they depend on is now specified and certified (`PHASES_31_40_READY`); Phase 41 extends P32's band with urgency and population affected. |
| Benchmarking, commercial intelligence, platform APIs | (E8/E9 extensions) | ABSENT | Roadmap phases 47–49. Vocabulary is internal-only per `CLAUDE.md`. |
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
