import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { EngineError } from '../../src/runtime/errors.ts';

/**
 * Command boundary hardening — every registered command, against malformed input.
 *
 * The reference defect is `normalization.confirm`, which reached `Object.entries(undefined)`
 * when a caller sent `confirmations` instead of `fields` and produced `command_threw`: an
 * *internal, non-retryable* error for what is plainly a bad request. The bus catching a throw
 * is a safety net, not a contract — a caller who sends nonsense deserves to be told it was
 * nonsense, and an operator reading `command.threw` in a metric deserves for it to mean
 * something is actually broken.
 *
 * So this file dispatches **every command the bus knows about** with a battery of malformed
 * payloads and asserts none of them produces an internal error. It is deliberately written as
 * a sweep rather than as one test per command: a new command added later is covered the day it
 * is registered, which is the same reasoning that replaced the Phase 48 filename list.
 *
 * What it does *not* do is convert every exception into a domain refusal. A programmer bug
 * should still surface as one. The assertion is narrower and more useful: **malformed caller
 * input must not be reported as an internal defect**, and it must change nothing.
 */

/**
 * The failure classes a caller may legitimately receive.
 *
 * `rate_limited` is here because Phase 61 gave it a producer. It is a refusal aimed at
 * the caller — retryable, a 429, with a stated retry-after — and reporting it as an
 * internal defect would be the same category error this file exists to prevent.
 */
const CALLER_FAILURE_KINDS = new Set([
  'validation',
  'unauthorized',
  'not_found',
  'conflict',
  'precondition',
  'rate_limited',
]);

/** Payloads a hostile or confused caller might plausibly send. */
const MALFORMED_INPUTS: readonly { readonly label: string; readonly input: unknown }[] = [
  { label: 'undefined', input: undefined },
  { label: 'null', input: null },
  { label: 'empty object', input: {} },
  { label: 'a string where an object belongs', input: 'not-an-object' },
  { label: 'a number', input: 42 },
  { label: 'an array', input: [] },
  // Wrong types in the shapes commands actually accept.
  { label: 'empty identifiers', input: { id: '', experienceId: '', organizationId: '', proposalId: '', caseId: '' } },
  {
    label: 'wrong types throughout',
    input: {
      experienceId: 123,
      kind: [],
      type: {},
      fields: 'not-an-object',
      confirmations: [],
      events: 'resolution.reported',
      evidenceRefs: 'exp_1',
      amount: 'lots',
      flag: 'yes',
      outcome: 7,
      to: 99,
      dimension: null,
      byteSize: -1,
      occurredAt: 'yesterday',
    },
  },
  {
    label: 'invalid enums',
    input: {
      experienceId: 'exp_missing',
      kind: 'shout',
      type: 're_shrug',
      dimension: 'vibes',
      outcome: 'maybe',
      to: 'nowhere',
      reason: 'because',
      action: 'obliterate',
      targetType: 'planet',
      relationship: 'vaguely',
      visibility: 'semi',
    },
  },
  {
    label: 'numeric and date extremes',
    input: {
      experienceId: 'exp_missing',
      amount: Number.NaN,
      confidence: 42,
      byteSize: Number.MAX_SAFE_INTEGER,
      occurredAt: Number.NEGATIVE_INFINITY,
      expiresAt: 'not-a-date',
      dimension: 'money_lost',
      currency: 'POUNDS',
    },
  },
  {
    label: 'oversized text',
    input: {
      experienceId: 'exp_missing',
      bodyText: 'x'.repeat(200_000),
      note: 'y'.repeat(100_000),
      summary: 'z'.repeat(50_000),
      body: 'w'.repeat(100_000),
      detail: 'v'.repeat(50_000),
    },
  },
  {
    label: 'malformed references',
    input: {
      experienceId: 'exp_missing',
      evidenceRefs: [{ kind: 'nonsense' }, null, 'not-an-object', { id: '' }],
      proposedInput: 'not-an-object',
      subjectId: '',
      sourceEngine: 'E99',
      targetEngine: null,
    },
  },
];

const describe = (error: EngineError): string => `${error.kind}/${error.code}`;

/**
 * Dispatch one command with one malformed payload and report an internal failure, if any.
 *
 * Uses a distinct idempotency key per attempt so a refusal is never masked by a replay of an
 * earlier one — the point is to reach the handler every time.
 */
const probe = async (
  h: EngineHarness,
  command: string,
  actor: ActorContext,
  label: string,
  input: unknown,
): Promise<string | undefined> => {
  const result = await h.engine.bus.dispatch({
    name: command,
    input,
    actor,
    idempotencyKey: h.nextKey(),
  });
  if (result.ok) return undefined;
  if (CALLER_FAILURE_KINDS.has(result.error.kind)) return undefined;
  // `internal` is the one that matters: it means the handler threw, or reported a defect for
  // what was only a bad request.
  return `${command} + ${label} → ${describe(result.error)}`;
};

/**
 * Unthrottled, deliberately.
 *
 * These sweeps send every command eleven payloads as three actors — thousands of
 * requests, which legitimately exceeds every Phase 61 quota. Throttling them would
 * mean a suite testing boundary refusals got refused for a different reason, so the
 * throttle is off here and tested where it belongs, in `quota.governance`.
 */
const sweepHarness = () => createEngineHarness({ throttle: false });

test('no command reports malformed caller input as an internal defect', async () => {
  const h = sweepHarness();
  const { actor: member } = await h.signUp('member@example.com', 'Member');
  const commands = h.engine.bus.registeredCommands();
  assert.ok(commands.length >= 49, `expected the full command surface, found ${commands.length}`);

  const offenders: string[] = [];
  for (const command of commands) {
    // `actor.register` and `actor.authenticate` are the only commands a guest may reach, and
    // they are probed as a guest below.
    for (const { label, input } of MALFORMED_INPUTS) {
      const found = await probe(h, command, member, label, input);
      if (found) offenders.push(found);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `malformed input must be refused, not reported as a defect:\n${offenders.join('\n')}`,
  );
});

test('no command reports malformed input from a guest as an internal defect', async () => {
  const h = sweepHarness();
  const guest: ActorContext = { actorId: 'guest', role: 'guest', authenticated: false };
  const offenders: string[] = [];
  for (const command of h.engine.bus.registeredCommands()) {
    for (const { label, input } of MALFORMED_INPUTS) {
      const found = await probe(h, command, guest, label, input);
      if (found) offenders.push(found);
    }
  }
  assert.deepEqual(offenders, [], `a guest sending nonsense must be refused:\n${offenders.join('\n')}`);
});

test('no command reports malformed input from a moderator as an internal defect', async () => {
  // A privileged actor reaches handlers a member cannot, so the sweep has to run as one too —
  // otherwise the moderation, governance and proposal commands are never actually entered.
  const h = sweepHarness();
  const admin = await h.promote((await h.signUp('admin@example.com')).auth.actorId, 'admin');
  const offenders: string[] = [];
  for (const command of h.engine.bus.registeredCommands()) {
    for (const { label, input } of MALFORMED_INPUTS) {
      const found = await probe(h, command, admin, label, input);
      if (found) offenders.push(found);
    }
  }
  assert.deepEqual(offenders, [], `a privileged actor sending nonsense must be refused:\n${offenders.join('\n')}`);
});

// ── The second half: garbage that actually reaches a handler ────────────────
//
// The sweep above mostly exercises the resolve stage — a nonexistent id is refused
// before a handler body is entered, so a handler that mishandles a bad *value* is
// never reached. This half seeds a real world, then dispatches every command with
// **valid identifiers** and invalid field values, as each of the three actors who
// can get past authorization. That is where an invalid enum, a NaN, an unparseable
// date, an oversized body or a malformed evidence reference lands in real code.

interface SeededWorld {
  readonly h: EngineHarness;
  readonly ids: Readonly<Record<string, string>>;
  readonly actors: readonly { readonly label: string; readonly actor: ActorContext }[];
}

const seedWorld = async (): Promise<SeededWorld> => {
  const h = sweepHarness();
  await h.engine.store.entities.put({ id: 'ent_1', name: 'Northwind Air', slug: 'northwind-air', kind: 'organization' });
  await h.engine.store.entityAliases.put({ id: 'ali_e1', entityId: 'ent_1', alias: 'Northwind Air' });
  // A second, unclaimed entity, so `organization.claim` is reachable rather than
  // being refused as already-claimed before its input is ever looked at.
  await h.engine.store.entities.put({ id: 'ent_2', name: 'Southwind Rail', slug: 'southwind-rail', kind: 'organization' });
  await h.engine.store.categories.put({ id: 'cat_1', name: 'Shopping & service', slug: 'shopping-service' });
  await h.engine.store.issueTypes.put({
    id: 'iss_1',
    categoryId: 'cat_1',
    name: 'Refund not processed',
    slug: 'refund-not-processed',
  });

  const author = await h.signUp('author@example.com', 'Author');
  const second = await h.signUp('second@example.com', 'Second');
  const staff = await h.signUp('staff@example.com', 'Staff');
  const admin = await h.promote((await h.signUp('boundary-admin@example.com')).auth.actorId, 'admin');

  await h.engine.store.organizationProfiles.put({
    id: 'org_1',
    entityId: 'ent_1',
    displayName: 'Northwind Air',
    claimedBy: staff.auth.actorId,
    claimedAt: h.clock.now(),
    status: 'claimed',
  });
  await h.engine.store.organizationMemberships.put({
    id: 'mem_1',
    organizationId: 'org_1',
    actorId: staff.auth.actorId,
    role: 'admin',
    grantedAt: h.clock.now(),
  });

  const dispatch = async (name: string, input: unknown, actor: ActorContext): Promise<unknown> => {
    const result = await h.engine.bus.dispatch({ name, input, actor, idempotencyKey: h.nextKey() });
    await h.settle();
    return result.ok ? result.value : undefined;
  };

  const created = (await dispatch(
    'experience.create',
    {
      kind: 'rage',
      creationMode: 'text',
      category: 'Shopping & service',
      bodyText: 'The refund was promised twice and never arrived',
      visibility: 'public',
    },
    author.actor,
  )) as { experienceId: string } | undefined;
  const experienceId = created?.experienceId ?? '';

  await dispatch(
    'normalization.confirm',
    { experienceId, fields: { entity: 'ent_1', category: 'cat_1', issueType: 'iss_1' } },
    author.actor,
  );

  const reply = (await dispatch(
    'conversation.createReply',
    { experienceId, creationMode: 'text', bodyText: 'This happened to me as well', visibility: 'public' },
    second.actor,
  )) as { replyId: string } | undefined;

  const corroboration = (await dispatch(
    'corroboration.create',
    { experienceId, type: 're_rage' },
    second.actor,
  )) as { corroborationId?: string } | undefined;

  const evidence = (await dispatch(
    'evidence.attach',
    {
      experienceId,
      kind: 'receipt',
      originalKey: 'raw/receipt-1.pdf',
      byteSize: 2048,
      mimeType: 'application/pdf',
    },
    author.actor,
  )) as { evidenceId?: string } | undefined;

  const dispute = (await dispatch(
    'dispute.open',
    {
      experienceId,
      organizationId: 'org_1',
      reason: 'account_inaccurate',
      detail: 'The refund was issued on the 4th',
    },
    staff.actor,
  )) as { disputeId?: string } | undefined;

  const orgCase = (await dispatch('case.open', { organizationId: 'org_1', experienceId }, staff.actor)) as
    | { caseId?: string }
    | undefined;

  const proposal = (await dispatch(
    'proposal.create',
    {
      proposalType: 'cluster_merge',
      sourceEngine: 'E7',
      targetEngine: 'E7',
      subjectId: experienceId,
      summary: 'Two clusters describe the same refund failure',
      rationale: 'The bodies name the same organization and the same unpaid refund',
      confidence: 0.7,
      evidenceRefs: [{ kind: 'experience', id: experienceId }],
    },
    admin,
  )) as { proposalId?: string } | undefined;

  await dispatch(
    'safety.fileReport',
    { targetType: 'experience', targetId: experienceId, reasonCode: 'spam' },
    second.actor,
  );
  const queueItem = (await h.engine.store.queueItems.all()).at(0);
  const notification = (await h.engine.store.notifications.all()).at(0);
  const alias = (await h.engine.store.aliases.all()).at(0);

  return {
    h,
    ids: {
      experienceId,
      replyId: reply?.replyId ?? '',
      corroborationId: corroboration?.corroborationId ?? '',
      evidenceId: evidence?.evidenceId ?? '',
      disputeId: dispute?.disputeId ?? '',
      caseId: orgCase?.caseId ?? '',
      proposalId: proposal?.proposalId ?? '',
      organizationId: 'org_1',
      entityId: 'ent_2',
      queueItemId: queueItem?.id ?? '',
      notificationId: notification?.id ?? '',
      aliasId: alias?.id ?? '',
      sessionId: author.auth.sessionId,
      targetId: experienceId,
      relationId: '',
    },
    actors: [
      { label: 'author', actor: author.actor },
      { label: 'org staff', actor: staff.actor },
      { label: 'admin', actor: admin },
    ],
  };
};

/** Invalid *values*, to be merged over every valid identifier the world has. */
const INVALID_VALUES: readonly { readonly label: string; readonly fields: Readonly<Record<string, unknown>> }[] = [
  {
    label: 'invalid enums',
    fields: {
      kind: 'shout',
      type: 're_shrug',
      dimension: 'vibes',
      outcome: 'maybe',
      to: 'nowhere',
      visibility: 'semi',
      action: 'obliterate',
      targetType: 'planet',
      relationship: 'vaguely',
      grounds: 'vibes',
      decision: 'perhaps',
      reason: 'because',
      role: 'overlord',
      creationMode: 'telepathy',
      status: 'ascended',
      assessment: 'shrug',
      preference: 'sometimes',
      channel: 'smoke_signal',
    },
  },
  {
    label: 'wrong types',
    fields: {
      kind: [],
      type: {},
      fields: 'not-an-object',
      confirmations: [],
      events: 'resolution.reported',
      evidenceRefs: 'exp_1',
      proposedInput: 'not-an-object',
      amount: 'lots',
      flag: 'yes',
      on: 'maybe',
      isFair: 'sure',
      bodyText: 42,
      statement: [],
      summary: {},
      note: 7,
      description: false,
      displayName: 99,
      email: {},
      aliasName: [],
      assigneeId: 12,
    },
  },
  {
    label: 'numeric and date extremes',
    fields: {
      dimension: 'money_lost',
      amount: Number.NaN,
      confidence: 42,
      byteSize: Number.MAX_SAFE_INTEGER,
      occurredAt: Number.NEGATIVE_INFINITY,
      expiresAt: 'not-a-date',
      currency: 'POUNDS',
      durationMs: -1,
    },
  },
  {
    label: 'oversized text',
    fields: {
      bodyText: 'x'.repeat(200_000),
      note: 'y'.repeat(100_000),
      summary: 'z'.repeat(50_000),
      statement: 'w'.repeat(100_000),
      description: 'v'.repeat(50_000),
      rationale: 'u'.repeat(50_000),
      displayName: 'n'.repeat(10_000),
      aliasName: 'a'.repeat(10_000),
    },
  },
  {
    label: 'empty strings where a value belongs',
    fields: {
      bodyText: '',
      note: '',
      summary: '',
      statement: '',
      description: '',
      rationale: '',
      displayName: '',
      aliasName: '',
      email: '',
      reason: '',
      kind: '',
      type: '',
      dimension: '',
      currency: '',
    },
  },
  {
    label: 'malformed references',
    fields: {
      evidenceRefs: [{ kind: 'nonsense' }, null, 'not-an-object', { id: '' }],
      sourceEngine: 'E99',
      targetEngine: null,
      subjectId: '',
      relatedExperienceId: '',
      proposedInput: [1, 2, 3],
      destination: {},
    },
  },
  {
    label: 'self-referential and duplicated identifiers',
    fields: {
      // A relation, dispute or merge that names the same thing twice.
      relatedExperienceId: '__SELF__',
      targetExperienceId: '__SELF__',
      sourceId: '__SELF__',
      targetId: '__SELF__',
      relationship: 'duplicate_of',
    },
  },
];

test('no command reports an invalid field value as an internal defect', async () => {
  const world = await seedWorld();
  const { h, ids } = world;
  // The world has to be real for this half to mean anything.
  assert.ok(ids.experienceId, 'the seeded experience exists');
  assert.ok(ids.replyId, 'the seeded reply exists');
  assert.ok(ids.caseId, 'the seeded case exists');
  assert.ok(ids.proposalId, 'the seeded proposal exists');

  const offenders: string[] = [];
  for (const command of h.engine.bus.registeredCommands()) {
    for (const { label, fields } of INVALID_VALUES) {
      const resolved = Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [key, value === '__SELF__' ? ids.experienceId : value]),
      );
      for (const { label: who, actor } of world.actors) {
        const found = await probe(h, command, actor, `${label} as ${who}`, { ...ids, ...resolved });
        if (found) offenders.push(found);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `an invalid field value must be refused, not reported as a defect:\n${offenders.join('\n')}`,
  );
});

// ── Named cases: one invalid field, everything else valid ───────────────────
//
// The two sweeps above stop at the first refusal, which is correct behaviour and a
// coverage ceiling: a command that refuses an invalid `to` never looks at the
// malformed `note` beside it. These cases each carry exactly one bad field, so the
// check under test is the one that has to catch it. Each is a refusal the code
// either already makes or did not make before this file existed.

interface NamedCase {
  readonly command: string;
  readonly as: 'author' | 'org staff' | 'admin';
  readonly why: string;
  readonly input: (ids: Readonly<Record<string, string>>) => Record<string, unknown>;
}

const NAMED_CASES: readonly NamedCase[] = [
  {
    command: 'creator.changeVisibility',
    as: 'author',
    why: 'a visibility outside the enum has no strength, so it walks straight through the tighten-only guard',
    input: (ids) => ({ experienceId: ids.experienceId, visibility: 'semi' }),
  },
  {
    command: 'notification.setPreference',
    as: 'author',
    why: 'an unbounded kind lets one caller write an unlimited number of preference rows',
    input: () => ({ kind: 'smoke_signal', enabled: true }),
  },
  {
    command: 'notification.setPreference',
    as: 'author',
    why: 'a non-boolean lands in a boolean column',
    input: () => ({ kind: 'reply_received', enabled: 'yes' }),
  },
  {
    command: 'organization.claim',
    as: 'author',
    // Absent is fine and deliberately so — see the test below. Not-text is not.
    why: 'a non-string display name is trimmed',
    input: (ids) => ({ entityId: ids.entityId, displayName: 99 }),
  },
  {
    command: 'proposal.decide',
    as: 'admin',
    why: 'a rejection note that is not a string is trimmed',
    input: (ids) => ({ proposalId: ids.proposalId, outcome: 'rejected', note: 7 }),
  },
  {
    command: 'proposal.decide',
    as: 'admin',
    why: 'a review note with no upper bound',
    input: (ids) => ({ proposalId: ids.proposalId, outcome: 'rejected', note: 'n'.repeat(100_000) }),
  },
  {
    command: 'dispute.review',
    as: 'admin',
    why: 'a review note that is not a string is trimmed',
    input: (ids) => ({ disputeId: ids.disputeId, outcome: 'declined', note: 7 }),
  },
  {
    command: 'dispute.review',
    as: 'admin',
    why: 'a review note with no upper bound',
    input: (ids) => ({ disputeId: ids.disputeId, outcome: 'declined', note: 'n'.repeat(100_000) }),
  },
  {
    command: 'case.transition',
    as: 'org staff',
    why: 'a closure note that is not a string is trimmed',
    input: (ids) => ({ caseId: ids.caseId, to: 'closed', note: 7 }),
  },
  {
    command: 'case.transition',
    as: 'org staff',
    why: 'a closure note with no upper bound',
    input: (ids) => ({ caseId: ids.caseId, to: 'closed', note: 'n'.repeat(100_000) }),
  },
  {
    command: 'safety.applyModerationAction',
    as: 'admin',
    why: 'an action outside the enum takes no branch, yet still closes every open report',
    input: (ids) => ({ targetType: 'experience', targetId: ids.experienceId, action: 'obliterate', reason: 'spam' }),
  },
  {
    command: 'safety.applyModerationAction',
    as: 'admin',
    why: 'a target type outside the enum resolves as a reply and then loads an experience',
    input: (ids) => ({ targetType: 'planet', targetId: ids.experienceId, action: 'remove', reason: 'spam' }),
  },
  {
    command: 'safety.applyModerationAction',
    as: 'admin',
    why: 'a moderation action with no reason recorded',
    input: (ids) => ({ targetType: 'experience', targetId: ids.experienceId, action: 'remove' }),
  },
  {
    command: 'safety.fileReport',
    as: 'author',
    // Found only against Postgres, because `reports.target_type` is an enum and the
    // in-memory store took the bad value without complaint.
    why: 'a target type outside the enum reaches the row, and the column is an enum',
    input: (ids) => ({ targetType: 'planet', targetId: ids.experienceId, reasonCode: 'spam' }),
  },
];

test('each named invalid field is refused by the check that owns it', async () => {
  const failures: string[] = [];
  for (const named of NAMED_CASES) {
    // A fresh world per case: several of these commands mutate on success, and a
    // case that shares a world with an earlier one is testing the earlier one's
    // leftovers instead of its own field.
    const world = await seedWorld();
    const actor = world.actors.find((candidate) => candidate.label === named.as);
    assert.ok(actor, `no ${named.as} in the seeded world`);
    const result = await world.h.engine.bus.dispatch({
      name: named.command,
      input: named.input(world.ids),
      actor: actor.actor,
      idempotencyKey: world.h.nextKey(),
    });
    if (result.ok) {
      failures.push(`${named.command} ACCEPTED it — ${named.why}`);
    } else if (!CALLER_FAILURE_KINDS.has(result.error.kind)) {
      failures.push(`${named.command} → ${describe(result.error)} — ${named.why}`);
    }
  }
  assert.deepEqual(failures, [], `each of these must be a governed refusal:\n${failures.join('\n')}`);
});

test('a claim with no display name is accepted, and takes the name the entity already has', async () => {
  // The inverse of the case above, asserted rather than assumed: guarding the type of
  // `displayName` must not have made it required. An organization claiming itself has
  // no obligation to rename itself in the act of claiming.
  const world = await seedWorld();
  const author = world.actors[0];
  assert.ok(author);
  const result = await world.h.engine.bus.dispatch<unknown, { organizationId: string; status: string }>({
    name: 'organization.claim',
    input: { entityId: world.ids.entityId },
    actor: author.actor,
    idempotencyKey: world.h.nextKey(),
  });
  assert.ok(result.ok, `a nameless claim is allowed: ${result.ok ? '' : describe(result.error)}`);
  const profile = await world.h.engine.store.organizationProfiles.get(result.value.organizationId);
  assert.equal(profile?.displayName, 'Southwind Rail');
  assert.equal(profile?.status, 'pending', 'a claim is a request, not a grant');
});

// ── Atomicity: a refusal is a no-op ────────────────────────────────────────
//
// A governed refusal that had already appended an event, written half a row or
// consumed the idempotency key would be worse than a throw, because it would be
// invisible. These assert the refusal costs nothing.

/** Row counts across every table, so "nothing was written" is checkable in one value. */
const censusOf = async (h: EngineHarness): Promise<Readonly<Record<string, number>>> => {
  const census: Record<string, number> = {};
  for (const [name, table] of Object.entries(h.engine.store as unknown as Record<string, unknown>)) {
    const candidate = table as { count?: () => Promise<number> };
    if (typeof candidate.count === 'function') census[name] = await candidate.count();
  }
  return census;
};

test('a malformed command writes no row and appends no event', async () => {
  const world = await seedWorld();
  const { h } = world;
  await h.settle();

  const before = await censusOf(h);
  const eventsBefore = (await h.engine.outbox.all()).length;

  for (const command of h.engine.bus.registeredCommands()) {
    // `creator.requestExport` is declared as `Record<string, never>`: it takes no
    // fields at all, so an object with the wrong fields in it is not a malformed
    // call to that command — it is a valid one with extra keys. Excluded because it
    // legitimately succeeds, not because it is allowed to write on a refusal.
    if (command === 'creator.requestExport') continue;
    for (const { input } of MALFORMED_INPUTS) {
      for (const { actor } of world.actors) {
        await h.engine.bus.dispatch({ name: command, input, actor, idempotencyKey: h.nextKey() });
      }
    }
  }

  assert.deepEqual(await censusOf(h), before, 'no table changed');
  assert.equal((await h.engine.outbox.all()).length, eventsBefore, 'no event was appended');
});

test('a refusal is not retryable and carries no stack trace', async () => {
  const world = await seedWorld();
  const leaks: string[] = [];
  for (const named of NAMED_CASES) {
    const actor = world.actors.find((candidate) => candidate.label === named.as);
    assert.ok(actor);
    const result = await world.h.engine.bus.dispatch({
      name: named.command,
      input: named.input(world.ids),
      actor: actor.actor,
      idempotencyKey: world.h.nextKey(),
    });
    if (result.ok) continue;
    // A malformed request is not transient: replaying it produces the same refusal,
    // so a retry is wasted work and a queue that never drains.
    if (result.error.retryable) leaks.push(`${named.command} is retryable`);
    // `cause` is where a wrapped throw puts the original message. A refusal the code
    // made deliberately has none, and a caller must never be handed internals.
    const serialised = JSON.stringify(result.error);
    if (serialised.includes('\\n    at ') || serialised.includes('cause')) {
      leaks.push(`${named.command} leaks internals: ${serialised.slice(0, 120)}`);
    }
  }
  assert.deepEqual(leaks, [], leaks.join('\n'));
});

test('a malformed envelope is refused rather than taking the process down', async () => {
  // `actor.actorId` is read while building the command logger — before the try block
  // that turns a throw into an error result. An envelope with no actor therefore used
  // to raise past `dispatch` entirely, which in a worker draining commands is not a
  // failed command but a dead worker.
  const h = sweepHarness();
  const cases: readonly { readonly label: string; readonly envelope: unknown }[] = [
    { label: 'no actor', envelope: { name: 'experience.create', input: {}, idempotencyKey: 'k1' } },
    { label: 'null actor', envelope: { name: 'experience.create', input: {}, actor: null, idempotencyKey: 'k2' } },
    {
      label: 'actor with no id',
      envelope: { name: 'experience.create', input: {}, actor: { role: 'member' }, idempotencyKey: 'k3' },
    },
    {
      label: 'no idempotency key',
      envelope: { name: 'experience.create', input: {}, actor: { actorId: 'a', role: 'member' } },
    },
    {
      label: 'empty idempotency key',
      envelope: { name: 'experience.create', input: {}, actor: { actorId: 'a', role: 'member' }, idempotencyKey: '' },
    },
  ];

  for (const { label, envelope } of cases) {
    const result = await h.engine.bus.dispatch(envelope as Parameters<typeof h.engine.bus.dispatch>[0]);
    assert.ok(!result.ok, `${label} must be refused`);
    assert.equal(result.error.kind, 'validation', `${label} → ${describe(result.error)}`);
  }

  // And the bus still works afterwards, which is the actual claim.
  const { actor } = await h.signUp('after@example.com');
  const created = await h.engine.bus.dispatch({
    name: 'experience.create',
    input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: 'still working', visibility: 'public' },
    actor,
    idempotencyKey: h.nextKey(),
  });
  assert.ok(created.ok, 'the bus survived');
});

// ── The structural guard ───────────────────────────────────────────────────
//
// Two properties keep this file honest as the command surface grows, and neither is
// a pattern match over source text — which would either miss the next shape of the
// defect or block a legitimate line.
//
//   1. The command list comes from `registeredCommands()`. A command registered
//      tomorrow is swept tomorrow, with no list to remember to update — the same
//      reasoning that replaced the Phase 48 filename list with discovery.
//   2. `command.threw` is the operator-facing signal that something is broken. The
//      assertion is on that counter directly: a bad request must never move it.

test('the whole malformed sweep leaves command.threw at zero', async () => {
  const world = await seedWorld();
  const { h } = world;

  for (const command of h.engine.bus.registeredCommands()) {
    for (const { input } of MALFORMED_INPUTS) {
      for (const { actor } of world.actors) {
        await h.engine.bus.dispatch({ name: command, input, actor, idempotencyKey: h.nextKey() });
      }
    }
    for (const { fields } of INVALID_VALUES) {
      for (const { actor } of world.actors) {
        await h.engine.bus.dispatch({
          name: command,
          input: { ...world.ids, ...fields },
          actor,
          idempotencyKey: h.nextKey(),
        });
      }
    }
  }

  const threw = Object.entries(h.engine.metrics.snapshot().counters).filter(([name]) =>
    name.startsWith('command.threw'),
  );
  assert.deepEqual(threw, [], `a bad request must not register as a defect:\n${JSON.stringify(threw, null, 2)}`);
});

test('a refused command leaves its idempotency key unused', async () => {
  // The shape guard runs ahead of the reservation, so a caller whose first attempt was
  // malformed can fix it and retry under the same key. Reserving first would have made
  // one typo permanently poison that key, and the recorded rejection would replay
  // forever.
  const h = sweepHarness();
  const { actor } = await h.signUp('retry@example.com');
  const key = 'the-same-key';

  const first = await h.engine.bus.dispatch({ name: 'experience.create', input: undefined, actor, idempotencyKey: key });
  assert.ok(!first.ok);
  assert.equal(first.error.kind, 'validation');

  const second = await h.engine.bus.dispatch({
    name: 'experience.create',
    input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: 'corrected', visibility: 'public' },
    actor,
    idempotencyKey: key,
  });
  assert.ok(second.ok, `the corrected command runs: ${second.ok ? '' : describe(second.error)}`);
});
