import { timingSafeEqual } from 'node:crypto';

const LOOPBACK_BIND_GUARD = 'loopback-bind-v1';

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function tokenMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const actualBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function isLiteralLoopback(hostname: string): boolean {
  const normalized = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return normalized === '127.0.0.1' || normalized === '::1';
}

function guardedLoopbackOrigin(): string | null {
  const bindHost = process.env.DOCSHELL_BIND_HOST || '';
  const bindPort = process.env.DOCSHELL_BIND_PORT || '';
  if (process.env.DOCSHELL_BIND_GUARD !== LOOPBACK_BIND_GUARD || !isLiteralLoopback(bindHost)) return null;
  if (!/^\d+$/.test(bindPort)) return null;

  const numericPort = Number(bindPort);
  if (!Number.isSafeInteger(numericPort) || numericPort < 1 || numericPort > 65535) return null;

  const formattedHost = bindHost === '::1' ? '[::1]' : bindHost;
  return new URL(`http://${formattedHost}:${numericPort}`).origin;
}

function isSameLoopbackBrowserOrigin(req: Request, expectedOrigin: string): boolean {
  let originUrl: URL;
  const origin = req.headers.get('origin');

  try {
    originUrl = new URL(origin || '');
  } catch {
    return false;
  }

  if (!isLiteralLoopback(originUrl.hostname)) return false;
  if (origin !== originUrl.origin || originUrl.origin !== expectedOrigin) return false;
  if (req.headers.get('host') !== originUrl.host) return false;

  const fetchSite = req.headers.get('sec-fetch-site');
  return !fetchSite || fetchSite === 'same-origin';
}

/**
 * DocShell API access control.
 *
 * Next.js 16 Route Handlers receive a Web Request with no trustworthy peer socket address; forwarded
 * IP headers are client-controlled and deliberately ignored. Therefore no-token mode is authorized by
 * the shared launcher attesting that this exact process was bound to a specific port on 127.0.0.1 or
 * ::1. Missing or inconsistent attestation fails closed. Same-origin checks remain a browser CSRF
 * defense, not proof of the network source. We intentionally avoid req.url for this decision because
 * Next may normalize its authority independently of the actual listener.
 */
export function checkAuth(req: Request): Response | null {
  const token = process.env.DOCSHELL_TOKEN;

  if (token) {
    const provided = req.headers.get('x-docshell-token');
    return tokenMatches(provided, token) ? null : jsonError(401, 'unauthorized');
  }

  const expectedOrigin = guardedLoopbackOrigin();
  if (!expectedOrigin) return jsonError(503, 'local-only auth unavailable');
  return isSameLoopbackBrowserOrigin(req, expectedOrigin) ? null : jsonError(403, 'forbidden local request');
}
