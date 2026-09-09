import { err, ok } from '../runtime/result.ts';
import { notFoundError, preconditionError, validationError } from '../runtime/errors.ts';
import { eq } from '../ports/store.ts';
import type { CommandHandler } from '../runtime/bus.ts';
import type { EvidenceAssessment, EvidenceRow } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';
import { experienceResource } from './support.ts';

/**
 * Evidence Engine — evidence strengthens a signal; it never becomes a verdict.
 *
 * Two rules, both about not overclaiming.
 *
 * **Nothing is labelled "verified".** An assessment says `consistent`,
 * `inconclusive` or `contradicted` — what a reviewer could actually determine
 * from an artefact. "Verified" would assert that the underlying events happened
 * as described, which no photograph or receipt can establish, and attaching that
 * word to some experiences would implicitly brand the rest as unverified.
 *
 * **Evidence is optional.** Requiring it would silence exactly the people least
 * able to produce it, so an experience with no evidence is complete. Evidence
 * raises `evidenceSupportedCount`; it never gates publication.
 *
 * Originals are as sensitive as original media: `original_key` is withheld from
 * every client role by column grant, and `evidence.read_original` is denied to
 * every role including admin.
 */

export const EVIDENCE_KINDS: readonly string[] = ['photo', 'document', 'receipt', 'screenshot', 'recording'];
export const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;

export interface AttachEvidenceInput {
  readonly experienceId?: string;
  readonly corroborationId?: string;
  readonly kind: string;
  readonly originalKey: string;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly contentDigest?: string;
}

export interface AttachEvidenceResult {
  readonly evidenceId: string;
  /** Queued, not protected: protection runs as a job and can fail closed. */
  readonly protectionStatus: 'queued';
  /** True when an identical artefact was already attached to this claim. */
  readonly duplicate: boolean;
}

export const registerEvidenceEngine = (deps: EngineDeps): void => {
  const attach: CommandHandler<AttachEvidenceInput, AttachEvidenceResult> = {
    name: 'evidence.attach',
    action: 'evidence.attach',
    resolveResource: async (input) => {
      // Evidence hangs off exactly one parent, and authorization follows that
      // parent's owner — a corroborator owns their corroboration's evidence.
      if (input.corroborationId) {
        const claim = await deps.store.corroborations.get(input.corroborationId);
        if (!claim) return err(notFoundError('corroboration_not_found', 'no such corroboration'));
        return ok({ type: 'corroboration', id: claim.id, ownerActorId: claim.corroboratorId });
      }
      return experienceResource(deps.store, input.experienceId ?? '');
    },
    handle: async (input, ctx) => {
      const hasExperience = typeof input.experienceId === 'string' && input.experienceId.length > 0;
      const hasCorroboration = typeof input.corroborationId === 'string' && input.corroborationId.length > 0;
      if (hasExperience === hasCorroboration) {
        return err(
          validationError('evidence_needs_one_parent', 'evidence belongs to an experience or a corroboration, not both'),
        );
      }
      if (!EVIDENCE_KINDS.includes(input.kind)) {
        return err(validationError('invalid_evidence_kind', 'that is not a supported evidence kind'));
      }
      if (!Number.isInteger(input.byteSize) || input.byteSize <= 0) {
        return err(validationError('invalid_byte_size', 'evidence must have a positive size'));
      }
      if (input.byteSize > MAX_EVIDENCE_BYTES) {
        return err(validationError('evidence_too_large', 'that file is too large'));
      }
      if (typeof input.originalKey !== 'string' || input.originalKey.length === 0) {
        return err(validationError('missing_original_key', 'evidence must reference stored bytes'));
      }

      // The same artefact attached twice to the same claim is one piece of
      // evidence, not two — otherwise a support count is inflatable by re-upload.
      const existing = input.contentDigest
        ? await deps.store.evidence.queryOne([
            eq<EvidenceRow>('contentDigest', input.contentDigest),
            ...(hasExperience
              ? [eq<EvidenceRow>('experienceId', input.experienceId ?? '')]
              : [eq<EvidenceRow>('corroborationId', input.corroborationId ?? '')]),
          ])
        : undefined;
      if (existing) {
        return ok({
          value: { evidenceId: existing.id, protectionStatus: 'queued' as const, duplicate: true },
          events: [],
        });
      }

      const row: EvidenceRow = {
        id: deps.ids.next('evd'),
        ...(hasExperience ? { experienceId: input.experienceId as string } : {}),
        ...(hasCorroboration ? { corroborationId: input.corroborationId as string } : {}),
        submittedBy: ctx.actor.actorId,
        kind: input.kind,
        originalKey: input.originalKey,
        // Fails closed: nothing reads evidence until protection has run.
        protectionStatus: 'queued',
        byteSize: input.byteSize,
        mimeType: input.mimeType,
        ...(input.contentDigest === undefined ? {} : { contentDigest: input.contentDigest }),
        createdAt: ctx.clock.now(),
      };
      await deps.store.evidence.put(row);

      // Unassessed is the honest initial state, and it is recorded rather than
      // left absent so nothing has to guess what a missing assessment means.
      await deps.store.evidenceAssessments.put({
        id: `${row.id}:initial`,
        evidenceId: row.id,
        outcome: 'unassessed',
        createdAt: ctx.clock.now(),
      });

      return ok({
        value: { evidenceId: row.id, protectionStatus: 'queued' as const, duplicate: false },
        events: [
          {
            aggregateType: 'experience',
            aggregateId: input.experienceId ?? input.corroborationId ?? row.id,
            eventName: 'EvidenceAttached',
            payload: {
              evidenceId: row.id,
              ...(hasExperience ? { experienceId: input.experienceId } : {}),
              ...(hasCorroboration ? { corroborationId: input.corroborationId } : {}),
              kind: row.kind,
            },
          },
        ],
      });
    },
  };

  const assess: CommandHandler<
    { evidenceId: string; outcome: string; notes?: string },
    { assessmentId: string; outcome: string }
  > = {
    name: 'evidence.assess',
    action: 'evidence.assess',
    resolveResource: async (input) => {
      const row = await deps.store.evidence.get(input.evidenceId);
      if (!row) return err(notFoundError('evidence_not_found', 'no such evidence'));
      return ok({ type: 'evidence', id: row.id, ownerActorId: row.submittedBy });
    },
    handle: async (input, ctx) => {
      const row = await deps.store.evidence.get(input.evidenceId);
      if (!row) return err(notFoundError('evidence_not_found', 'no such evidence'));

      const outcomes: readonly EvidenceAssessment['outcome'][] = [
        'unassessed',
        'consistent',
        'inconclusive',
        'contradicted',
      ];
      if (!outcomes.includes(input.outcome as EvidenceAssessment['outcome'])) {
        return err(
          validationError('invalid_assessment_outcome', 'an assessment is consistent, inconclusive or contradicted', {
            // Named in the error so a caller reaching for it learns why not.
            rejected: input.outcome,
            reason: 'nothing is labelled verified: an artefact cannot establish that events happened as described',
          }),
        );
      }

      // Assessment reads the protected derivative. Reviewing an unprotected
      // artefact would mean a reviewer seeing identifying detail the pipeline
      // exists to remove.
      if (row.protectionStatus !== 'protected') {
        return err(
          preconditionError('evidence_not_protected', 'evidence cannot be assessed before it is protected', {
            protectionStatus: row.protectionStatus,
          }),
        );
      }

      const assessment: EvidenceAssessment = {
        id: deps.ids.next('eva'),
        evidenceId: row.id,
        outcome: input.outcome as EvidenceAssessment['outcome'],
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        assessedBy: ctx.actor.actorId,
        createdAt: ctx.clock.now(),
      };
      await deps.store.evidenceAssessments.put(assessment);

      return ok({
        value: { assessmentId: assessment.id, outcome: assessment.outcome },
        events: [
          {
            aggregateType: 'experience',
            aggregateId: row.experienceId ?? row.corroborationId ?? row.id,
            eventName: 'EvidenceAssessed',
            payload: {
              evidenceId: row.id,
              outcome: assessment.outcome,
              ...(row.experienceId === undefined ? {} : { experienceId: row.experienceId }),
            },
          },
        ],
      });
    },
  };

  deps.bus.register(attach);
  deps.bus.register(assess);
};

/**
 * The public description of evidence on a claim.
 *
 * Says how much evidence there is and the most recent assessment — never a
 * "verified" badge, and never the artefact itself.
 */
export interface EvidenceSummary {
  readonly count: number;
  readonly protectedCount: number;
  readonly latestOutcome: EvidenceAssessment['outcome'];
}

export const evidenceSummaryFor = async (
  deps: EngineDeps,
  experienceId: string,
): Promise<EvidenceSummary> => {
  const rows = await deps.store.evidence.query([eq<EvidenceRow>('experienceId', experienceId)]);
  let latestOutcome: EvidenceAssessment['outcome'] = 'unassessed';
  let latestAt = -1;
  for (const row of rows) {
    for (const assessment of await deps.store.evidenceAssessments.query([eq('evidenceId', row.id)])) {
      if (assessment.createdAt > latestAt) {
        latestAt = assessment.createdAt;
        latestOutcome = assessment.outcome;
      }
    }
  }
  return {
    count: rows.length,
    protectedCount: rows.filter((row) => row.protectionStatus === 'protected').length,
    latestOutcome,
  };
};
