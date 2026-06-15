import { writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runTurn } from '@/lib/cc-process';
import { toolToDocEvents } from '@/lib/tool-comment';
import { createCommentStripper } from '@/lib/strip-comments';
import { checkAuth } from '@/lib/auth';
import type { ParsedChunk } from '@/lib/stream-parser';
import type { ChatRequest, DocEvent } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300; // 5 min timeout

// 上传临时目录（用 os.tmpdir() 不硬编码 /tmp）
const TEMP_DIR = join(tmpdir(), 'docshell-uploads');

// 允许的上传媒体类型
const ALLOWED_MEDIA_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf', 'text/plain', 'text/csv', 'text/html', 'text/markdown',
  'application/json', 'application/xml', 'application/octet-stream',
]);

const MAX_UPLOAD_COUNT = 10;
const MAX_SINGLE_FILE_SIZE = 20 * 1024 * 1024; // 20 MB base64 解码后
const MAX_MESSAGE_LENGTH = 100 * 1024;          // 单条消息 100 KB
const MAX_ACCUMULATED_TEXT = 10 * 1024 * 1024;  // 单回合累计正文 10 MB（防失控内存增长）

// 把 base64 图片/文件存到临时目录，返回路径
async function saveTempFiles(images: ChatRequest['images']): Promise<string[]> {
  if (!images || images.length === 0) return [];
  if (images.length > MAX_UPLOAD_COUNT) {
    throw new Error(`Too many files: ${images.length} exceeds limit of ${MAX_UPLOAD_COUNT}`);
  }
  await mkdir(TEMP_DIR, { recursive: true });

  const paths: string[] = [];
  for (const img of images) {
    if (!ALLOWED_MEDIA_TYPES.has(img.mediaType)) {
      throw new Error(`Unsupported media type: ${img.mediaType}`);
    }
    if (!img.base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(img.base64)) {
      throw new Error('Invalid base64 data');
    }
    const estimatedSize = Math.ceil(img.base64.length * 3 / 4);
    if (estimatedSize > MAX_SINGLE_FILE_SIZE) {
      throw new Error(`File too large: ${estimatedSize} bytes exceeds ${MAX_SINGLE_FILE_SIZE} byte limit`);
    }
    const ext = img.mediaType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const filename = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const filepath = join(TEMP_DIR, filename);
    await writeFile(filepath, Buffer.from(img.base64, 'base64'));
    paths.push(filepath);
  }
  return paths;
}

function cleanupFiles(paths: string[]) {
  for (const p of paths) {
    unlink(p).catch((err) => {
      console.error('[DocShell] Failed to clean up temp file:', p, err.message);
    });
  }
}

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
  // 访问控制：设了 DOCSHELL_TOKEN（网络部署）→ 强制 token；否则 → localhost 同源校验（本机 dev）
  const denied = checkAuth(req);
  if (denied) return denied;

  const body: ChatRequest = await req.json();
  const { message, model, conversationId, ccSessionId, images, effort } = body;

  if (!message && (!images || images.length === 0)) {
    return new Response(JSON.stringify({ error: 'No message or images provided' }), { status: 400 });
  }
  if (!conversationId) {
    return new Response(JSON.stringify({ error: 'Missing conversationId' }), { status: 400 });
  }
  if (message && message.length > MAX_MESSAGE_LENGTH) {
    return new Response(
      JSON.stringify({ error: `Message too long: ${message.length} chars exceeds ${MAX_MESSAGE_LENGTH} limit` }),
      { status: 400 }
    );
  }
  if (effort && !['low', 'medium', 'high', 'max'].includes(effort)) {
    return new Response(JSON.stringify({ error: 'Invalid effort level' }), { status: 400 });
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
      let accumulatedTextSize = 0;
      // 剥掉模型回复里的 HTML 注释（某些 MCP server 会在回复末尾追加 `<!-- ... -->` 状态注释），避免漏进文档正文
      const stripper = createCommentStripper();
      const emitText = (raw: string) => {
        if (!raw) return;
        accumulatedTextSize += raw.length;
        if (accumulatedTextSize > MAX_ACCUMULATED_TEXT) return;
        send({ type: 'paragraph_delta', text: raw });
      };

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
          emitText(stripper.flush()); // 补发剥离器暂留的结尾（原来不是注释的部分）
          if (sessionId) send({ type: 'session', sessionId });
        })
        .catch((err) => {
          console.error('[DocShell] runTurn error:', err);
          send({ type: 'footnote_error', error: sanitizeError(err instanceof Error ? err.message : String(err)) });
        })
        .finally(() => {
          cleanupFiles(tempFiles);
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
