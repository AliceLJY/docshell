import assert from 'node:assert/strict';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { runTurn, shutdownAllProcesses } from '../lib/cc-process';
import type { ParsedChunk } from '../lib/stream-parser';

test('session ids surface before result and survive an effort restart without request state', async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), 'docshell-fake-claude-'));
  const fakeClaude = join(fakeBin, 'claude');
  const invocationLog = join(fakeBin, 'invocations.jsonl');
  const originalPath = process.env.PATH;
  const originalLog = process.env.FAKE_CLAUDE_LOG;

  await writeFile(fakeClaude, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + '\\n');
const resumeAt = args.indexOf('--resume');
const resumed = resumeAt >= 0 ? args[resumeAt + 1] : '';
const sessionId = resumed || 'session-original';
let firstInput = true;
readline.createInterface({ input: process.stdin }).on('line', () => {
  if (resumed && firstInput) {
    console.log(JSON.stringify({ type: 'result', session_id: sessionId, result: 'synthetic' }));
  }
  firstInput = false;
  console.log(JSON.stringify({ type: 'system', session_id: sessionId }));
  console.log(JSON.stringify({ type: 'result', session_id: sessionId, result: 'done' }));
});
`, { mode: 0o700 });

  process.env.PATH = `${fakeBin}${delimiter}${originalPath || ''}`;
  process.env.FAKE_CLAUDE_LOG = invocationLog;
  try {
    const firstChunks: ParsedChunk[] = [];
    const first = await runTurn({
      conversationId: 'effort-restart-test',
      prompt: 'first',
      effort: 'low',
      onChunk: (chunk) => firstChunks.push(chunk),
    });
    assert.equal(first.sessionId, 'session-original');
    const sessionIndex = firstChunks.findIndex((chunk) => chunk.kind === 'session_id');
    const resultIndex = firstChunks.findIndex((chunk) => chunk.kind === 'result');
    assert.notEqual(sessionIndex, -1);
    assert.ok(resultIndex > sessionIndex, 'session id must be observable before the turn result');

    const second = await runTurn({
      conversationId: 'effort-restart-test',
      prompt: 'second',
      effort: 'high',
      // Deliberately omit resumeSessionId: the live process already knows the canonical id.
      onChunk: () => {},
    });
    assert.equal(second.sessionId, 'session-original');

    const invocations = (await readFile(invocationLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(invocations.length, 2);
    assert.deepEqual(invocations[1].slice(0, 2), ['--resume', 'session-original']);
    const effortAt = invocations[1].indexOf('--effort');
    assert.equal(invocations[1][effortAt + 1], 'high');
  } finally {
    shutdownAllProcesses();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.FAKE_CLAUDE_LOG;
    else process.env.FAKE_CLAUDE_LOG = originalLog;
    await unlink(fakeClaude);
    try { await unlink(invocationLog); } catch { /* child did not start */ }
    await rmdir(fakeBin);
  }
});
