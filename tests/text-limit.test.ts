import assert from 'node:assert/strict';
import test from 'node:test';
import { createLimitedTextEmitter } from '../lib/text-limit';
import type { DocEvent } from '../lib/types';

test('overflow emits the fitting prefix and one explicit truncated event', () => {
  const events: DocEvent[] = [];
  const emit = createLimitedTextEmitter((event) => events.push(event), 5);

  emit('abc');
  emit('def');
  emit('ignored');

  assert.deepEqual(events, [
    { type: 'paragraph_delta', text: 'abc' },
    { type: 'paragraph_delta', text: 'de' },
    { type: 'truncated', error: '回复达到正文上限，后续内容已截断', limitBytes: 5 },
  ]);
});

test('an exact limit is not truncated until additional text arrives', () => {
  const events: DocEvent[] = [];
  const emit = createLimitedTextEmitter((event) => events.push(event), 5);

  emit('12345');
  assert.deepEqual(events, [{ type: 'paragraph_delta', text: '12345' }]);
  emit('6');
  assert.equal(events.at(-1)?.type, 'truncated');
});

test('UTF-8 truncation never splits a multi-byte character', () => {
  const events: DocEvent[] = [];
  const emit = createLimitedTextEmitter((event) => events.push(event), 4);

  emit('你你');

  assert.equal(events[0]?.type, 'paragraph_delta');
  assert.equal(events[0]?.type === 'paragraph_delta' ? events[0].text : '', '你');
  assert.equal(events[1]?.type, 'truncated');
});

test('invalid text limits fail immediately', () => {
  assert.throws(() => createLimitedTextEmitter(() => {}, -1), RangeError);
  assert.throws(() => createLimitedTextEmitter(() => {}, 1.5), RangeError);
});
