import { getEngine } from '../../../lib/engine-instance.ts';
import { correlationIdFrom, idempotencyKeyFrom, jsonError, jsonOk, readJson, respond } from '../../../lib/api.ts';
import { unauthorizedError } from '../../../src/runtime/errors.ts';
import { hasAtLeast } from '../../../src/runtime/authz.ts';
import { currentActor } from '../../../lib/session.ts';
import { openProposals } from '../../../src/engines/proposal.engine.ts';

/**
 * Open intelligence proposals.
 *
 * Internal: a proposal describes what a machine suggested about somebody, which is
 * not a public matter. The read is guarded here because it dispatches no command;
 * it uses the same role predicate the matrix uses for `proposal.read`.
 */
export const GET = async (): Promise<Response> => {
  const actor = await currentActor();
  if (!hasAtLeast(actor.role, 'moderator')) {
    return jsonError(unauthorizedError('policy_role', 'that surface is for moderators'));
  }
  const proposals = await openProposals(getEngine());
  return jsonOk({
    proposals: proposals.map((row) => ({
      proposalId: row.id,
      proposalType: row.proposalType,
      sourceEngine: row.sourceEngine,
      targetEngine: row.targetEngine,
      subjectId: row.subjectId,
      summary: row.summary,
      rationale: row.rationale,
      confidence: row.confidence,
      evidenceRefs: row.evidenceRefs,
      status: row.status,
      // Stated so a reviewer approves a specific action rather than a sentiment.
      proposedCommand: row.proposedCommand,
      createdAt: row.createdAt,
    })),
  });
};

export const POST = async (request: Request): Promise<Response> => {
  const body = await readJson(request);
  const result = await getEngine().bus.dispatch({
    name: 'proposal.create',
    input: body,
    actor: await currentActor(),
    idempotencyKey: idempotencyKeyFrom(request),
    correlationId: correlationIdFrom(request),
  });
  return respond(result, 201);
};
