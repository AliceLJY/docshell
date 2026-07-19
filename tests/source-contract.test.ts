import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('browser source accepts fragment tokens only and describes local persistence truthfully', async () => {
  const source = await readFile(join(repoRoot, 'app', 'page.tsx'), 'utf8');
  assert.match(source, /location\.hash\.startsWith\('#token='\)/);
  assert.doesNotMatch(source, /searchParams\.get\(['"]token['"]\)/);
  assert.doesNotMatch(source, /已保存到云端/);
  assert.match(source, /已保存在本机浏览器/);
});

test('chat streaming forwards a discovered session id before waiting for turn completion', async () => {
  const source = await readFile(join(repoRoot, 'app', 'api', 'chat', 'route.ts'), 'utf8');
  const earlySendAt = source.indexOf('sendSession(parsed.sessionId);');
  const completionAt = source.indexOf('.then(({ sessionId }) =>');
  assert.notEqual(earlySendAt, -1);
  assert.notEqual(completionAt, -1);
  assert.ok(earlySendAt < completionAt);
});
