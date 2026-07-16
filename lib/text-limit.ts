import type { DocEvent } from './types';

export const MAX_ACCUMULATED_TEXT_BYTES = 10 * 1024 * 1024;
export const TEXT_TRUNCATED_ERROR = '回复达到正文上限，后续内容已截断';

function utf8Prefix(text: string, maxBytes: number): string {
  let usedBytes = 0;
  let end = 0;

  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (usedBytes + characterBytes > maxBytes) break;
    usedBytes += characterBytes;
    end += character.length;
  }

  return text.slice(0, end);
}

/** Emit text up to a UTF-8 byte limit, followed by exactly one explicit truncation event. */
export function createLimitedTextEmitter(
  send: (event: DocEvent) => void,
  maxBytes = MAX_ACCUMULATED_TEXT_BYTES,
): (raw: string) => void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative integer');

  let emittedBytes = 0;
  let truncated = false;

  return (raw: string) => {
    if (!raw || truncated) return;

    const remainingBytes = maxBytes - emittedBytes;
    const rawBytes = Buffer.byteLength(raw, 'utf8');
    if (rawBytes <= remainingBytes) {
      emittedBytes += rawBytes;
      send({ type: 'paragraph_delta', text: raw });
      return;
    }

    const prefix = utf8Prefix(raw, remainingBytes);
    if (prefix) {
      emittedBytes += Buffer.byteLength(prefix, 'utf8');
      send({ type: 'paragraph_delta', text: prefix });
    }

    truncated = true;
    send({ type: 'truncated', error: TEXT_TRUNCATED_ERROR, limitBytes: maxBytes });
  };
}
