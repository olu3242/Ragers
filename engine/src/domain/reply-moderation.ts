import { err, ok, type Result } from '../runtime/result.ts';
import { preconditionError, type EngineError } from '../runtime/errors.ts';
import type { Reply } from '../ports/store.ts';
import type { ModerationActionKind } from './types.ts';

/**
 * Phase 63 — reply moderation.
 *
 * Closing a gap that has been recorded as ABSENT since the command-boundary sweep
 * found it: `safety.applyModerationAction` resolves a reply target and then calls
 * `loadExperience(targetId)`, so a reply could be reported, queued, and never actioned.
 * The queue item was unclearable, which is worse than a missing feature — it is a work
 * list that accumulates items nobody can finish.
 *
 * **A reply is moderated as a reply.** Its own terminal states, its own transition
 * table, and no path from here to the parent experience. Removing a reply must not
 * touch the account it hangs off, and the reverse cascade already exists and belongs to
 * the experience: `createReplyCascadeConsumer` takes replies down with their parent.
 *
 * The state names are the ones the reply row already has, so this adds a transition
 * table rather than a vocabulary.
 */

/** Which reply states a moderator may move between. Anything absent here is refused. */
const TRANSITIONS: Readonly<Record<string, readonly Reply['status'][]>> = {
  published: ['hidden', 'removed'],
  hidden: ['published', 'removed'],
  removed: ['published'],
  // A reply the author deleted is theirs, and stays deleted. A moderator restoring
  // somebody's deleted words would be publishing something they withdrew.
  deleted: [],
  draft: [],
  pending_media: [],
  pending_moderation: ['published', 'removed'],
};

export const canModerateReply = (from: Reply['status'], to: Reply['status']): boolean =>
  (TRANSITIONS[from] ?? []).includes(to);

/** What each moderation action means for a reply. `warn` and `no_action` move nothing. */
export const replyOutcomeOf = (action: ModerationActionKind): Reply['status'] | undefined => {
  switch (action) {
    case 'remove':
      return 'removed';
    case 'restore':
      return 'published';
    default:
      // A warning is a message to a person, not a change to their words.
      return undefined;
  }
};

export interface ModeratedReply {
  readonly reply: Reply;
  /** True when the action actually moved the reply. False for warn and no_action. */
  readonly moved: boolean;
}

/**
 * Apply a moderation action to a reply.
 *
 * Returns the reply unchanged for an action that does not move it, rather than
 * refusing: warning somebody about a reply is a legitimate action that leaves the
 * reply where it is, and turning that into an error would make the moderator's own
 * queue lie about what they did.
 */
export const moderateReply = (
  reply: Reply,
  action: ModerationActionKind,
): Result<ModeratedReply, EngineError> => {
  const to = replyOutcomeOf(action);
  if (to === undefined) return ok({ reply, moved: false });

  if (reply.status === to) {
    // Idempotent rather than an error: two moderators clicking the same button is not
    // a conflict worth surfacing to either of them — the same rule cases already hold.
    return ok({ reply, moved: false });
  }
  if (!canModerateReply(reply.status, to)) {
    return err(
      preconditionError('reply_transition_invalid', `a ${reply.status} reply cannot become ${to}`, {
        from: reply.status,
        to,
      }),
    );
  }

  return ok({ reply: { ...reply, status: to }, moved: true });
};

/**
 * Deliberately absent: any path from moderating a reply to the parent experience.
 *
 * `undefined`, so the absence is assertable. The cascade runs the other way — an
 * experience coming down takes its replies with it — and a reply that could take its
 * parent down would make every thread a lever on the account it belongs to.
 */
export const replyModerationTouchesParent = (): undefined => undefined;
