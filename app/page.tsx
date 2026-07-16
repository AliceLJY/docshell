'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { listDocs, getDoc, saveDoc, type StoredDoc, type StoredPara, type StoredComment } from '@/lib/docs-db';
import type { DocEvent } from '@/lib/types';

type Para =
  | { id: string; kind: 'input' | 'reply'; text: string }
  | { id: string; kind: 'revision'; file: string; before: string; after: string };
type Comment = { id: string; icon: string; who: string; summary: string; detail: string; open: boolean; err?: boolean };

let seq = 0;
const nid = () => `p${Date.now()}-${++seq}`;
const DEFAULT_TITLE = '未命名文档';

function fmtTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `今天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export default function Home() {
  const [docId, setDocId] = useState('');
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [docList, setDocList] = useState<StoredDoc[]>([]);
  const [paras, setParas] = useState<Para[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [input, setInput] = useState('');
  // 精细度（effort）：深度=max（默认）/ 标准=high / 快速=low。是速度↔深度的取舍旋钮。
  const [effort, setEffort] = useState<'low' | 'high' | 'max'>('max');
  const ccSession = useRef<string | undefined>(undefined);
  // 访问令牌（仅网络部署需要）：从 #token= 链接或 localStorage 取，随请求带 x-docshell-token 头
  const tokenRef = useRef<string>('');
  // 当前回合的 AbortController：按 Esc 中断（相当于终端 Ctrl+C）
  const abortRef = useRef<AbortController | null>(null);
  // 生成中补充的消息队列：当前回合完后自动接力发（像 TG/终端那样可边等边补充）
  const queueRef = useRef<{ text: string; inputId: string }[]>([]);
  const createdAtRef = useRef<number>(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const replyIdRef = useRef<string | null>(null);

  // 镜像最新 state，供 persist 在流式结束后读取（避免闭包旧值）
  const stateRef = useRef({ docId, title, paras, comments });
  stateRef.current = { docId, title, paras, comments };

  const persist = useCallback(async () => {
    const s = stateRef.current;
    if (!s.docId) return;
    if (s.paras.length === 0 && s.title === DEFAULT_TITLE) return; // 空白文档不落库
    const doc: StoredDoc = {
      id: s.docId,
      title: s.title || DEFAULT_TITLE,
      paras: s.paras as StoredPara[],
      comments: s.comments.map(({ open, ...c }) => c) as StoredComment[],
      ccSessionId: ccSession.current,
      createdAt: createdAtRef.current || Date.now(),
      updatedAt: Date.now(),
    };
    await saveDoc(doc);
    setDocList(await listDocs());
  }, []);

  const startNewDoc = useCallback(() => {
    setDocId(`doc-${Date.now()}`);
    setTitle(DEFAULT_TITLE);
    setParas([]);
    setComments([]);
    setInput('');
    ccSession.current = undefined;
    createdAtRef.current = Date.now();
  }, []);

  const loadDocInto = useCallback((d: StoredDoc) => {
    setDocId(d.id);
    setTitle(d.title);
    setParas(d.paras as Para[]);
    setComments((d.comments || []).map((c) => ({ ...c, open: false })));
    ccSession.current = d.ccSessionId;
    createdAtRef.current = d.createdAt;
  }, []);

  // 首次挂载/刷新：总是开一个全新对话（新 conversationId = 全新 session，不带旧上下文）。
  // 刷新即新对话，避免旧记录污染上下文。旧文档仍存在、可从「文件」菜单切回。
  useEffect(() => {
    (async () => {
      setDocList(await listDocs());
      startNewDoc();
    })();
  }, [startNewDoc]);

  // 每轮对话结束后自动持久化
  useEffect(() => {
    if (!streaming) persist();
  }, [streaming, persist]);

  // 精细度从 localStorage 恢复（持久化在 select 的 onChange 里做）
  useEffect(() => {
    const e = localStorage.getItem('docshell-effort');
    if (e === 'low' || e === 'high' || e === 'max') setEffort(e);
  }, []);

  // 访问令牌只从 URL fragment 读（#token=…）：fragment 不会发给服务器，也不会进入访问日志。
  // 不兼容 ?token=，因为查询参数在前端有机会清除之前就已经发给了服务器。
  useEffect(() => {
    let t = '';
    if (window.location.hash.startsWith('#token=')) t = decodeURIComponent(window.location.hash.slice(7));
    const url = new URL(window.location.href);
    if (t) {
      localStorage.setItem('docshell-token', t);
      window.history.replaceState({}, '', url.pathname + url.search); // 丢掉 hash，保留无敏感信息的 query
    }
    tokenRef.current = localStorage.getItem('docshell-token') || '';
  }, []);

  // 开文档时预热常驻进程：首条消息省掉 ~3-4s 冷启动。仅全新文档（无 session）——
  // 有 session 的恢复要随真实消息触发合成回合、不能空预热。fire-and-forget。
  useEffect(() => {
    if (!docId || ccSession.current) return;
    fetch('/api/warm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(tokenRef.current ? { 'x-docshell-token': tokenRef.current } : {}) },
      body: JSON.stringify({ conversationId: docId, model: 'opus', effort }),
    }).catch(() => {});
  }, [docId, effort]);

  // 生成中按 Esc 中断当前回合（相当于终端 Ctrl+C；无可见按钮、不破坏文档观感）。全局监听因为
  // 流式时输入框是 disabled、焦点可能不在它身上。
  useEffect(() => {
    if (!streaming) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') abortRef.current?.abort(); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [streaming]);

  const newDoc = useCallback(async () => {
    await persist();
    startNewDoc();
    setFileMenuOpen(false);
    requestAnimationFrame(() => taRef.current?.focus());
  }, [persist, startNewDoc]);

  const switchDoc = useCallback(async (id: string) => {
    await persist();
    const d = await getDoc(id);
    if (d) loadDocInto(d);
    setFileMenuOpen(false);
  }, [persist, loadDocInto]);

  useEffect(() => {
    const ta = taRef.current;
    if (ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
  }, [input]);

  const scrollDown = () => requestAnimationFrame(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  });
  const scrollInputToTop = (id: string) => requestAnimationFrame(() => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // 跑一条消息的回合：建回复段 → fetch → 流式写入。本轮完后自动接力队列里的下一条
  // （生成中补充的消息排在 queueRef，像 TG/终端那样边等边补充）。
  const runMessage = useCallback(async (text: string, inputId: string) => {
    const rid = nid();
    replyIdRef.current = rid;
    setParas((prev) => [...prev, { id: rid, kind: 'reply', text: '' }]);
    setStreaming(true);
    scrollInputToTop(inputId);

    const ac = new AbortController();
    abortRef.current = ac;
    let aborted = false;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(tokenRef.current ? { 'x-docshell-token': tokenRef.current } : {}) },
        body: JSON.stringify({ message: text, model: 'opus', conversationId: stateRef.current.docId, ccSessionId: ccSession.current, effort }),
        signal: ac.signal,
      });
      if (res.status === 401) {
        const t = typeof window !== 'undefined' ? window.prompt('需要访问令牌') : null;
        if (t) { localStorage.setItem('docshell-token', t); tokenRef.current = t; window.location.reload(); }
        throw new Error('需要访问令牌');
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let ev: DocEvent;
          try { ev = JSON.parse(line.slice(6)) as DocEvent; } catch { continue; }
          switch (ev.type) {
            case 'paragraph_delta':
              setParas((prev) => prev.map((p) => p.id === rid && p.kind === 'reply' ? { ...p, text: p.text + ev.text } : p));
              scrollDown();
              break;
            case 'comment_tool':
              setComments((prev) => prev.some((c) => c.id === ev.toolId) ? prev
                : [...prev, { id: ev.toolId, icon: ev.icon, who: ev.who, summary: ev.summary, detail: ev.detail, open: false }]);
              break;
            case 'revision_diff':
              setParas((prev) => prev.some((p) => p.id === ev.toolId) ? prev
                : [...prev, { id: ev.toolId, kind: 'revision', file: ev.file, before: ev.before, after: ev.after }]);
              break;
            case 'footnote_error':
              setComments((prev) => [...prev, { id: nid(), icon: '⚠', who: '批注 · 出错', summary: ev.error, detail: ev.error, open: false, err: true }]);
              break;
            case 'truncated':
              setComments((prev) => [...prev, {
                id: nid(), icon: '⚠', who: '批注 · 输出已截断', summary: ev.error,
                detail: `${ev.error}\n限制：${Math.round(ev.limitBytes / 1024 / 1024)} MB`, open: false, err: true,
              }]);
              break;
            case 'comment_result':
              setComments((prev) => prev.map((c) => c.id === ev.toolId
                ? { ...c, detail: `${c.detail}\n\n— 结果 —\n${ev.content}` } : c));
              break;
            case 'session':
              // 后端发的永远是本文档当前规范会话 id：常驻进程内每轮相同（幂等）；resume 失败降级到
              // 全新会话时是新 id——必须无条件覆盖，否则下次还拿坏 id 恢复。
              if (ev.sessionId) ccSession.current = ev.sessionId;
              break;
          }
        }
      }
    } catch (e) {
      // Esc 中断是用户主动行为，不当出错；给当前回复段落加个轻标记即可
      if (e instanceof DOMException && e.name === 'AbortError') {
        aborted = true;
        setParas((prev) => prev.map((p) => p.id === rid && p.kind === 'reply'
          ? { ...p, text: (p.text ? p.text + ' ' : '') + '⌁ 已停止' } : p));
      } else {
        setComments((prev) => [...prev, { id: nid(), icon: '⚠', who: '批注 · 出错', summary: e instanceof Error ? e.message : '未知错误', detail: String(e), open: false, err: true }]);
      }
    } finally {
      abortRef.current = null;
      replyIdRef.current = null;
      scrollDown();
      // 接力队列：中断 → 清空队列全停；否则发下一条（streaming 保持 true 直到队列清空）
      const next = aborted ? undefined : queueRef.current.shift();
      if (aborted) queueRef.current = [];
      if (next) {
        runMessage(next.text, next.inputId);
      } else {
        setStreaming(false);
        requestAnimationFrame(() => taRef.current?.focus());
      }
    }
  }, [effort]);

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    // 首句自动当文档标题（用户没改过时）
    if (stateRef.current.title === DEFAULT_TITLE) setTitle(text.slice(0, 24));
    const inputId = nid();
    setParas((prev) => [...prev, { id: inputId, kind: 'input', text }]);
    if (streaming) {
      // 生成中也能补充：排队，当前回合完自动接力发
      queueRef.current.push({ text, inputId });
      scrollInputToTop(inputId);
    } else {
      runMessage(text, inputId);
    }
  }, [input, streaming, runMessage]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };
  const toggleComment = (id: string) =>
    setComments((prev) => prev.map((c) => c.id === id ? { ...c, open: !c.open } : c));

  return (
    <>
      <div className="docbar">
        <div className="docbar-top">
          <div className="doc-icon">📄</div>
          <div className="doc-meta">
            <div className="doc-title-line">
              <span
                className="doc-title"
                contentEditable
                suppressContentEditableWarning
                onBlur={(e) => {
                  const t = e.currentTarget.textContent?.trim() || DEFAULT_TITLE;
                  setTitle(t);
                  // 立刻把新标题写进 stateRef，否则 persist 会读到重渲染前的旧标题、把旧名存回历史（bug）
                  stateRef.current = { ...stateRef.current, title: t };
                  persist();
                }}
              >{title}</span>
              <span style={{ color: '#5f6368', cursor: 'pointer' }}>☆</span>
              <span className="doc-status">已保存在本机浏览器</span>
            </div>
            <div className="doc-menu">
              <span onClick={() => setFileMenuOpen((v) => !v)} style={{ fontWeight: fileMenuOpen ? 600 : 400 }}>文件</span>
              <span>编辑</span><span>视图</span><span>插入</span>
              <span>格式</span><span>工具</span><span>扩展程序</span><span>帮助</span>
            </div>
          </div>
          <div className="docbar-right">
            <button className="gear" onClick={() => setSettingsOpen(true)} title="文档设置">⚙</button>
            <button className="share-btn">🔒 共享</button>
          </div>
        </div>
        <div className="toolbar">
          <span className="tb">↶</span><span className="tb">↷</span><span className="tb">🖨</span><span className="tb-sep" />
          <span className="tb-sel">100%</span><span className="tb-sep" />
          <span className="tb-sel">正文</span><span className="tb-sel">宋体</span>
          <span className="tb">－</span><span className="tb-sel">16.5</span><span className="tb">＋</span><span className="tb-sep" />
          <span className="tb"><b>B</b></span><span className="tb"><i>I</i></span><span className="tb"><u>U</u></span><span className="tb">A</span><span className="tb-sep" />
          <span className="tb">🔗</span><span className="tb">💬</span><span className="tb-sep" />
          <span className="tb">≡</span><span className="tb">⬚</span>
        </div>
      </div>

      {/* 文件菜单：多文档切换（文档式的「最近文档」列表） */}
      {fileMenuOpen ? (
        <div className="menu-mask" onClick={() => setFileMenuOpen(false)}>
          <div className="filemenu" onClick={(e) => e.stopPropagation()}>
            <div className="fm-item fm-new" onClick={newDoc}>＋　新建文档</div>
            <div className="fm-sep" />
            <div className="fm-label">最近文档</div>
            {docList.length === 0 ? (
              <div className="fm-empty">还没有其它文档</div>
            ) : docList.map((d) => (
              <div className={`fm-item${d.id === docId ? ' fm-active' : ''}`} key={d.id} onClick={() => switchDoc(d.id)}>
                <span className="fm-doctitle">📄　{d.title}</span>
                <span className="fm-time">{fmtTime(d.updatedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="scroll" ref={scrollRef}>
        <div className="layout">
          <div className="page">
            <div className="doc-h1">{title}</div>
            <div className="doc-date">{new Date(createdAtRef.current || Date.now()).getFullYear()} 年 {new Date(createdAtRef.current || Date.now()).getMonth() + 1} 月 {new Date(createdAtRef.current || Date.now()).getDate()} 日 · 个人笔记</div>

            {paras.map((p) =>
              p.kind === 'revision' ? (
                <div className="revision" key={p.id}>
                  <div className="rev-file">✎ {p.file}</div>
                  {p.before ? <span className="del">{p.before}</span> : null}
                  {p.after ? <span className="add">{p.after}</span> : null}
                </div>
              ) : (
                <p id={p.id} className={`para${p.kind === 'reply' && streaming && p.id === replyIdRef.current ? ' typing' : ''}`} key={p.id}>
                  {p.text}
                </p>
              )
            )}

            <textarea
              ref={taRef}
              className="input-para"
              rows={1}
              value={input}
              placeholder={streaming ? '正在生成…（可继续输入排队，Esc 停止）' : '在此继续输入…'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              autoFocus
            />
          </div>

          <div className="comments-rail">
            {comments.map((c) => (
              <div className={`comment${c.err ? ' err' : ''}${c.open ? ' open' : ''}`} key={c.id} onClick={() => toggleComment(c.id)}>
                <div className="comment-head">
                  <div className="comment-dot">{c.icon}</div>
                  <div className="comment-who">{c.who}</div>
                </div>
                <div className="comment-sum">{c.summary}</div>
                <div className="comment-toggle">{c.open ? '▾ 收起过程' : '▸ 展开过程'}</div>
                {c.open ? <div className="comment-detail">{c.detail}</div> : null}
              </div>
            ))}
          </div>
        </div>
      </div>

      {settingsOpen ? (
        <div className="settings-mask" onClick={() => setSettingsOpen(false)}>
          <div className="settings" onClick={(e) => e.stopPropagation()}>
            <h3>文档设置</h3>
            <label>编辑助手</label>
            <input value="Claude Code（订阅）" readOnly />
            <label>精细度</label>
            <select
              value={effort}
              onChange={(e) => {
                const v = e.target.value as 'low' | 'high' | 'max';
                setEffort(v);
                localStorage.setItem('docshell-effort', v);
              }}
            >
              <option value="max">深度（最准，最慢）</option>
              <option value="high">标准</option>
              <option value="low">快速（最快，浅一点）</option>
            </select>
            <label>工作目录</label>
            <input defaultValue="~（家目录）" />
            <div className="hint">这些设置不会出现在文档正文里，旁人看不到。</div>
          </div>
        </div>
      ) : null}
    </>
  );
}
