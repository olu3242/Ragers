import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canFallBackToText,
  isRecorderTerminal,
  recorderNext,
  type RecorderEvent,
  type RecorderState,
} from '../../src/domain/voice.ts';
import { expect } from '../../src/runtime/result.ts';

const walk = (from: RecorderState, events: readonly RecorderEvent[]): RecorderState =>
  events.reduce<RecorderState>((state, event) => expect(recorderNext(state, event), `${state}+${event}`), from);

test('the golden capture path reaches submitted', () => {
  const final = walk('idle', [
    'request_permission',
    'permission_granted',
    'start',
    'pause',
    'resume',
    'stop',
    'preview',
    'submit',
  ]);
  assert.equal(final, 'submitted');
  assert.ok(isRecorderTerminal(final));
});

test('re-record returns to ready and can complete a second time', () => {
  const afterRerecord = walk('idle', [
    'request_permission',
    'permission_granted',
    'start',
    'stop',
    'preview',
    're_record',
  ]);
  assert.equal(afterRerecord, 'ready');
  assert.equal(walk(afterRerecord, ['start', 'stop', 'preview', 'submit']), 'submitted');
});

test('permission denial is recoverable and can fall back to text', () => {
  const denied = walk('idle', ['request_permission', 'permission_denied']);
  assert.equal(denied, 'permission_denied');
  assert.ok(canFallBackToText(denied), 'denial must degrade to text mode');
  assert.equal(walk(denied, ['request_permission', 'permission_granted']), 'ready', 'the user can grant later');
});

test('recording cannot start before permission is granted', () => {
  const result = recorderNext('idle', 'start');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'illegal_recorder_transition');

  const pending = recorderNext('permission_pending', 'start');
  assert.equal(pending.ok, false, 'a pending permission is not a granted one');
});

test('pause and resume are only legal in the states that support them', () => {
  assert.equal(recorderNext('ready', 'pause').ok, false);
  assert.equal(recorderNext('paused', 'pause').ok, false, 'cannot pause twice');
  assert.equal(recorderNext('recording', 'resume').ok, false, 'cannot resume while recording');
  assert.ok(recorderNext('recording', 'pause').ok);
  assert.ok(recorderNext('paused', 'resume').ok);
  assert.ok(recorderNext('paused', 'stop').ok, 'stopping from paused is legal');
});

test('submission requires a preview, so audio cannot be sent unheard', () => {
  assert.equal(recorderNext('stopped', 'submit').ok, false, 'stopped must be previewed first');
  assert.ok(recorderNext('preview', 'submit').ok);
});

test('submitted is terminal', () => {
  const events: readonly RecorderEvent[] = ['start', 'pause', 'resume', 'stop', 'preview', 're_record', 'submit', 'reset'];
  for (const event of events) {
    assert.equal(recorderNext('submitted', event).ok, false, `submitted must not accept ${event}`);
  }
});
