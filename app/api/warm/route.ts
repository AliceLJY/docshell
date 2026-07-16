import { warmUp } from '@/lib/cc-process';
import { checkAuth } from '@/lib/auth';
import { validateRequestPayload } from '@/lib/request-validation';

export const runtime = 'nodejs';

// 预热端点：开文档时前端 fire-and-forget 调一下，把常驻 claude 进程提前 spawn 好，
// 首条消息直接走 reuse 路径、省掉 ~3-4s 冷启动。只对全新文档（无 ccSessionId）有效。
export async function POST(req: Request) {
  const denied = checkAuth(req);
  if (denied) return denied;

  let rawBody: unknown;
  try { rawBody = await req.json(); } catch { return new Response(JSON.stringify({ error: 'bad json' }), { status: 400 }); }
  const validation = validateRequestPayload(rawBody);
  if (!validation.ok) return new Response(JSON.stringify({ error: validation.error }), { status: 400 });
  const body = validation.value;

  const { conversationId, model, ccSessionId, effort } = body;

  warmUp(conversationId, model || 'opus', effort || 'max', ccSessionId);
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}
