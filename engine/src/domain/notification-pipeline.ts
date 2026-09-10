/**
 * Phase 79 — the notification pipeline, with its stages named.
 *
 * ## What was here, and what was missing
 *
 * `notification.engine.ts` has a `fanOut` helper that does five things in one function
 * body: skip self, check for an existing row, check blocks, check mutes, check preferences.
 * It works, it is idempotent, and every one of those checks is correct.
 *
 * **What it has no stage for is authorization** — "may this person see the thing I am about
 * to tell them about?" That question is never asked, and until now it never needed to be,
 * because every notification went to the *author* of the experience and an author can always
 * read their own experience. The recipient was always someone with an unquestionable right
 * to the subject.
 *
 * Phase 78 ends that. A watcher is not the author. Once somebody can be notified about an
 * experience they merely watch, "may they see it" becomes a live question with a wrong
 * answer available: an experience is watched, a moderator removes it, and the watcher is
 * notified that something happened to content they can no longer read — or worse, the
 * payload carries an excerpt of it.
 *
 * So this module makes the stages explicit and adds the missing one:
 *
 * ```
 * trigger → eligibility → authorization → dedupe → delivery
 * ```
 *
 * ## Why eligibility and authorization must not collapse
 *
 * They are different refusals and conflating them produces a wrong answer in both
 * directions:
 *
 *   - **Eligibility** is *"you asked not to be told"* — a preference, a mute, a block, or
 *     your own action. The recipient could see the thing; they have chosen not to hear about
 *     it. Turning the preference off makes the notification appear.
 *   - **Authorization** is *"you may not be told"* — the subject is not something this
 *     person may read. No preference change makes it appear, and a surface that offered one
 *     would be offering a setting that does nothing.
 *
 * A single "suppressed" state cannot distinguish them, and an operator debugging "why did I
 * not get this" needs to know which it was. So the decision carries a stage and a reason,
 * and the stage is the part that matters.
 *
 * ## Order, and why authorization is not first
 *
 * Eligibility runs first even though authorization is the stronger check, because it is
 * cheaper and because it short-circuits the common case: most suppressions are preferences,
 * and asking the database whether somebody may read a thing in order to then discard the
 * notification because they muted the sender is work for nothing. Neither ordering can leak —
 * a refusal at either stage produces no notification — so the choice is free and cost decides.
 */

/** The stage a decision was made at. Named so a refusal says *which* check refused. */
export type NotificationStage = 'eligibility' | 'authorization' | 'dedupe' | 'delivery';

export const NOTIFICATION_STAGES: readonly NotificationStage[] = [
  'eligibility',
  'authorization',
  'dedupe',
  'delivery',
];

/** Why eligibility refused. Each is something the recipient chose or did. */
export type EligibilityRefusal = 'self' | 'blocked' | 'muted' | 'preference';

/**
 * Why authorization refused.
 *
 * `subject_unreadable` is the one Phase 78 makes reachable: the recipient watches something
 * they may no longer read. `subject_missing` is separate because "it is gone" and "you may
 * not see it" are different facts, and a surface that said the wrong one would either
 * mislead or leak.
 */
export type AuthorizationRefusal = 'subject_unreadable' | 'subject_missing';

export type NotificationDecision =
  | { readonly stage: 'delivery'; readonly deliver: true }
  | {
      readonly stage: 'eligibility';
      readonly deliver: false;
      readonly reason: EligibilityRefusal;
      /** True — a preference change would make this appear. */
      readonly recipientCouldEnable: true;
    }
  | {
      readonly stage: 'authorization';
      readonly deliver: false;
      readonly reason: AuthorizationRefusal;
      /** False — no setting makes this appear, and offering one would be a lie. */
      readonly recipientCouldEnable: false;
    }
  | {
      readonly stage: 'dedupe';
      readonly deliver: false;
      readonly reason: 'already_notified';
      readonly recipientCouldEnable: false;
    };

/** What the pipeline needs to know, gathered by the caller so the decision stays pure. */
export interface NotificationContext {
  readonly recipientActorId: string;
  readonly originActorId: string;
  /** Whether the recipient blocked, muted, or turned this kind off. */
  readonly blocked: boolean;
  readonly muted: boolean;
  readonly preferenceEnabled: boolean;
  /** Whether the subject exists at all, and whether this recipient may read it. */
  readonly subjectExists: boolean;
  readonly subjectReadable: boolean;
  /** Whether a notification with this dedupe key already exists for this recipient. */
  readonly alreadyNotified: boolean;
}

/**
 * The whole decision, as a pure function.
 *
 * Pure so each stage is separately testable without a store — which is the point of naming
 * the stages at all. A pipeline whose stages can only be exercised by constructing the
 * world that reaches them is a pipeline with one testable path.
 */
export const decideNotification = (context: NotificationContext): NotificationDecision => {
  // ── Eligibility ────────────────────────────────────────────────────────
  // Nobody is notified about their own action. First because it is the cheapest and
  // because it is the one that would be most obviously wrong.
  if (context.recipientActorId === context.originActorId) {
    return { stage: 'eligibility', deliver: false, reason: 'self', recipientCouldEnable: true };
  }
  if (context.blocked) {
    return { stage: 'eligibility', deliver: false, reason: 'blocked', recipientCouldEnable: true };
  }
  if (context.muted) {
    return { stage: 'eligibility', deliver: false, reason: 'muted', recipientCouldEnable: true };
  }
  if (!context.preferenceEnabled) {
    return { stage: 'eligibility', deliver: false, reason: 'preference', recipientCouldEnable: true };
  }

  // ── Authorization ──────────────────────────────────────────────────────
  // The stage that did not exist. Reachable now that a recipient can be somebody other
  // than the author.
  if (!context.subjectExists) {
    return {
      stage: 'authorization',
      deliver: false,
      reason: 'subject_missing',
      recipientCouldEnable: false,
    };
  }
  if (!context.subjectReadable) {
    return {
      stage: 'authorization',
      deliver: false,
      reason: 'subject_unreadable',
      recipientCouldEnable: false,
    };
  }

  // ── Dedupe ─────────────────────────────────────────────────────────────
  // After authorization, so a replay of an event about something now unreadable refuses at
  // authorization rather than reporting "already notified" — which would be true and
  // misleading, since the reason it will never be notified again is not that it was.
  if (context.alreadyNotified) {
    return {
      stage: 'dedupe',
      deliver: false,
      reason: 'already_notified',
      recipientCouldEnable: false,
    };
  }

  return { stage: 'delivery', deliver: true };
};

/**
 * The dedupe key for a notification, derived entirely from content.
 *
 * **Content-derived is what makes replay safe.** A key containing a timestamp, a random id or
 * an attempt number would make the second delivery of one event look like a new notification —
 * and at-least-once delivery means a second delivery is normal, not exceptional. Every
 * component here comes from the event's meaning rather than from its handling.
 */
export const dedupeKeyFor = (parts: {
  readonly kind: string;
  readonly subjectId: string;
  readonly originActorId: string;
  /** Anything that distinguishes two notifications of the same kind about the same thing. */
  readonly discriminator?: string;
}): string =>
  [parts.kind, parts.subjectId, parts.originActorId, parts.discriminator ?? '']
    .filter((part) => part.length > 0)
    .join(':');

/**
 * A refusal, in words, for an operator asking why somebody was not told.
 *
 * The distinction the sentence has to carry is whether the recipient could change it —
 * because "turn the setting back on" and "there is no setting for this" are the two answers,
 * and giving the wrong one wastes somebody's time or misleads them about what they control.
 */
export const explainDecision = (decision: NotificationDecision): string => {
  switch (decision.stage) {
    case 'delivery':
      return 'delivered';
    case 'eligibility':
      return decision.reason === 'self'
        ? 'not delivered: nobody is notified about their own action'
        : `not delivered: the recipient ${decision.reason === 'preference' ? 'turned this kind off' : `has ${decision.reason} the sender`} — a setting they control`;
    case 'authorization':
      return decision.reason === 'subject_missing'
        ? 'not delivered: the thing it was about no longer exists'
        : 'not delivered: the recipient may not read the thing it was about — no setting changes this';
    case 'dedupe':
      return 'not delivered: they have already been told this';
  }
};

/**
 * The absences, as code.
 *
 * `notificationCarriesSubjectBody` — a payload never carries the content it is about, so a
 * notification about something since removed cannot leak an excerpt of it. That is the
 * failure authorization exists to prevent, and keeping the body out means a bug in
 * authorization is a wrong notification rather than a disclosure.
 *
 * `notificationNamesWatcher` — a notification to a watcher does not tell the author that a
 * watcher exists, and does not tell the watcher who else is watching.
 */
export const notificationCarriesSubjectBody = (): false => false;
export const notificationNamesWatcher = (): false => false;
