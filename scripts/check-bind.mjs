#!/usr/bin/env node

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env');

const [projectRoot, bindHost, bindPort, nextMode] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`[docshell] ${message}\n`);
  process.exit(1);
}

if (!projectRoot || !bindHost || !/^\d+$/.test(bindPort || '') || !['development', 'production'].includes(nextMode)) {
  fail('internal launch-guard error: expected project root, bind host, bind port, and Next mode.');
}

const numericPort = Number(bindPort);
if (!Number.isSafeInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
  fail(`invalid port ${bindPort}; expected an integer from 1 to 65535.`);
}

let combinedEnv;
try {
  ({ combinedEnv } = loadEnvConfig(
    projectRoot,
    nextMode === 'development',
    { info() {}, error() {} },
    true,
  ));
} catch {
  fail('could not load the Next.js environment; refusing to start.');
}

const tokenLength = typeof combinedEnv.DOCSHELL_TOKEN === 'string' ? combinedEnv.DOCSHELL_TOKEN.length : 0;
const isLiteralLoopback = bindHost === '127.0.0.1' || bindHost === '::1';

if (!isLiteralLoopback && tokenLength < 32) {
  fail(`refusing to bind ${bindHost} without a DOCSHELL_TOKEN of at least 32 characters; use 127.0.0.1 or ::1, or configure a strong token.`);
}
