/**
 * Phase 61 — request governance and quotas.
 *
 * This closes a dead branch rather than adding a feature. `rate_limited` has been in
 * `ErrorKind` since the runtime was written, it is one of the two kinds in
 * `RETRYABLE`, and `lib/api.ts` maps it to HTTP 429 — and nothing anywhere produced
 * it. A declared capability with no implementation, the same shape of defect as the
 * `ReportResolved` subscription that had no publisher. Because the contract was
 * already decided in three places, this module's job is to honour it, not to design
 * it: a throttle is retryable, it is a 429, and it says when to come back.
 *
 * **A quota is not a judgement.** Being throttled is not being suspected of
 * anything. No throttle count reaches a trust assessment, a severity band, a
 * priority, a queue or a reputation read, and there is no field here through which
 * one could — which is why `quotaSignalsForTrust()` exists and returns `undefined`.
 * The distinction matters because the alternative is a system where posting quickly
 * makes you look guilty, and the people most likely to post quickly are the ones
 * something is actively happening to.
 *
 * **Per command class, not global.** A read is not a corroboration and a
 * corroboration is not an upload. One global bucket would let a busy reader exhaust
 * their ability to report an incident, which is the one thing that must never be
 * rate-limited into uselessness.
 */

/**
 * What kind of request this is, for the purpose of counting.
 *
 * Deliberately coarse. A class per command would be a policy nobody can reason
 * about and a table nobody can read; these five are the distinctions that matter
 * because the cost and the abuse shape differ between them.
 */
export type QuotaClass =
  /** Creating an account or a session. The only class a guest can reach. */
  | 'identity'
  /** Publishing an experience or a reply — text the system must screen. */
  | 'authoring'
  /** Claiming that something happened to you too. The trust primitive. */
  | 'corroboration'
  /** Uploading bytes. The most expensive thing a caller can ask for. */
  | 'upload'
  /** Everything else a member may do: reactions, preferences, graph edges. */
  | 'interaction';

export const QUOTA_CLASSES: readonly QuotaClass[] = [
  'identity',
  'authoring',
  'corroboration',
  'upload',
  'interaction',
];

export interface QuotaLimit {
  /** Requests permitted in the window. */
  readonly limit: number;
  readonly windowMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The limits, and why each is what it is.
 *
 * Every one of these is generous for a person and restrictive for a script, which is
 * the only useful place to put a limit. A number tight enough to inconvenience a
 * real user protects nothing, because the abuse this guards against is automated.
 */
export const QUOTA_LIMITS: Readonly<Record<QuotaClass, QuotaLimit>> = {
  // Registration and authentication are what an attacker enumerates, and what a
  // person does once. The tightest limit here by a wide margin.
  identity: { limit: 10, windowMs: HOUR },
  // Ten accounts an hour is more than anybody writes in earnest, and screening each
  // one costs real work downstream.
  authoring: { limit: 20, windowMs: HOUR },
  // Corroboration is one tap, and a person legitimately recognises several
  // experiences in a sitting. Restrictive enough that a script cannot manufacture a
  // pattern, loose enough that reading a cluster and agreeing with it is not
  // throttled.
  corroboration: { limit: 30, windowMs: HOUR },
  // Bytes. Expensive to accept, expensive to protect, expensive to store.
  upload: { limit: 12, windowMs: HOUR },
  // Reactions and preferences are cheap and high-frequency by design.
  interaction: { limit: 240, windowMs: HOUR },
};

/**
 * Which class a command belongs to.
 *
 * Explicit rather than inferred from the command name: a prefix rule would silently
 * put a command added later into whichever class its name happened to suggest, and
 * the failure mode of that is a corroboration counted as an interaction.
 */
export const QUOTA_CLASS_BY_COMMAND: Readonly<Record<string, QuotaClass>> = {
  'identity.register': 'identity',
  'identity.authenticate': 'identity',
  'identity.createAlias': 'identity',
  'identity.retireAlias': 'identity',
  'identity.revokeSession': 'identity',

  'experience.create': 'authoring',
  'experience.updateBody': 'authoring',
  'conversation.createReply': 'authoring',
  'organization.respond': 'authoring',
  'dispute.open': 'authoring',
  'resolution.report': 'authoring',
  'enrichment.assert': 'authoring',
  'normalization.confirm': 'authoring',

  'corroboration.create': 'corroboration',
  'corroboration.retract': 'corroboration',
  'relation.assert': 'corroboration',
  'relation.retract': 'corroboration',

  'voice.requestUploadTarget': 'upload',
  'voice.attachAsset': 'upload',
  'evidence.attach': 'upload',
};

/**
 * Commands that are never throttled, and why each one.
 *
 * A short list, and every entry is a case where throttling would do more harm than
 * the abuse it prevents.
 */
export const UNTHROTTLED_COMMANDS: Readonly<Record<string, string>> = {
  // Reporting harm must never be rate-limited. Somebody being harassed at speed
  // needs to report at speed, and an attacker gains nothing from a report.
  'safety.fileReport': 'reporting harm is never throttled',
  // Moderators and admins act under a policy matrix and an audit trail; throttling
  // them slows an incident response down for no security gain.
  'safety.claimQueueItem': 'operators are governed by policy, not by quota',
  'safety.applyModerationAction': 'operators are governed by policy, not by quota',
  'governance.grantRole': 'operators are governed by policy, not by quota',
  'governance.replayDeadLetter': 'operators are governed by policy, not by quota',
  'proposal.decide': 'operators are governed by policy, not by quota',
  'proposal.expire': 'operators are governed by policy, not by quota',
  'dispute.review': 'operators are governed by policy, not by quota',
  'evidence.assess': 'operators are governed by policy, not by quota',
  // Withdrawing a claim, retracting consent or deleting your own account must
  // always be possible. A quota on leaving is a trap.
  'dispute.withdraw': 'withdrawing is never throttled',
  'creator.deleteExperience': 'leaving is never throttled',
  'creator.changeVisibility': 'tightening your own visibility is never throttled',
  'creator.requestExport': 'a data-subject request is never throttled',
};

/** The class a command counts against, or `undefined` when it is not counted. */
export const quotaClassOf = (command: string): QuotaClass | undefined => {
  if (command in UNTHROTTLED_COMMANDS) return undefined;
  return QUOTA_CLASS_BY_COMMAND[command] ?? 'interaction';
};

export interface QuotaWindow {
  /** `actorId:class`. The natural key, so concurrent requests collide on one row. */
  readonly id: string;
  readonly actorId: string;
  readonly quotaClass: QuotaClass;
  /** When the current window opened. */
  readonly windowStartedAt: number;
  readonly count: number;
}

export type QuotaDecision =
  | { readonly allowed: true; readonly window: QuotaWindow; readonly remaining: number }
  | { readonly allowed: false; readonly retryAfterMs: number; readonly limit: number; readonly windowMs: number };

/**
 * Decide, and produce the next window.
 *
 * Pure: the caller reads the row, calls this, and writes what it returns. Keeping the
 * arithmetic out of the engine is what makes "the window rolls over" and "the
 * hundredth request in a burst is refused" testable without a store.
 *
 * The window is fixed rather than sliding. A sliding window needs every timestamp
 * retained, which means storing a request log per actor — more data about people's
 * timing than a throttle has any business keeping.
 */
export const decideQuota = (
  quotaClass: QuotaClass,
  existing: QuotaWindow | undefined,
  actorId: string,
  now: number,
): QuotaDecision => {
  const policy = QUOTA_LIMITS[quotaClass];
  const id = quotaWindowKey(actorId, quotaClass);

  const startedAt = existing?.windowStartedAt ?? now;
  const expired = now - startedAt >= policy.windowMs;
  const count = existing === undefined || expired ? 0 : existing.count;
  const windowStartedAt = existing === undefined || expired ? now : startedAt;

  if (count >= policy.limit) {
    return {
      allowed: false,
      // Said out loud, because a 429 with no idea when to return is a 429 that gets
      // retried immediately in a loop.
      retryAfterMs: Math.max(0, windowStartedAt + policy.windowMs - now),
      limit: policy.limit,
      windowMs: policy.windowMs,
    };
  }

  return {
    allowed: true,
    window: { id, actorId, quotaClass, windowStartedAt, count: count + 1 },
    remaining: policy.limit - (count + 1),
  };
};

export const quotaWindowKey = (actorId: string, quotaClass: QuotaClass): string =>
  `${actorId}:${quotaClass}`;

/** The message a throttled caller sees. Plain, and never accusatory. */
export const throttleMessage = (retryAfterMs: number): string => {
  const seconds = Math.ceil(retryAfterMs / 1_000);
  const minutes = Math.ceil(seconds / 60);
  return seconds <= 90
    ? `Too many requests. Try again in about ${seconds} second${seconds === 1 ? '' : 's'}.`
    : `Too many requests. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
};

/**
 * Deliberately absent: any path from a quota to a judgement.
 *
 * `undefined`, so the absence is assertable rather than merely true today. A throttle
 * count must not reach a trust assessment, a severity band, a priority or a
 * reputation read — posting quickly is not evidence of anything, and the people most
 * likely to post quickly are the ones something is happening to.
 */
export const quotaSignalsForTrust = (): undefined => undefined;

/** And absent: any way to throttle somebody harder than the stated policy. */
export const setQuotaForActor = (): undefined => undefined;
