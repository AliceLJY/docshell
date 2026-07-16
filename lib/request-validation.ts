import type { ChatRequest } from './types';

export const MAX_MESSAGE_LENGTH = 100 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'max']);

export type ValidatedRequest = Partial<ChatRequest> & { conversationId: string };
export type ValidationResult =
  | { ok: true; value: ValidatedRequest }
  | { ok: false; error: string };

export function validateRequestPayload(value: unknown): ValidationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }

  const body = value as Record<string, unknown>;
  if (typeof body.conversationId !== 'string' || !ID_PATTERN.test(body.conversationId)) {
    return { ok: false, error: 'Invalid conversationId' };
  }
  if (body.model !== undefined && body.model !== 'opus') {
    return { ok: false, error: 'Only the opus model is supported' };
  }
  if (body.ccSessionId !== undefined && (
    typeof body.ccSessionId !== 'string' || !ID_PATTERN.test(body.ccSessionId)
  )) {
    return { ok: false, error: 'Invalid ccSessionId' };
  }
  if (body.effort !== undefined && (
    typeof body.effort !== 'string' || !EFFORTS.has(body.effort)
  )) {
    return { ok: false, error: 'Invalid effort level' };
  }
  if (body.message !== undefined && typeof body.message !== 'string') {
    return { ok: false, error: 'Message must be a string' };
  }
  if (typeof body.message === 'string' && body.message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `Message too long: ${body.message.length} chars exceeds ${MAX_MESSAGE_LENGTH} limit` };
  }
  if (body.images !== undefined && !Array.isArray(body.images)) {
    return { ok: false, error: 'Images must be an array' };
  }

  return { ok: true, value: body as ValidatedRequest };
}
