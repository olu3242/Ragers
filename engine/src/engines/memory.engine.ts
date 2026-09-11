import { eq } from '../ports/store.ts';
import {
  assembleMemory,
  type ExperienceMemory,
  type MemoryEntry,
} from '../domain/memory.ts';
import type {
  CorroborationRow,
  DisputeRow,
  EscalationRow,
  EvidenceRow,
  OrganizationResponse,
  ResolutionEventRow,
  ResolutionReportRow,
} from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { enrichmentFor } from './enrichment.engine.ts';

/**
 * Rager Context Memory — E1, with E6 and E12 in support. Phase 52.
 *
 * Derived on read, like aging. Every source below is already append-only and already
 * certified, so the memory always agrees with itself and there is no row to go stale.
 *
 * Every entry is mapped deliberately, field by field, rather than by spreading a row:
 * a spread is how an actor id or a body reaches a memory later, when somebody adds a
 * column to a table nobody was thinking about. The mapping is the guard, and
 * `FORBIDDEN_MEMORY_KEYS` is the test that holds it.
 *
 * Not included, on purpose:
 *
 * - **The organization's case.** That is E9's own workspace with its own vocabulary,
 *   and pulling its state into an experience read would publish internal handling.
 * - **Severity, urgency, priority.** They are measures of the experience now, not
 *   things that happened to it. `severityFor` and `priorityFor` answer those.
 * - **Cluster signals.** They belong to the cluster, not to any one experience.
 */
export const memoryFor = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<ExperienceMemory | undefined> => {
  const experience = await deps.store.experiences.get(experienceId);
  if (!experience) return undefined;

  const entries: MemoryEntry[] = [];

  if (experience.publishedAt !== undefined) {
    entries.push({
      at: experience.publishedAt,
      kind: 'published',
      by: 'experiencer',
      detail: {
        kind: experience.kind,
        creationMode: experience.creationMode,
        // The visibility *mode*, never the alias behind it.
        visibility: experience.visibility,
      },
    });
  }

  // Structure, only once confirmed. An extracted suggestion is not something that
  // happened — it is something proposed and possibly rejected.
  if (experience.entityId !== undefined || experience.issueTypeId !== undefined) {
    entries.push({
      at: experience.updatedAt,
      kind: 'structure_confirmed',
      by: 'experiencer',
      detail: {
        hasEntity: experience.entityId !== undefined,
        hasIssueType: experience.issueTypeId !== undefined,
        hasLocation: experience.locationId !== undefined,
      },
    });
  }

  const enrichment = await enrichmentFor(deps, experienceId);
  for (const value of enrichment?.values ?? []) {
    entries.push({
      at: value.assertedAt,
      kind: 'cost_asserted',
      by: value.provenance === 'experiencer' ? 'experiencer' : 'system',
      detail: {
        dimension: value.dimension,
        provenance: value.provenance,
        // Whether a figure exists, not the figure: a memory is a history, and the
        // current asserted amounts are `enrichmentFor`'s answer.
        stated: value.amount !== undefined || value.flag !== undefined,
      },
    });
  }

  const corroborations = await deps.store.corroborations.query([
    eq<CorroborationRow>('experienceId', experienceId),
  ]);
  for (const row of corroborations) {
    entries.push({
      at: row.createdAt,
      kind: 'corroborated',
      by: 'corroborator',
      detail: { type: row.type, relationship: row.relationship, hasContext: row.narrative !== undefined },
    });
    if (row.retractedAt !== undefined) {
      entries.push({
        at: row.retractedAt,
        kind: 'corroboration_retracted',
        by: 'corroborator',
        detail: { type: row.type },
      });
    }
  }

  for (const row of await deps.store.evidence.query([eq<EvidenceRow>('experienceId', experienceId)])) {
    entries.push({
      at: row.createdAt,
      kind: 'evidence_attached',
      by: 'experiencer',
      // Never the key, never the digest: the original is unreadable on every path
      // and that includes this one.
      detail: { evidenceKind: row.kind, protection: row.protectionStatus },
    });
  }

  for (const row of await deps.store.organizationResponses.query([
    eq<OrganizationResponse>('experienceId', experienceId),
  ])) {
    entries.push({
      at: row.createdAt,
      kind: 'organization_responded',
      by: 'organization',
      // The kind of response, never its text — and `isPublic`, because whether an
      // organization said it in public is itself a fact about what happened.
      detail: { responseKind: row.kind, isPublic: row.isPublic },
    });
  }

  // What people said, and separately what the engine derived from it. A report is an
  // act; a status change is a consequence, and conflating them would make one person
  // reporting look like the outcome having moved.
  for (const row of await deps.store.resolutionReports.query([
    eq<ResolutionReportRow>('experienceId', experienceId),
  ])) {
    entries.push({
      at: row.reportedAt,
      kind: 'outcome_reported',
      by: 'experiencer',
      detail: { reportKind: row.kind, hasNote: row.note !== undefined },
    });
  }

  for (const row of await deps.store.resolutionEvents.query([
    eq<ResolutionEventRow>('experienceId', experienceId),
  ])) {
    entries.push({
      at: row.createdAt,
      kind: 'outcome_changed',
      by:
        row.source === 'organization'
          ? 'organization'
          : row.source === 'moderator'
            ? 'operator'
            : row.source === 'engine'
              ? 'system'
              : 'experiencer',
      detail: {
        toStatus: row.toStatus,
        source: row.source,
        ...(row.fromStatus === undefined ? {} : { fromStatus: row.fromStatus }),
      },
    });
  }

  for (const row of await deps.store.disputes.query([eq<DisputeRow>('experienceId', experienceId)])) {
    entries.push({
      at: row.createdAt,
      kind: 'disputed',
      by: row.origin === 'organization' ? 'organization' : 'experiencer',
      detail: { reason: row.reason, origin: row.origin },
    });
    if (row.reviewedAt !== undefined) {
      entries.push({
        at: row.reviewedAt,
        kind: 'dispute_reviewed',
        by: 'operator',
        detail: { outcome: row.status },
      });
    }
  }

  for (const row of await deps.store.escalations.query([eq<EscalationRow>('experienceId', experienceId)])) {
    entries.push({
      at: row.createdAt,
      kind: 'escalated',
      by: 'system',
      // The rule, not the sentence it produced: `because` is prose assembled for a
      // human queue and a memory does not carry prose.
      detail: { rule: row.ruleId, open: row.resolvedAt === undefined },
    });
  }

  // Distinct people who made a claim about this: the author, plus active
  // corroborators. A count, and there is no read here that returns the list.
  const contributors = new Set<string>([experience.actorId]);
  for (const row of corroborations) {
    if (row.status === 'active') contributors.add(row.corroboratorId);
  }

  return assembleMemory(experienceId, entries, contributors.size);
};
