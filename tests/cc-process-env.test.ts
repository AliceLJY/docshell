import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClaudeEnv } from '../lib/cc-process';

test('Claude child processes never inherit DocShell server auth or bind variables', () => {
  const childEnv = buildClaudeEnv({
    NODE_ENV: 'test',
    HOME: '/tmp/test-home',
    PATH: '/usr/bin',
    DOCSHELL_TOKEN: 'server-only-secret',
    DOCSHELL_BIND_GUARD: 'loopback-bind-v1',
    DOCSHELL_BIND_HOST: '127.0.0.1',
    DOCSHELL_BIND_PORT: '3010',
    DOCSHELL_FUTURE_SECRET: 'must-also-be-removed',
  });

  assert.equal(childEnv.HOME, '/tmp/test-home');
  assert.equal(childEnv.PATH, '/usr/bin');
  assert.equal(childEnv.LANG, 'en_US.UTF-8');
  assert.equal(Object.keys(childEnv).some((key) => key.startsWith('DOCSHELL_')), false);
  assert.equal(JSON.stringify(childEnv).includes('server-only-secret'), false);
});
