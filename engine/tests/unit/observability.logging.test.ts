import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryLogger, redact, REDACTED, SENSITIVE_KEYS } from '../../src/runtime/logger.ts';
import { createRuntimeHarness, member } from '../support/runtime-harness.ts';
import { ok } from '../../src/runtime/result.ts';

test('every sensitive key is redacted, at any nesting depth', () => {
  const input: Record<string, unknown> = { safe: 'keep' };
  for (const key of SENSITIVE_KEYS) input[key] = 'SECRET-VALUE';
  const nested = redact({ outer: { inner: input } }) as Record<string, Record<string, Record<string, unknown>>>;

  const leaf = nested['outer']?.['inner'] ?? {};
  assert.equal(leaf['safe'], 'keep', 'non-sensitive fields survive');
  for (const key of SENSITIVE_KEYS) {
    assert.equal(leaf[key], REDACTED, `${key} must be redacted`);
  }
  assert.equal(JSON.stringify(nested).includes('SECRET-VALUE'), false);
});

test('redaction is case-insensitive and survives arrays', () => {
  const out = redact({ items: [{ Raw_Text: 'x' }, { ORIGINAL_KEY: 'y' }] });
  assert.equal(JSON.stringify(out).includes('"x"'), false);
  assert.equal(JSON.stringify(out).includes('"y"'), false);
});

test('logger records carry the correlation id and no raw content', () => {
  const logger = createMemoryLogger({ correlationId: 'corr-1' });
  logger.info('published', { experienceId: 'exp_1', body_text: 'someone blocked the crosswalk' });
  const record = logger.records[0];
  assert.equal(record?.correlationId, 'corr-1');
  assert.equal(record?.fields['body_text'], REDACTED);
  assert.equal(JSON.stringify(record).includes('crosswalk'), false);
});

test('command logs are correlation-tagged end to end', async () => {
  const h = createRuntimeHarness();
  h.bus.register({
    name: 'test.logged',
    action: 'experience.create',
    resolveResource: async () => ok({ type: 'experience' as const, ownerActorId: member().actorId }),
    handle: async () => ok({ value: 'ok' }),
  });

  await h.bus.dispatch({
    name: 'test.logged',
    input: {},
    actor: member(),
    idempotencyKey: 'k',
    correlationId: 'corr-trace',
  });

  const tagged = h.logger.records.filter((r) => r.correlationId === 'corr-trace');
  assert.ok(tagged.length >= 1, 'the command path must emit correlation-tagged logs');
  assert.equal(tagged[0]?.fields['command'], 'test.logged');
});

test('metrics record command outcomes', async () => {
  const h = createRuntimeHarness();
  h.bus.register({
    name: 'test.metric',
    action: 'experience.create',
    resolveResource: async () => ok({ type: 'experience' as const, ownerActorId: member().actorId }),
    handle: async () => ok({ value: 'ok' }),
  });
  await h.bus.dispatch({ name: 'test.metric', input: {}, actor: member(), idempotencyKey: 'k' });
  const snapshot = h.metrics.snapshot();
  assert.equal(snapshot.counters['command.succeeded{command=test.metric}'], 1);
});
