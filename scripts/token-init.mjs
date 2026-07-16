#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const envFile = process.env.DOCSHELL_ENV_FILE || join(process.cwd(), '.env.local');

async function main() {
  let existing = '';
  try {
    existing = await readFile(envFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const newline = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.split(/\r?\n/).filter((line) => !line.startsWith('DOCSHELL_TOKEN='));
  while (lines.at(-1) === '') lines.pop();

  const token = randomBytes(32).toString('hex');
  lines.push(`DOCSHELL_TOKEN=${token}`);
  const nextContents = `${lines.join(newline)}${newline}`;
  const temporaryFile = `${envFile}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;

  try {
    await writeFile(temporaryFile, nextContents, { flag: 'wx', mode: 0o600 });
    await chmod(temporaryFile, 0o600);
    await rename(temporaryFile, envFile);
    await chmod(envFile, 0o600);
  } catch (error) {
    await unlink(temporaryFile).catch(() => {});
    throw error;
  }

  let clipboardCopied = false;
  if (process.env.DOCSHELL_SKIP_CLIPBOARD !== '1' && process.platform === 'darwin') {
    clipboardCopied = await new Promise((resolve) => {
      const pbcopy = spawn('/usr/bin/pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
      let settled = false;
      const finish = (copied) => {
        if (settled) return;
        settled = true;
        resolve(copied);
      };
      pbcopy.once('error', () => finish(false));
      pbcopy.once('close', (exitCode) => finish(exitCode === 0));
      pbcopy.stdin.end(token);
    });
  }

  console.log(
    clipboardCopied
      ? `[docshell] DOCSHELL_TOKEN updated in ${envFile} and copied to the clipboard.`
      : `[docshell] DOCSHELL_TOKEN updated in ${envFile}; clipboard copy unavailable or skipped.`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[docshell] token initialization failed: ${message}`);
  process.exitCode = 1;
});
