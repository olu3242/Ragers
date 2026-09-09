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

## Open

| Gap | Engine | Status | Note |
|---|---|---|---|
| Real transcription provider | E2 | BLOCKED | Needs credentials. Port and fail-closed behaviour certified against a fake. |
| Real PII provider | E2, E4 | BLOCKED | Same. The entity-alias exemption for person-name detection is in place. |
| Private object storage | E2 | BLOCKED | Needs a bucket and credentials. |
| Deployment target | — | BLOCKED | Deployment and rollback certification gates remain blocked on it. |
| Content fingerprint / near-duplicate detection | E3, E7 | ABSENT | PR #6's `fingerprint()` is the migration candidate — see `ENGINE_RUNTIME_CONFLICT.md`. |
| Independent-signal tiers | E8 | ABSENT | Considered; would be a presentation tier over `uniqueExperiencers`, never a composite score. |
| Autonomous agents | E12 | ABSENT | Deliberately not built. The proposal contract is the governed floor. |
| Severity, impact, prioritisation | (E4/E8 extensions) | ABSENT | Roadmap phases 41–43. Depend on the 31–40 band, which is unspecified. |
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
