import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guardPath = join(repoRoot, 'scripts', 'check-bind.mjs');
const tokenInitPath = join(repoRoot, 'scripts', 'token-init.mjs');
const privateLogPath = join(repoRoot, 'scripts', 'private-log.sh');

function runGuard(envRoot: string, host: string, token?: string, port = '3010') {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
  delete env.DOCSHELL_TOKEN;
  if (token !== undefined) env.DOCSHELL_TOKEN = token;
  return spawnSync(process.execPath, [guardPath, envRoot, host, port, 'production'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

test('no-token startup permits only literal IPv4 or IPv6 loopback', () => {
  const emptyEnvRoot = join(tmpdir(), `docshell-no-env-${process.pid}`);
  assert.equal(runGuard(emptyEnvRoot, '127.0.0.1').status, 0);
  assert.equal(runGuard(emptyEnvRoot, '::1').status, 0);

  for (const host of ['0.0.0.0', '::', '192.168.1.20', 'localhost']) {
    const result = runGuard(emptyEnvRoot, host);
    assert.equal(result.status, 1, host);
    assert.match(result.stderr, /refusing to bind/);
  }
});

test('a process token permits a network bind without printing the token', () => {
  const token = 'fixture-secret-with-at-least-32-characters';
  const result = runGuard(join(tmpdir(), `docshell-no-env-${process.pid}`), '0.0.0.0', token);
  assert.equal(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);
});

test('network startup rejects a short token without printing it', () => {
  const token = 'too-short';
  const result = runGuard(join(tmpdir(), `docshell-no-env-${process.pid}`), '0.0.0.0', token);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at least 32 characters/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);
});

test('the launch guard rejects invalid ports before Next starts', () => {
  const emptyEnvRoot = join(tmpdir(), `docshell-no-env-${process.pid}`);
  for (const port of ['0', '65536', 'not-a-port']) {
    assert.equal(runGuard(emptyEnvRoot, '127.0.0.1', undefined, port).status, 1, port);
  }
});

test('the guard reads DOCSHELL_TOKEN with Next environment semantics', async () => {
  const envRoot = await mkdtemp(join(tmpdir(), 'docshell-guard-'));
  const envFile = join(envRoot, '.env.local');
  try {
    await writeFile(envFile, 'DOCSHELL_TOKEN=fixture-from-env-with-at-least-32-characters\n');
    const result = runGuard(envRoot, '0.0.0.0');
    assert.equal(result.status, 0);
    assert.equal(`${result.stdout}${result.stderr}`.includes('fixture-from-env-with-at-least-32-characters'), false);
  } finally {
    await unlink(envFile);
    await rmdir(envRoot);
  }
});

test('token initializer preserves other settings, removes duplicates, and never prints the token', async () => {
  const envRoot = await mkdtemp(join(tmpdir(), 'docshell-token-init-'));
  const envFile = join(envRoot, '.env.local');
  try {
    await writeFile(envFile, 'DOCSHELL_NO_REMOTE_CONTROL=1\nDOCSHELL_TOKEN=old-one\nDOCSHELL_TOKEN=old-two\n');
    const result = spawnSync(process.execPath, [tokenInitPath], {
      cwd: repoRoot,
      env: { ...process.env, DOCSHELL_ENV_FILE: envFile, DOCSHELL_SKIP_CLIPBOARD: '1' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);

    const contents = await readFile(envFile, 'utf8');
    const tokenLines = contents.split(/\r?\n/).filter((line) => line.startsWith('DOCSHELL_TOKEN='));
    assert.equal(tokenLines.length, 1);
    assert.match(tokenLines[0], /^DOCSHELL_TOKEN=[a-f0-9]{64}$/);
    assert.match(contents, /^DOCSHELL_NO_REMOTE_CONTROL=1$/m);
    assert.equal((await stat(envFile)).mode & 0o777, 0o600);
    const token = tokenLines[0].slice('DOCSHELL_TOKEN='.length);
    assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);
  } finally {
    await unlink(envFile);
    await rmdir(envRoot);
  }
});

test('both production launchers source and invoke the same guard', async () => {
  for (const script of ['start-prod.sh', 'run-server.sh']) {
    const contents = await readFile(join(repoRoot, 'scripts', script), 'utf8');
    assert.match(contents, /source "\$SCRIPT_DIR\/launch-guard\.sh"/);
    assert.match(contents, /docshell_guard_launch "\$PROJECT_ROOT" "\$DOCSHELL_HOST" "\$PORT" production/);
  }
});

test('background production logs use unique files in a private directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docshell-log-test-'));
  const stateRoot = join(root, 'state');
  const run = () => spawnSync('bash', ['-c', 'source "$1"; docshell_create_private_log', 'bash', privateLogPath], {
    cwd: repoRoot,
    env: { ...process.env, HOME: root, XDG_STATE_HOME: stateRoot },
    encoding: 'utf8',
  });
  let firstPath = '';
  let secondPath = '';
  try {
    const first = run();
    const second = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    firstPath = first.stdout.trim();
    secondPath = second.stdout.trim();
    assert.notEqual(firstPath, secondPath);
    assert.equal((await stat(dirname(firstPath))).mode & 0o777, 0o700);
    assert.equal((await stat(firstPath)).mode & 0o777, 0o600);
    assert.equal((await stat(secondPath)).mode & 0o777, 0o600);
  } finally {
    if (firstPath) await unlink(firstPath);
    if (secondPath) await unlink(secondPath);
    await rmdir(join(stateRoot, 'docshell', 'logs'));
    await rmdir(join(stateRoot, 'docshell'));
    await rmdir(stateRoot);
    await rmdir(root);
  }
});

test('private log helper rejects a symlink log directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docshell-log-link-test-'));
  const target = join(root, 'target');
  const link = join(root, 'logs');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, link);
  try {
    const result = spawnSync('bash', ['-c', 'source "$1"; docshell_create_private_log', 'bash', privateLogPath], {
      cwd: repoRoot,
      env: { ...process.env, HOME: root, DOCSHELL_LOG_DIR: link },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing symlink log directory/);
  } finally {
    await unlink(link);
    await rmdir(target);
    await rmdir(root);
  }
});

test('restart scripts never kill listeners without ownership checks', async () => {
  const startProd = await readFile(join(repoRoot, 'scripts', 'start-prod.sh'), 'utf8');
  assert.match(startProd, /lsof -a -p "\$listener_pid" -d cwd/);
  assert.match(startProd, /refusing to stop unrelated listener/);
  assert.doesNotMatch(startProd, /\/tmp\/docshell\.log/);
  assert.match(startProd, /docshell_create_private_log/);

  const rebuild = await readFile(join(repoRoot, 'scripts', 'rebuild.sh'), 'utf8');
  assert.match(rebuild, /launchctl kickstart -k/);
  assert.doesNotMatch(rebuild, /xargs kill|pkill/);
});

test('all supported launch scripts pass shell syntax checks and executable entrypoints are executable', async () => {
  const scripts = ['start-prod.sh', 'run-server.sh', 'run-dev.sh', 'rebuild.sh', 'launch-guard.sh', 'private-log.sh'];
  const syntax = spawnSync('bash', ['-n', ...scripts.map((name) => join(repoRoot, 'scripts', name))], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(syntax.status, 0, syntax.stderr);

  for (const script of ['start-prod.sh', 'run-server.sh', 'run-dev.sh', 'rebuild.sh', 'check-bind.mjs', 'token-init.mjs']) {
    assert.notEqual((await stat(join(repoRoot, 'scripts', script))).mode & 0o111, 0, script);
  }
});
