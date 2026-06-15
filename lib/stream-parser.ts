/**
 * Parse Claude Code CLI stream-json output into DocShell chunks.
 *
 * 不只取 text delta：同时解析 tool_use / tool_result，让"中间过程"能进文档批注。
 * 一行可能产生 0..n 个 chunk（assistant 一条消息可含多个 tool_use）。
 *
 * 事件结构（探测自 claude 2.1.177 --output-format stream-json --include-partial-messages）：
 *   - system / rate_limit_event           → session_id
 *   - stream_event/content_block_delta+text → text_delta（流式正文）
 *   - assistant.message.content[].tool_use → tool_use（含完整 name+input；partial 快照会重复，调用方按 toolId 去重）
 *   - user.message.content[].tool_result  → tool_result
 *   - result                              → result / error
 */

export interface ParsedChunk {
  kind: 'text_delta' | 'tool_use' | 'tool_result' | 'result' | 'error' | 'session_id';
  text?: string;
  sessionId?: string;
  error?: string;
  toolId?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
}

export function parseStreamLine(line: string): ParsedChunk[] {
  if (!line.trim()) return [];

  let data: Record<string, unknown> & {
    type?: string;
    session_id?: string;
    event?: Record<string, unknown> & { type?: string; delta?: { text?: string } };
    message?: { content?: Array<Record<string, unknown>> };
    is_error?: boolean;
    result?: string;
  };
  try { data = JSON.parse(line); } catch { return []; }

  const out: ParsedChunk[] = [];

  // system / rate_limit：只取 session_id
  if (data.type === 'system' || data.type === 'rate_limit_event') {
    if (data.session_id) out.push({ kind: 'session_id', sessionId: data.session_id });
    return out;
  }

  // stream_event：文本增量（流式正文）+ message_start 的 session_id
  if (data.type === 'stream_event' && data.event) {
    const evt = data.event;
    if (evt.type === 'content_block_delta' && evt.delta?.text) {
      out.push({ kind: 'text_delta', text: evt.delta.text });
    }
    if (evt.type === 'message_start' && data.session_id) {
      out.push({ kind: 'session_id', sessionId: data.session_id });
    }
    return out;
  }

  // assistant 完整消息：提取 tool_use（含完整 name + input）
  if (data.type === 'assistant' && Array.isArray(data.message?.content)) {
    for (const b of data.message!.content!) {
      if (b.type === 'tool_use') {
        out.push({
          kind: 'tool_use',
          toolId: String(b.id ?? ''),
          name: String(b.name ?? ''),
          input: (b.input as Record<string, unknown>) || {},
        });
      }
    }
    return out;
  }

  // user 消息：工具结果
  if (data.type === 'user' && Array.isArray(data.message?.content)) {
    for (const b of data.message!.content!) {
      if (b.type === 'tool_result') {
        const raw = b.content;
        const c = typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? raw.map((x: { text?: string }) => x.text || '').join('')
            : '';
        out.push({ kind: 'tool_result', toolId: String(b.tool_use_id ?? ''), content: c });
      }
    }
    return out;
  }

  // 最终结果
  if (data.type === 'result') {
    if (data.is_error) out.push({ kind: 'error', error: data.result || 'Unknown error' });
    else out.push({ kind: 'result', sessionId: data.session_id, text: data.result });
    return out;
  }

  return out;
}
