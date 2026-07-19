import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MAX_PROCESSES,
  parseMaxProcesses,
  selectIdleProcessForEviction,
  sessionIdForRestart,
} from '../lib/process-policy';

test('process limits accept only bounded positive integers', () => {
  assert.equal(parseMaxProcesses(undefined), DEFAULT_MAX_PROCESSES);
  assert.equal(parseMaxProcesses('1'), 1);
  assert.equal(parseMaxProcesses('64'), 64);
  for (const raw of ['', '0', '-1', '1.5', '65', 'many']) {
    assert.equal(parseMaxProcesses(raw), DEFAULT_MAX_PROCESSES, raw);
  }
});

test('capacity eviction chooses the least-recently-used idle process only', () => {
  const entries = new Map([
    ['active-oldest', { busy: true, lastUsedAt: 1 }],
    ['idle-recent', { busy: false, lastUsedAt: 30 }],
    ['idle-oldest', { busy: false, lastUsedAt: 10 }],
  ]);
  assert.equal(selectIdleProcessForEviction(entries), 'idle-oldest');
  assert.equal(selectIdleProcessForEviction(new Map([
    ['active-a', { busy: true, lastUsedAt: 1 }],
    ['active-b', { busy: true, lastUsedAt: 2 }],
  ])), undefined);
});

test('effort restarts prefer the live process session over request state', () => {
  assert.equal(sessionIdForRestart('live-session', undefined), 'live-session');
  assert.equal(sessionIdForRestart('live-session', 'stale-request-session'), 'live-session');
  assert.equal(sessionIdForRestart('', 'persisted-session'), 'persisted-session');
  assert.equal(sessionIdForRestart('', undefined), undefined);
});
