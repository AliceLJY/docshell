export const DEFAULT_MAX_PROCESSES = 8;
const MAX_CONFIGURED_PROCESSES = 64;

export function parseMaxProcesses(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_MAX_PROCESSES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_CONFIGURED_PROCESSES) {
    return DEFAULT_MAX_PROCESSES;
  }
  return parsed;
}

export interface ProcessCapacityEntry {
  busy: boolean;
  lastUsedAt: number;
}

/** Return the least-recently-used idle entry. Active turns are never candidates. */
export function selectIdleProcessForEviction<T extends ProcessCapacityEntry>(
  entries: Iterable<[string, T]>,
): string | undefined {
  let candidate: string | undefined;
  let oldest = Number.POSITIVE_INFINITY;
  for (const [key, entry] of entries) {
    if (entry.busy || entry.lastUsedAt >= oldest) continue;
    candidate = key;
    oldest = entry.lastUsedAt;
  }
  return candidate;
}

/** A live process knows the canonical session even when a request carries no persisted id yet. */
export function sessionIdForRestart(
  liveSessionId: string | undefined,
  requestedSessionId: string | undefined,
): string | undefined {
  return liveSessionId || requestedSessionId;
}
