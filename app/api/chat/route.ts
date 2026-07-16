import { runTurn } from '@/lib/cc-process';
import { toolToDocEvents } from '@/lib/tool-comment';
import { createCommentStripper } from '@/lib/strip-comments';
import { checkAuth } from '@/lib/auth';
import { cleanupTempFiles, saveTempFiles } from '@/lib/temp-files';
import { createLimitedTextEmitter } from '@/lib/text-limit';
import { validateRequestPayload } from '@/lib/request-validation';
import type { ParsedChunk } from '@/lib/stream-parser';
import type { DocEvent } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300; // 5 min timeout

// 把底层报错（claude/API 原文）净化成中性中文再进文档：① 文档观感——不暴露 "API Error / claude.com / Claude"
// ② 体感——比一串英文 + 链接友好。原文打到 server console 供排障。
function sanitizeError(raw: string): string {
  const r = raw || '';
  console.error('[DocShell] error surfaced:', r.slice(0, 300));
  if (/overload|\b529\b|\b503\b|rate.?limit|too many|temporarily|busy/i.test(r)) return '服务器有点忙，过会儿再发一次就好';
  if (/not logged in|\/login|unauthor|\b401\b|invalid.*api|api key/i.test(r)) return '暂时连不上，请稍后再试';
  if (/network|timeout|timed out|econn|fetch failed|socket|enotfound/i.test(r)) return '网络有点波动，请稍后再试';
  if (/aborted|sigterm|sigkill/i.test(r)) return '已停止';
  return '出了点小问题，请稍后再试一次';
}

export async function POST(req: Request) {
  // 访问控制：token 模式校验 token；无 token 模式要求启动器已证明服务只绑定 literal loopback。
  const denied = checkAuth(req);
  if (denied) return denied;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }
  const validation = validateRequestPayload(rawBody);
  if (!validation.ok) {
    return new Response(JSON.stringify({ error: validation.error }), { status: 400 });
  }
  const body = validation.value;
  const { message, model, conversationId, ccSessionId, images, effort } = body;

  if (!message && (!images || images.length === 0)) {
    return new Response(JSON.stringify({ error: 'No message or images provided' }), { status: 400 });
  }
  // 临时文件保存失败 → 直接报错不继续
  let tempFiles: string[] = [];
  try {
    tempFiles = await saveTempFiles(images);
  } catch (err) {
    console.error('[DocShell] Failed to save temp files:', err);
    return new Response(
      JSON.stringify({ error: `Failed to process uploaded files: ${err instanceof Error ? err.message : 'unknown error'}` }),
      { status: 400 }
    );
  }

  // 把文件引用拼进 prompt（claude 用 Read 工具读它们）
  let prompt = message || '';
  if (tempFiles.length > 0) {
    const fileRefs = tempFiles.map((p) => `[Attached file: ${p}]`).join('\n');
    prompt = prompt
      ? `${prompt}\n\n${fileRefs}\n\nPlease read and analyze the attached file(s) above.`
      : `${fileRefs}\n\nPlease read and describe the attached file(s) above.`;
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // 防 "Controller is already closed"——关闭后所有 send/close 安全跳过
      let closed = false;
      const safeClose = () => { if (!closed) { closed = true; try { controller.close(); } catch { /* already closed */ } } };
      const send = (ev: DocEvent) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`)); } catch { closed = true; }
      };

      // assistant partial 快照会重复同一 toolId → 去重
      const seenToolIds = new Set<string>();
      // 剥掉模型回复里的 HTML 注释（某些 MCP server 会在回复末尾追加 `<!-- ... -->` 状态注释），避免漏进文档正文
      const stripper = createCommentStripper();
      const emitText = createLimitedTextEmitter(send);

      // 把常驻进程吐出的解析 chunk 塑形成 DocShell 文档事件
      const onChunk = (parsed: ParsedChunk) => {
        switch (parsed.kind) {
          case 'text_delta':
            emitText(stripper.feed(parsed.text || ''));
            break;

          case 'tool_use':
            if (!parsed.toolId || seenToolIds.has(parsed.toolId)) break;
            seenToolIds.add(parsed.toolId);
            for (const ev of toolToDocEvents(parsed.toolId, parsed.name || '', parsed.input || {})) send(ev);
            break;

          case 'tool_result':
            // 把工具结果挂回对应批注（toolId 匹配）→ 过程可见 = 命令 + 结果
            if (parsed.toolId && parsed.content) {
              send({ type: 'comment_result', toolId: parsed.toolId, content: parsed.content.slice(0, 2000) });
            }
            break;

          case 'error':
            send({ type: 'footnote_error', error: sanitizeError(parsed.error || '') });
            break;

          // session_id / result：会话 id 由 runTurn 返回后统一发；result 仅标记回合结束
        }
      };

      runTurn({
        conversationId,
        prompt,
        model: model || 'opus',
        effort: effort || 'max',
        resumeSessionId: ccSessionId,
        onChunk,
        signal: req.signal,
      })
        .then(({ sessionId }) => {
          if (sessionId) send({ type: 'session', sessionId });
        })
        .catch((err) => {
          console.error('[DocShell] runTurn error:', err);
          send({ type: 'footnote_error', error: sanitizeError(err instanceof Error ? err.message : String(err)) });
        })
        .finally(async () => {
          emitText(stripper.flush()); // 成功、报错或中断都补发并清空剥离器暂留的非注释结尾
          try {
            await cleanupTempFiles(tempFiles);
          } catch (err) {
            console.error('[DocShell] Failed to clean up temp files:', err);
          }
          send({ type: 'done' });
          safeClose();
        });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
