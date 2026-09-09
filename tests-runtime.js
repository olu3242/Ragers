'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DurableIntegrityRuntime } = require('./engine/durable-runtime');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ragers-runtime-'));
const file = path.join(dir, 'state.json');

const first = new DurableIntegrityRuntime({ file });
const exp = first.submit({ actorId: 'u1', type: 'rage', text: 'Bus skipped my stop twice', topicId: 'Driving & transit', metadata: { deviceId: 'd1' } });
assert.ok(fs.existsSync(file), 'state should persist after submit');
assert.strictEqual(first.engine.experiences.size, 1);
assert.ok(first.outbox.some((e) => e.eventType === 'experience.created'));

const restarted = new DurableIntegrityRuntime({ file });
assert.strictEqual(restarted.engine.experiences.size, 1, 'experience survives restart');
assert.strictEqual(restarted.engine.getExperience(exp.id).text, 'Bus skipped my stop twice');

restarted.corroborate(exp.id, { actorId: 'u2', mode: 'same_experience' });
const afterCorroboration = new DurableIntegrityRuntime({ file });
assert.strictEqual(afterCorroboration.engine.corroborations.length, 1, 'corroboration survives restart');

const beforeEvidence = afterCorroboration.engine.getExperience(exp.id).scores.experienceConfidence;
afterCorroboration.addEvidence(exp.id, { type: 'ticket' });
const afterEvidence = afterCorroboration.engine.getExperience(exp.id).scores.experienceConfidence;
assert.ok(afterEvidence >= beforeEvidence, 'real evidence can strengthen confidence');

const queued = afterCorroboration.requestRevalidation();
assert.strictEqual(queued.queued, 1);
const evidenceCount = afterCorroboration.engine.getExperience(exp.id).evidence.length;
assert.strictEqual(evidenceCount, 1, 'revalidation request must not fabricate evidence');

const drainedOnce = afterCorroboration.drainOutbox(() => {});
assert.ok(drainedOnce.delivered >= 4, 'pending events should drain');
const drainedTwice = afterCorroboration.drainOutbox(() => {});
assert.strictEqual(drainedTwice.delivered, 0, 'outbox delivery is idempotent');

fs.rmSync(dir, { recursive: true, force: true });
console.log('runtime certification: PASS');
