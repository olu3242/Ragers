/**
 * Phase 68 — which actions are audited, and why those.
 *
 * `audit_events` has existed since migration 0001 with append-only enforcement, and
 * exactly five of the forty-nine registered commands write to it. The obvious reading is
 * that forty-four are missing their audit. That reading is wrong, and getting it right is
 * the whole phase: **an audit of everything is an audit of nothing.** A trail carrying
 * every projection and counter buries the handful of rows somebody actually needs, and the
 * only time anybody reads an audit trail is the one time it matters — a dispute about what
 * a staff member did to somebody's account.
 *
 * Applying the rule found nine real gaps, which is the useful number: nine commands that
 * take a decision about somebody else, or destroy something, and left no attributable
 * trace. Deciding a dispute was one of them.
 *
 * So this is a rule, and the coverage follows from it rather than the other way round.
 *
 * ## The rule
 *
 * An action is audited when at least one of three things is true:
 *
 * 1. **It is taken under authority about somebody else.** A moderator removing content,
 *    a reviewer deciding a dispute, staff assigning a case. Somebody used a privilege the
 *    affected person does not have, and the effect is visible while the actor is not.
 *    This is the clause the trail exists for.
 *
 * 2. **It changes what somebody else may do.** Granting a role, revoking a session,
 *    changing the visibility that governs who may read what. The effect outlives the
 *    request and constrains a person other than the caller.
 *
 * 3. **It irreversibly destroys or exports a record.** Deleting an experience or a reply,
 *    requesting an export of personal data. Here the audit event is the only thing that
 *    survives, which is precisely why it must be written — Phase 64's rule that "the
 *    audit trail of the deletion survives the deletion" is this clause.
 *
 * Everything else is not audited, and each exclusion carries its reason. Three kinds
 * dominate: **your own routine action on your own content** (posting, reacting, replying —
 * the row itself is the record, with your id on it), **internal recomputation** (a
 * projection catching up is not a person doing anything), and **actions whose own table is
 * already the attributable record** (a report has a reporter id; a corroboration has a
 * corroborator id; auditing them would store the same fact twice and the copy would be the
 * one that drifted).
 *
 * ## Why a table rather than a convention
 *
 * Because the Phase 48 lesson applies: a hand-maintained list of audited commands rots the
 * first time somebody adds a command, and a convention ("audit privileged things") is not
 * checkable. This table is enumerated against `bus.registeredCommands()` by a discovery
 * guard, so a command registered tomorrow with no entry fails the guard tomorrow — and
 * one the rule says must audit, that does not, fails it too.
 */

/** Which clause of the rule brings a command into the trail. */
export type AuditReason =
  /** Clause 1 — taken under authority about somebody else. */
  | 'authority_over_another'
  /** Clause 2 — changes what somebody else may do. */
  | 'changes_what_another_may_do'
  /** Clause 3 — irreversibly destroys or exports a record. */
  | 'irreversible_or_exporting';

export const AUDIT_REASONS: readonly AuditReason[] = [
  'authority_over_another',
  'changes_what_another_may_do',
  'irreversible_or_exporting',
];

/** Why a command is *not* audited. Each value is an argument, not a category. */
export type AuditExemption =
  /** Your own ordinary action on your own content. The row carries your id already. */
  | 'own_action_own_content'
  /** A projection, counter or recomputation. Nobody did anything. */
  | 'internal_recomputation'
  /** The action's own table is the attributable record; an audit row would duplicate it. */
  | 'own_table_is_the_record'
  /** Reading, or marking something read. No effect on anybody. */
  | 'read_only'
  /**
   * Auditing it would *create* the disclosure the action's own privacy rule forbids.
   *
   * A different kind of exemption from the three above, and the reason it needs its own
   * value: those say an audit row would be *redundant*, and this says it would be
   * *harmful*. The audit trail is staff-readable by design, so writing "actor X watched
   * experience Y" into it builds exactly the record of who-watches-what that Phase 78
   * exists to prevent — an operator could then answer a question the author cannot.
   */
  | 'auditing_would_disclose';

export const AUDIT_EXEMPTIONS: readonly AuditExemption[] = [
  'own_action_own_content',
  'internal_recomputation',
  'own_table_is_the_record',
  'read_only',
  'auditing_would_disclose',
];

/**
 * The commands the rule requires an audit event for, each with the clause that brings it in.
 *
 * Read this as the answer to "what could a staff member do to me that I would want a
 * record of". That is the test each entry has to pass.
 */
export const AUDITED_COMMANDS: Readonly<Record<string, AuditReason>> = {
  // ── Clause 1: authority over another ──────────────────────────────────────
  'safety.applyModerationAction': 'authority_over_another',
  'case.assign': 'authority_over_another',
  'case.transition': 'authority_over_another',
  'dispute.review': 'authority_over_another',
  'evidence.assess': 'authority_over_another',
  'proposal.decide': 'authority_over_another',
  'governance.replayDeadLetter': 'authority_over_another',

  // ── Clause 2: changes what somebody else may do ───────────────────────────
  //
  // A visibility change belongs here rather than under "your own content", and the
  // reasoning is worth stating because it is not obvious: visibility governs who *else*
  // may read. The dispute this clause anticipates is "my experience was public and I never
  // made it public", and answering it needs a record of when the setting changed and who
  // changed it. The row alone cannot answer it, because the row only holds the current value.
  'governance.grantRole': 'changes_what_another_may_do',
  'identity.revokeSession': 'changes_what_another_may_do',
  'identity.setDefaultVisibility': 'changes_what_another_may_do',
  'creator.changeVisibility': 'changes_what_another_may_do',

  // ── Clause 3: irreversible, or an export of personal data ─────────────────
  'creator.deleteExperience': 'irreversible_or_exporting',
  'conversation.deleteReply': 'irreversible_or_exporting',
  'creator.requestExport': 'irreversible_or_exporting',
};

/**
 * Every other command, with the reason it is not audited.
 *
 * Exhaustive by construction: the discovery guard asserts that every registered command
 * appears in exactly one of these two maps, so a new command cannot quietly land in
 * neither. Writing the exemption down is the part that makes the rule falsifiable — a
 * reader can disagree with a specific line, which is impossible with a convention.
 */
export const UNAUDITED_COMMANDS: Readonly<Record<string, AuditExemption>> = {
  // Your own action on your own content or your own identity. The row has your id on it;
  // an audit event would say the same thing in a second place, and the second place is the
  // one that drifts.
  'experience.create': 'own_action_own_content',
  'experience.updateBody': 'own_action_own_content',
  'conversation.createReply': 'own_action_own_content',
  'reaction.toggle': 'own_action_own_content',
  'reaction.castFairVote': 'own_action_own_content',
  'identity.register': 'own_action_own_content',
  'identity.authenticate': 'own_action_own_content',
  'identity.createAlias': 'own_action_own_content',
  'identity.retireAlias': 'own_action_own_content',
  'voice.requestUploadTarget': 'own_action_own_content',
  'voice.attachAsset': 'own_action_own_content',
  'evidence.attach': 'own_action_own_content',
  'share.create': 'own_action_own_content',
  'notification.setPreference': 'own_action_own_content',
  'organization.claim': 'own_action_own_content',
  'organization.respond': 'own_action_own_content',
  'resolution.report': 'own_action_own_content',
  'dispute.open': 'own_action_own_content',
  'dispute.withdraw': 'own_action_own_content',
  'normalization.confirm': 'own_action_own_content',
  'integration.subscribe': 'own_action_own_content',

  // The action's own table is the attributable record. A report has a reporter id and a
  // corroboration has a corroborator id; duplicating that into the trail stores one fact
  // twice without making it any more reliable.
  //
  // The follow/mute/block edges are here on purpose and for a second reason as well: they
  // are personal boundaries rather than authority over anybody. A trail of who blocked
  // whom is a list an operator would eventually be asked to interpret, and the honest
  // answer — that blocking somebody means nothing about either of them — is easier to hold
  // when the list does not exist.
  'safety.fileReport': 'own_table_is_the_record',
  'safety.claimQueueItem': 'own_table_is_the_record',
  'corroboration.create': 'own_table_is_the_record',
  'corroboration.retract': 'own_table_is_the_record',
  'relation.assert': 'own_table_is_the_record',
  'relation.retract': 'own_table_is_the_record',
  'proposal.create': 'own_table_is_the_record',
  'case.open': 'own_table_is_the_record',
  'graph.follow': 'own_table_is_the_record',
  'graph.mute': 'own_table_is_the_record',
  'graph.block': 'own_table_is_the_record',

  // Nobody did anything. A machine asserting what it derived, or a scheduled sweep
  // expiring what its own clock expired. Auditing these is what buries the rest.
  'enrichment.assert': 'internal_recomputation',
  'proposal.expire': 'internal_recomputation',

  // Reading, or marking your own notification read.
  'notification.markRead': 'read_only',

  // Phase 78 — and this is the one exemption whose reason is a privacy rule rather than
  // redundancy. A watch is already attributable from its own row, so `own_table_is_the_record`
  // would be true; but the stronger fact is that an audit row would be *harmful*. The trail
  // is staff-readable, so "actor X watched experience Y" in it would let an operator answer
  // "who is watching my experience" — a question the author themselves is refused, and the
  // question the whole phase exists to make unanswerable.
  'watch.start': 'auditing_would_disclose',
  'watch.stop': 'auditing_would_disclose',
};

/**
 * The action string each audited command writes.
 *
 * Declared here rather than left to each engine, because the vocabulary had already drifted
 * before anybody noticed: four commands wrote resource-oriented actions (`role.grant`,
 * `experience.delete`) and the coverage added by this phase initially wrote command names
 * (`creator.changeVisibility`). Half a vocabulary is worse than either half, because a
 * trail nobody can query reliably is a trail nobody queries.
 *
 * **Resource-oriented wins**, for two reasons. It matches `resourceType`, so a row reads as
 * one statement rather than two vocabularies stapled together; and it survives a command
 * rename, which a trail spanning years has to do.
 *
 * `safety.applyModerationAction` is the one entry that is a prefix rather than a literal:
 * it records the specific action taken (`moderation.remove`, `moderation.restore`), which is
 * more useful than a single flat `moderation.action` would be.
 */
export const AUDIT_ACTIONS: Readonly<Record<string, string>> = {
  'safety.applyModerationAction': 'moderation.',
  'case.assign': 'case.assign',
  'case.transition': 'case.transition',
  'dispute.review': 'dispute.review',
  'evidence.assess': 'evidence.assess',
  'proposal.decide': 'proposal.decide',
  'governance.replayDeadLetter': 'dead_letter.replay',
  'governance.grantRole': 'role.grant',
  'identity.revokeSession': 'session.revoke',
  'identity.setDefaultVisibility': 'actor.set_default_visibility',
  'creator.changeVisibility': 'experience.change_visibility',
  'creator.deleteExperience': 'experience.delete',
  'conversation.deleteReply': 'reply.delete',
  'creator.requestExport': 'export.request',
};

/** Whether the rule requires an audit event for this command. */
export const isAudited = (command: string): boolean => AUDITED_COMMANDS[command] !== undefined;

/** Why it is audited, or why it is not — whichever applies. */
export const auditRationale = (command: string): AuditReason | AuditExemption | undefined =>
  AUDITED_COMMANDS[command] ?? UNAUDITED_COMMANDS[command];

/**
 * The rule stated as a sentence, so a reviewer arguing about a specific command has
 * something to argue against.
 */
export const AUDIT_RULE =
  'An action is audited when it is taken under authority about somebody else, when it ' +
  'changes what somebody else may do, or when it irreversibly destroys or exports a ' +
  'record. Everything else is not, because an audit of everything is an audit of nothing.';

/**
 * Auditing is not moderation, and this is where that is stated.
 *
 * An audit event records that something happened. It carries no verdict, no severity and
 * no suspicion, and nothing downstream may read the trail to decide an outcome — a trail
 * that fed a trust score would turn "we keep records" into "we keep a file on you", which
 * is a different product.
 */
export const auditReachesATrustScore = (): undefined => undefined;
export const auditIsAModerationDecision = (): false => false;
