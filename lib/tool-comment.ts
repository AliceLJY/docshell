/**
 * 把一个工具调用（tool_use）转成 DocShell 的文档事件：
 *   - Edit / Write → revision_diff（正文里的修订记录）
 *   - 其它工具     → comment_tool（页边批注摘要，点开看 detail）
 *
 * 设计原则：批注默认只显示摘要（"读取 2 个文件"），不摊开成 terminal log，否则页面会变成
 * "带白底的终端记录"、失去文档观感。完整细节放 detail，点"展开过程"才看。
 */
import type { DocEvent } from './types';

export function toolToDocEvents(toolId: string, name: string, input: Record<string, unknown>): DocEvent[] {
  // Edit → 修订记录（删除线 + 新增）
  if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return [{ type: 'revision_diff', toolId, file: shortPath(str(input.file_path)), before: input.old_string, after: input.new_string }];
  }
  // Write → 新增整段
  if (name === 'Write' && typeof input.content === 'string') {
    return [{ type: 'revision_diff', toolId, file: shortPath(str(input.file_path)), before: '', after: input.content }];
  }
  // 其它工具 → 批注摘要
  const c = summarizeTool(name, input);
  return [{ type: 'comment_tool', toolId, icon: c.icon, who: c.who, summary: c.summary, detail: c.detail }];
}

function summarizeTool(name: string, input: Record<string, unknown>): { icon: string; who: string; summary: string; detail: string } {
  switch (name) {
    case 'Read':
      return { icon: '📑', who: '批注 · 读取文件', summary: `查看了 ${shortPath(str(input.file_path))}`, detail: `⎿ Read ${str(input.file_path)}` };
    case 'Bash':
      return { icon: '⌘', who: '批注 · 运行命令', summary: truncate(str(input.command), 60), detail: `⎿ Bash\n   ${str(input.command)}` };
    case 'Grep':
      return { icon: '🔍', who: '批注 · 检索', summary: `搜索 "${truncate(str(input.pattern), 40)}"`, detail: `⎿ Grep ${str(input.pattern)}` };
    case 'Glob':
      return { icon: '🔍', who: '批注 · 查找文件', summary: str(input.pattern), detail: `⎿ Glob ${str(input.pattern)}` };
    case 'WebFetch':
    case 'WebSearch':
      return { icon: '🌐', who: '批注 · 联网查询', summary: truncate(str(input.url ?? input.query), 50), detail: `⎿ ${name} ${str(input.url ?? input.query)}` };
    case 'TodoWrite':
      return { icon: '☑', who: '批注 · 更新清单', summary: '调整了任务清单', detail: '⎿ TodoWrite' };
    case 'Task':
      return { icon: '🧩', who: '批注 · 派生子任务', summary: truncate(str(input.description), 50), detail: `⎿ Task ${str(input.description)}` };
    default:
      return { icon: '•', who: `批注 · ${name}`, summary: truncate(json(input), 60), detail: `⎿ ${name} ${truncate(json(input), 200)}` };
  }
}

function str(v: unknown): string { return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v); }
function json(v: unknown): string { try { return JSON.stringify(v); } catch { return ''; } }
function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '…' : s; }
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}
