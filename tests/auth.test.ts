import assert from 'node:assert/strict';
import test from 'node:test';
import { checkAuth, isLiteralLoopback } from '../lib/auth';

const AUTH_ENV_KEYS = ['DOCSHELL_TOKEN', 'DOCSHELL_BIND_GUARD', 'DOCSHELL_BIND_HOST', 'DOCSHELL_BIND_PORT'] as const;

function withAuthEnv(values: Partial<Record<(typeof AUTH_ENV_KEYS)[number], string>>, run: () => void): void {
  const previous = new Map(AUTH_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of AUTH_ENV_KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function localRequest(url = 'http://127.0.0.1:3010/api/chat', origin = 'http://127.0.0.1:3010'): Request {
  const originUrl = new URL(origin);
  return new Request(url, {
    method: 'POST',
    headers: {
      host: originUrl.host,
      origin,
      'sec-fetch-site': 'same-origin',
    },
  });
}

test('token mode accepts only the configured token', () => {
  withAuthEnv({ DOCSHELL_TOKEN: 'test-token' }, () => {
    assert.equal(checkAuth(new Request('http://example.test/api/chat', {
      method: 'POST',
      headers: { 'x-docshell-token': 'test-token' },
    })), null);
    assert.equal(checkAuth(new Request('http://example.test/api/chat', {
      method: 'POST',
      headers: { 'x-docshell-token': 'wrong-token' },
    }))?.status, 401);
  });
});

test('no-token mode rejects spoofable headers when bind attestation is absent', () => {
  withAuthEnv({}, () => {
    const request = new Request('http://127.0.0.1:3010/api/chat', {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:3010',
        'sec-fetch-site': 'same-origin',
        'x-forwarded-for': '127.0.0.1',
        'x-real-ip': '127.0.0.1',
      },
    });
    assert.equal(checkAuth(request)?.status, 503);
  });
});

test('no-token mode rejects an attested non-loopback bind', () => {
  withAuthEnv({ DOCSHELL_BIND_GUARD: 'loopback-bind-v1', DOCSHELL_BIND_HOST: '0.0.0.0', DOCSHELL_BIND_PORT: '3010' }, () => {
    assert.equal(checkAuth(localRequest())?.status, 503);
  });
});

test('no-token mode rejects missing or invalid bind-port attestation', () => {
  withAuthEnv({ DOCSHELL_BIND_GUARD: 'loopback-bind-v1', DOCSHELL_BIND_HOST: '127.0.0.1' }, () => {
    assert.equal(checkAuth(localRequest())?.status, 503);
  });
  withAuthEnv({ DOCSHELL_BIND_GUARD: 'loopback-bind-v1', DOCSHELL_BIND_HOST: '127.0.0.1', DOCSHELL_BIND_PORT: '65536' }, () => {
    assert.equal(checkAuth(localRequest())?.status, 503);
  });
});

test('guarded literal IPv4 and IPv6 loopback requests are accepted', () => {
  withAuthEnv({ DOCSHELL_BIND_GUARD: 'loopback-bind-v1', DOCSHELL_BIND_HOST: '127.0.0.1', DOCSHELL_BIND_PORT: '3010' }, () => {
    assert.equal(checkAuth(localRequest()), null);
  });
  withAuthEnv({ DOCSHELL_BIND_GUARD: 'loopback-bind-v1', DOCSHELL_BIND_HOST: '::1', DOCSHELL_BIND_PORT: '3010' }, () => {
    assert.equal(checkAuth(localRequest('http://[::1]:3010/api/chat', 'http://[::1]:3010')), null);
  });
});

test('guarded no-token mode still rejects missing, cross-origin, and cross-site browser requests', () => {
  withAuthEnv({ DOCSHELL_BIND_GUARD: 'loopback-bind-v1', DOCSHELL_BIND_HOST: '127.0.0.1', DOCSHELL_BIND_PORT: '3010' }, () => {
    assert.equal(checkAuth(new Request('http://127.0.0.1:3010/api/chat', { method: 'POST' }))?.status, 403);
    assert.equal(checkAuth(localRequest('http://127.0.0.1:3010/api/chat', 'http://evil.example'))?.status, 403);
    assert.equal(checkAuth(new Request('http://127.0.0.1:3010/api/chat', {
      method: 'POST',
      headers: { host: '127.0.0.1:3010', origin: 'http://127.0.0.1:3010', 'sec-fetch-site': 'cross-site' },
    }))?.status, 403);
    assert.equal(checkAuth(new Request('http://127.0.0.1:3010/api/chat', {
      method: 'POST',
      headers: { host: '127.0.0.1:9999', origin: 'http://127.0.0.1:3010' },
    }))?.status, 403);
  });
});

test('only literal loopback addresses are recognized', () => {
  assert.equal(isLiteralLoopback('127.0.0.1'), true);
  assert.equal(isLiteralLoopback('::1'), true);
  assert.equal(isLiteralLoopback('[::1]'), true);
  assert.equal(isLiteralLoopback('localhost'), false);
  assert.equal(isLiteralLoopback('127.0.0.2'), false);
  assert.equal(isLiteralLoopback('0.0.0.0'), false);
});
