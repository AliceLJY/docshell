import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rmdir, stat, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cleanupTempFiles, saveTempFiles } from '../lib/temp-files';

const validFile = {
  mediaType: 'text/plain',
  base64: Buffer.from('first file').toString('base64'),
};

test('saveTempFiles removes earlier files when a later item fails', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'docshell-temp-test-'));
  try {
    await assert.rejects(
      saveTempFiles([validFile, { mediaType: 'application/x-unsupported', base64: 'YQ==' }], tempDir),
      /Unsupported media type/,
    );
    assert.deepEqual(await readdir(tempDir), []);
  } finally {
    await rmdir(tempDir);
  }
});

test('successful temporary files can be cleaned up deterministically', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'docshell-temp-test-'));
  try {
    const paths = await saveTempFiles([validFile], tempDir);
    assert.equal(paths.length, 1);
    assert.equal((await readdir(tempDir)).length, 1);
    assert.equal((await stat(tempDir)).mode & 0o777, 0o700);
    assert.equal((await stat(paths[0])).mode & 0o777, 0o600);
    await cleanupTempFiles(paths);
    assert.deepEqual(await readdir(tempDir), []);
  } finally {
    await rmdir(tempDir);
  }
});

test('temporary upload directories reject symlinks and invalid base64', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docshell-temp-root-'));
  const target = join(root, 'target');
  const link = join(root, 'link');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, link);
  try {
    await assert.rejects(saveTempFiles([validFile], link), /symbolic link/);
    await assert.rejects(
      saveTempFiles([{ mediaType: 'text/plain', base64: 'YQ=' }], target),
      /Invalid base64 data/,
    );
  } finally {
    await unlink(link);
    await rmdir(target);
    await rmdir(root);
  }
});
