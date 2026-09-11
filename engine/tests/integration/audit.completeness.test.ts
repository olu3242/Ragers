import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import {
  AUDITED_COMMANDS,
  AUDIT_ACTIONS,
  AUDIT_EXEMPTIONS,
  AUDIT_REASONS,
  AUDIT_RULE,
  auditIsAModerationDecision,
  auditRationale,
  auditReachesATrustScore,
  isAudited,
  UNAUDITED_COMMANDS,
} from '../../src/domain/audit-rule.ts';

/**
 * Phase 68 — the rule, and the coverage that follows from it.
 *
 * The guard here is by discovery over `bus.registeredCommands()`, in the Phase 48 pattern.
 * A hand-maintained list of audited commands rots the first time somebody adds one, and
 * "audit privileged things" is not a checkable statement. Enumerating the bus means a
 * command registered tomorrow is classified tomorrow or the suite goes red.
 */
const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = join(here, '..', '..');
test('every registered command is classified, and none is classified twice', () => {
  // The property that makes the rule exhaustive rather than aspirational: a new command
  // cannot land in neither map, so nobody can add a privileged action and leave the
  // question of whether it should be audited unanswered.
  const h = createEngineHarness();
  const commands = h.engine.bus.registeredCommands();
  assert.ok(commands.length > 40, `the bus has its commands (${commands.length})`);

  const unclassified = commands.filter((name) => auditRationale(name) === undefined);
  assert.deepEqual(unclassified, [], 'every command says whether it is audited and why');

  const both = commands.filter(
    (name) => AUDITED_COMMANDS[name] !== undefined && UNAUDITED_COMMANDS[name] !== undefined,
  );
  assert.deepEqual(both, [], 'and no command is both audited and exempt');
});

test('the classification names no command the bus does not have', () => {
  // The other direction. A table entry for a command that no longer exists is a rule
  // nobody is enforcing, and it reads as coverage.
  const h = createEngineHarness();
  const registered = new Set(h.engine.bus.registeredCommands());
  const stale = [...Object.keys(AUDITED_COMMANDS), ...Object.keys(UNAUDITED_COMMANDS)].filter(
    (name) => !registered.has(name),
  );
  assert.deepEqual(stale, [], 'the tables describe the bus as it is');
});

test('every audited command names a real clause, and every exemption a real reason', () => {
  for (const [command, reason] of Object.entries(AUDITED_COMMANDS)) {
    assert.ok(AUDIT_REASONS.includes(reason), `${command} cites a clause of the rule`);
  }
  for (const [command, exemption] of Object.entries(UNAUDITED_COMMANDS)) {
    assert.ok(AUDIT_EXEMPTIONS.includes(exemption), `${command} cites a real exemption`);
  }
});

test('no recomputation, projection or counter is audited', () => {
  // The failure this rule exists to prevent. A trail carrying `feed.project` and
  // `counters.recompute` buries the four rows somebody actually needs, and the only time
  // anybody reads an audit trail is the one time it matters.
  const noise = Object.keys(AUDITED_COMMANDS).filter((name) =>
    /\.(recompute|project|purge|index|fanout|ingest|cascade|counters|expire)$/.test(name),
  );
  assert.deepEqual(noise, [], 'an audit of everything is an audit of nothing');
});

test('every action a staff member takes about somebody else is audited', () => {
  // The clause the trail exists for, checked against the commands that carry a staff-only
  // action rather than against the list of things somebody remembered to audit.
  const mustBeAudited = [
    'safety.applyModerationAction',
    'governance.grantRole',
    'dispute.review',
    'proposal.decide',
    'case.assign',
    'case.transition',
    'evidence.assess',
  ];
  for (const command of mustBeAudited) {
    assert.equal(isAudited(command), true, `${command} is a privileged action about somebody else`);
  }
});

test('every irreversible destruction of a record is audited, because the event is what survives', () => {
  // Phase 64's rule, as a clause of this one: erasing the record that an erasure happened
  // is not erasure, it is amnesia.
  for (const command of ['creator.deleteExperience', 'conversation.deleteReply', 'creator.requestExport']) {
    assert.equal(isAudited(command), true, `${command} destroys or exports and must leave a trace`);
  }
});

test('your own ordinary action on your own content is not audited', () => {
  // The row carries your id already. A second copy in the trail is the same fact stored
  // twice, and the copy is the one that drifts.
  for (const command of ['experience.create', 'reaction.toggle', 'conversation.createReply']) {
    assert.equal(isAudited(command), false, `${command} is already attributable from its own row`);
  }
});

test('the rule is stated in one sentence somebody can disagree with', () => {
  assert.match(AUDIT_RULE, /under authority about somebody else/);
  assert.match(AUDIT_RULE, /changes what somebody else may do/);
  assert.match(AUDIT_RULE, /irreversibly destroys or exports/);
});

test('an audit event is a record, not a judgement', () => {
  // A trail that fed a trust score would turn "we keep records" into "we keep a file on
  // you", which is a different product.
  assert.equal(auditReachesATrustScore(), undefined);
  assert.equal(auditIsAModerationDecision(), false);
});

test('a source sweep finds no audited command whose engine never calls writeAudit', () => {
  // The rule is only worth having if it is enforced against the code rather than against a
  // list. This is the enforcement: for every command the rule audits, the engine module
  // that registers it must call `writeAudit` with that command's own action name.
  //
  // Matching on the action string rather than merely on the presence of a call, because an
  // engine with three audited commands and one `writeAudit` would otherwise pass while two
  // of them wrote nothing. That is exactly the shape of gap this phase found.
  const engines = join(engineRoot, 'src', 'engines');
  const sources = new Map<string, string>();
  for (const name of readdirSync(engines).filter((file) => file.endsWith('.engine.ts'))) {
    sources.set(name, readFileSync(join(engines, name), 'utf8'));
  }

  const missing: string[] = [];
  for (const command of Object.keys(AUDITED_COMMANDS)) {
    // Ownership is "this module registers this command", and there is more than one way to
    // write that. `name: 'x'` is the common shape; a factory that registers several related
    // commands passes the name as an argument instead — which is the *safer* shape when they
    // share one audited path, because five copies of one handler are five things that can
    // drift. So ownership matches the command name as a quoted literal, and a module only
    // counts if it actually registers commands.
    //
    // The assertion below is unchanged: whichever module owns it must still call `writeAudit`
    // with that command's own declared action. Broadening how ownership is *found* does not
    // loosen what the owner has to do.
    const owner = [...sources.entries()].find(
      ([, source]) =>
        source.includes('deps.bus.register') &&
        (source.includes(`name: '${command}'`) || source.includes(`'${command}'`)),
    );
    if (!owner) {
      missing.push(`${command} (no engine registers it)`);
      continue;
    }
    // Checked against the declared vocabulary, not against the command name. `AUDIT_ACTIONS`
    // is the single place the action strings are decided, and `moderation.` is a prefix
    // because that command records which action was taken rather than a flat verb.
    const [, source] = owner;
    const action = AUDIT_ACTIONS[command];
    if (action === undefined) {
      missing.push(`${command} (no declared audit action)`);
      continue;
    }
    const auditsIt = new RegExp(`action: [\`']${action.replace('.', '\\.')}`).test(source);
    if (!auditsIt) missing.push(`${command} (in ${owner[0]}, expected action ${action})`);
  }

  assert.deepEqual(missing, [], 'every audited command writes its own audit event');
});

test('a privileged decision leaves an attributable trail, end to end', async () => {
  // The execution check, on the gap that mattered most: deciding somebody's dispute. The
  // dispute row carries `reviewedBy`, but the next review overwrites it — so the row is the
  // current reading rather than the sequence, and only the trail can say who did what when.
  const h = createEngineHarness();
  const { actor: author } = await h.signUp('audited-author@example.com', 'Author');
  const reviewer = await h.promote((await h.signUp('audited-mod@example.com', 'Mod')).actor.actorId, 'moderator');

  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: 'The bill was wrong again.', visibility: 'public' },
      actor: author,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();

  const opened = expect(
    await h.engine.bus.dispatch<unknown, { disputeId: string }>({
      name: 'dispute.open',
      // The author is the experiencer, which is one of the two parties with standing.
      input: { experienceId: created.experienceId, reason: 'fix_not_delivered', detail: 'The charge was never reversed.' },
      actor: author,
      idempotencyKey: h.nextKey(),
    }),
    'open',
  );

  const auditsBefore = (await h.engine.store.auditEvents.all()).length;
  expect(
    await h.engine.bus.dispatch({
      name: 'dispute.review',
      input: { disputeId: opened.disputeId, outcome: 'declined', note: 'The experience describes what happened.' },
      actor: reviewer,
      idempotencyKey: h.nextKey(),
    }),
    'review',
  );

  const audits = await h.engine.store.auditEvents.all();
  assert.equal(audits.length, auditsBefore + 1, 'the review wrote exactly one audit event');
  const entry = audits.at(-1);
  assert.equal(entry?.action, 'dispute.review');
  assert.equal(entry?.resourceId, opened.disputeId);
  assert.equal(entry?.actorId, reviewer.actorId, 'and it names who decided');
  assert.deepEqual(entry?.before, { status: 'open' });
  assert.deepEqual(entry?.after, { status: 'declined' }, 'with what it became');
});

test('an unaudited command writes nothing to the trail', async () => {
  // The other half of the rule, and the one that keeps the trail readable: posting is your
  // own action on your own content, and the experience row already carries your id.
  const h = createEngineHarness();
  const { actor } = await h.signUp('unaudited@example.com', 'Plain');
  const before = (await h.engine.store.auditEvents.all()).length;
  expect(
    await h.engine.bus.dispatch({
      name: 'experience.create',
      input: { kind: 'rave', creationMode: 'text', category: 'Other', bodyText: 'The repair was done in a day.', visibility: 'public' },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();
  assert.equal((await h.engine.store.auditEvents.all()).length, before, 'nothing was added');
});
