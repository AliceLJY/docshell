import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_MESSAGE_LENGTH, validateRequestPayload } from '../lib/request-validation';

test('request validation accepts the implemented model and bounded identifiers', () => {
  const result = validateRequestPayload({
    conversationId: 'doc-123',
    ccSessionId: 'session_abc-123',
    model: 'opus',
    effort: 'max',
    message: 'hello',
    images: [],
  });
  assert.equal(result.ok, true);
});

test('request validation rejects malformed, oversized, and unimplemented fields', () => {
  for (const payload of [
    null,
    [],
    { conversationId: '../escape', model: 'opus' },
    { conversationId: 'doc-1', model: 'sonnet' },
    { conversationId: 'doc-1', effort: 'extreme' },
    { conversationId: 'doc-1', message: { text: 'not a string' } },
    { conversationId: 'doc-1', message: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) },
    { conversationId: 'doc-1', images: {} },
  ]) {
    assert.equal(validateRequestPayload(payload).ok, false, JSON.stringify(payload)?.slice(0, 100));
  }
});
