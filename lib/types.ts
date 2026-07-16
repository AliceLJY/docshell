export interface Conversation {
  id: string;
  title: string;
  model: ModelType;
  ccSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

// 文档里的一段：用户输入段 或 模型回复段（无 role 标签、无气泡 —— 都是正文）
export interface DocParagraph {
  id: string;
  conversationId: string;
  kind: 'input' | 'reply';
  text: string;
  timestamp: number;
}

export interface ImageAttachment {
  base64: string;
  mediaType: string;
  name?: string;
}

export type ModelType = 'opus';

export interface ChatRequest {
  message: string;
  model: ModelType;
  conversationId: string;
  ccSessionId?: string;
  images?: ImageAttachment[];
  compact?: boolean;
  effort?: 'low' | 'medium' | 'high' | 'max';
}

/**
 * DocShell 前后端 SSE 事件契约。
 * 事件集：paragraph_delta / comment_tool / revision_diff / footnote_error / truncated / session。
 *   - paragraph_delta：模型回复的流式文本 → 接成正文段
 *   - comment_tool   ：工具调用 → 页边批注摘要（点开看 detail）
 *   - revision_diff  ：Edit/Write → 正文里的修订记录（删除线 + 新增）
 *   - footnote_error ：报错 → 脚注
 *   - truncated      ：正文达到上限 → 明确告知后续内容已截断
 *   - session        ：会话 id（多轮 resume）
 *   - done           ：一轮结束
 */
export type DocEvent =
  | { type: 'paragraph_delta'; text: string }
  | { type: 'comment_tool'; toolId: string; icon: string; who: string; summary: string; detail: string }
  | { type: 'revision_diff'; toolId: string; file: string; before: string; after: string }
  | { type: 'footnote_error'; error: string }
  | { type: 'truncated'; error: string; limitBytes: number }
  | { type: 'session'; sessionId: string; replaced?: boolean }
  | { type: 'comment_result'; toolId: string; content: string }
  | { type: 'done' };
