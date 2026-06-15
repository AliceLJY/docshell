/**
 * DocShell 常驻 claude 会话管理器。
 *
 * 为什么需要：每文档维持一个**常驻** `claude --input-format stream-json` 进程，通过 stdin 逐轮
 * 喂结构化 user 消息、读干净的 stream-json 输出。这样多轮对话天然连续、记得上下文，而且彻底绕开
 * 旧 `claude -p --resume <id> -- "prompt"` 那条路上 claude 注入「Continue from where you left off」
 * 合成消息、把 argv prompt 当续接而非新消息的 bug（spike 1 实测验证）。
 *
 * 两条路径（均经 /tmp 探针实测）：
 *   1) 同一 server 生命周期内 → 进程常驻、直接 stdin 喂消息、**不 resume**（干净、记得上下文）。
 *   2) server 重启后首条消息 → `--resume <sessionId>` 从磁盘恢复上下文。--resume 会先自动跑一个合成
 *      「Continue」回合，靠 DOCSHELL_SYSTEM_NOTE 把它压成最小输出，再由本模块**整段吞掉**那个回合，
 *      只把之后的真实回合发给前端。resume 失败（session 过期）→ 优雅降级到全新会话。
 */
import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import os from 'os';
import { parseStreamLine, type ParsedChunk } from './stream-parser';

// PreToolUse hook 在 bypassPermissions 下硬拦灾难命令（rm 删根/家/系统目录、mkfs、dd 写块设备、
// fork 炸弹、shred）。自动执行场景下这把"手刹"专防误删 / 被诱导删除关键目录——是手刹不是沙箱，
// 不影响日常使用体验。
const GUARD_SCRIPT = join(process.cwd(), 'scripts', 'guard-destructive-bash.sh');
function buildSettings(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash ' + JSON.stringify(GUARD_SCRIPT) }] },
      ],
    },
  });
}

// resume 会话时 claude 会自动注入「Continue from where you left off」合成消息；这段 system note 让模型
// 识别并忽略它（否则会错当用户指令、跑起恢复 / 续接流程 = 多轮续接 bug）。
// 注：本模块会把整个合成回合吞掉，这段 note 是双保险——确保即便被看到，合成回合也只产生最小输出、不调工具。
export const DOCSHELL_SYSTEM_NOTE = '你在一个文档编辑器环境里工作：用户在文档中输入，你的回复直接成为文档正文，请正常回应每一条新消息。特别注意：若你看到一条孤立的「Continue from where you left off」或类似空泛的续接提示、而此刻并没有真正的新用户内容，那是系统 resume 会话时自动注入的合成消息、不是用户指令——这种情况不要执行任何 continue / 恢复 / 续接 之类流程，也不要复述上一轮，简短示意在等待即可；等真正的新用户消息到了再针对它回应。';

const IDLE_MS = 30 * 60 * 1000;        // 闲置 30 分钟回收进程（下次消息自动 --resume 恢复）
const SYNTHETIC_TURN_TIMEOUT = 45_000; // 合成回合最多等 45s（它本应秒回；超时即视为 resume 异常→降级全新会话）

// 真·会话失效（该降级全新会话）的错误特征；其余 error（尤其 API 529 过载/限流）算瞬时、不丢会话。
const FATAL_RESUME_ERROR = /no conversation|session.*(not found|expired|invalid)|not found.*session|invalid.*session|not logged in|invalid api|unauthor/i;

interface DocProcess {
  proc: ChildProcess;
  sessionId: string;                       // 本进程的会话 id（首个 init/result 事件捕获，用于重启后 resume）
  effort: string;                          // 本进程 spawn 时的 effort（effort 是 launch flag，改档需重启进程）
  alive: boolean;
  buffer: string;                          // stdout 行缓冲
  onChunk: ((c: ParsedChunk) => void) | null; // 当前回合的解析回调
  onClose: (() => void) | null;            // 进程意外退出时通知等待中的回合
  stderr: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

// 模块级 Map：在 Next.js server 进程内跨 HTTP 请求存活（route 模块是单例）。
const procs = new Map<string, DocProcess>();
// per-conversation 串行锁：同一文档两条消息不会交错读写同一进程的 stdin/stdout。
const turnLocks = new Map<string, Promise<unknown>>();

// remote control 默认开：bare --remote-control 与 -p/--input-format stream-json 共存（flag 组合实测被接受、
// 不破坏多轮流程）。DocShell 是常驻进程 → RC 通道随进程常活，可随时从 Claude app / 手机 / 终端接管这个
// 会话。应急 DOCSHELL_NO_REMOTE_CONTROL=1 关。
const REMOTE_CONTROL_ON = process.env.DOCSHELL_NO_REMOTE_CONTROL !== '1';

function baseArgs(model: string, effort: string): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages', // DocShell 正文文本只来自 content_block_delta，必须开
    '--model', model || 'opus',
    '--effort', effort || 'max',  // 默认 opus + max effort
    '--permission-mode', 'bypassPermissions',
  ];
  if (REMOTE_CONTROL_ON) args.push('--remote-control');
  args.push('--settings', buildSettings());
  args.push('--append-system-prompt', DOCSHELL_SYSTEM_NOTE);
  return args;
}

function spawnProc(args: string[]): ChildProcess {
  return spawn('claude', args, {
    env: { ...process.env, LANG: 'en_US.UTF-8', HOME: process.env.HOME || os.homedir() },
    cwd: process.env.HOME || os.homedir(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function userMsg(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
}

// 设置/重置闲置回收定时器：IDLE_MS 后关 stdin（claude 收 EOF 自然退出）+ 兜底 kill。
function armIdle(dp: DocProcess) {
  if (dp.idleTimer) { clearTimeout(dp.idleTimer); dp.idleTimer = null; }
  dp.idleTimer = setTimeout(() => {
    try { dp.proc.stdin?.end(); } catch { /* noop */ }
    try { dp.proc.kill('SIGTERM'); } catch { /* noop */ }
  }, IDLE_MS);
  dp.idleTimer.unref?.();
}

function makeProc(args: string[], sessionId: string, effort: string): DocProcess {
  const proc = spawnProc(args);
  const dp: DocProcess = {
    proc, sessionId, effort, alive: true, buffer: '', onChunk: null, onClose: null, stderr: '', idleTimer: null,
  };

  proc.stdout?.on('data', (chunk: Buffer) => {
    dp.buffer += chunk.toString();
    const lines = dp.buffer.split('\n');
    dp.buffer = lines.pop() || '';
    for (const line of lines) {
      for (const parsed of parseStreamLine(line)) {
        if (parsed.sessionId && !dp.sessionId) dp.sessionId = parsed.sessionId;
        dp.onChunk?.(parsed);
      }
    }
  });
  proc.stderr?.on('data', (c: Buffer) => { if (dp.stderr.length < 65536) dp.stderr += c.toString(); });

  const die = () => {
    if (!dp.alive) return;
    dp.alive = false;
    if (dp.idleTimer) { clearTimeout(dp.idleTimer); dp.idleTimer = null; }
    for (const [k, v] of procs) if (v === dp) procs.delete(k);
    const cb = dp.onClose; dp.onClose = null; dp.onChunk = null;
    cb?.();
  };
  proc.on('close', die);
  proc.on('error', die);

  return dp;
}

// resume 失败专用错误：synthetic 阶段进程就死了 / 超时 → 可安全降级到全新会话（此刻还没发任何真实输出）。
class ResumeFailedError extends Error {}

/**
 * 消费一个回合：写入消息后把解析出的 chunk 喂给 onChunk，直到 result/error（回合结束）。
 *
 * skipSynthetic=true 用于 --resume 恢复的首条消息：claude 会在处理第一条 stdin 消息时、先以「Continue
 * from where you left off」合成一个前缀回合（result#1），再处理真实消息（result#2）。本函数吞掉 result#1
 * 之前的一切，只从 result#2 开始把 chunk 发给 onChunk。关键：合成回合是被**写入触发**的，所以必须写消息
 * （早先 bug 是"先空等合成回合"，不写则永远不触发 → 超时误判 resume 失败）。
 *
 * 进程中途死掉：synthetic 阶段且未发任何真实输出 → ResumeFailedError（调用方降级全新会话）；否则普通 reject。
 */
function consumeTurn(
  dp: DocProcess,
  prompt: string,
  onChunk: (c: ParsedChunk) => void,
  opts: { skipSynthetic: boolean; signal?: AbortSignal },
): Promise<void> {
  const { skipSynthetic, signal } = opts;
  return new Promise((resolve, reject) => {
    let settled = false;
    let phase: 'synthetic' | 'real' = skipSynthetic ? 'synthetic' : 'real';
    let realEmitted = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => { try { dp.proc.kill('SIGTERM'); } catch { /* noop */ } };
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      signal?.removeEventListener('abort', onAbort);
      dp.onChunk = null;
      dp.onClose = null;
    };
    const done = () => { if (!settled) { settled = true; cleanup(); resolve(); } };
    const fail = (err: Error) => { if (!settled) { settled = true; cleanup(); reject(err); } };

    signal?.addEventListener('abort', onAbort);

    dp.onClose = () => {
      if (phase === 'synthetic' && !realEmitted && !signal?.aborted) fail(new ResumeFailedError('resume failed'));
      else fail(new Error(dp.stderr.trim() || 'claude 进程意外退出'));
    };

    dp.onChunk = (c) => {
      if (phase === 'synthetic') {
        // 合成回合本应是「最小纯文本、不调工具」的回合（NOTE 保证）：
        //   - tool_use → 不符合"最小回合"预期 → 保守降级，绝不冒险吞掉真实回合
        //   - error → 区分两类：真·会话失效（session 不存在等）→ 降级；瞬时 API 错误（529 过载/限流）
        //     → 绝不丢会话，把错误 surface 给用户、正常结束本轮，下次重试会重新 resume 同一会话（修：
        //     之前把所有 synthetic error 都当 resume 失败 → 一次 529 就误报"会话已过期"丢上下文）
        //   - 成功 result → 切真实阶段
        if (c.kind === 'tool_use') { fail(new ResumeFailedError('resume produced tool_use')); return; }
        if (c.kind === 'error') {
          if (FATAL_RESUME_ERROR.test(c.error || '')) { fail(new ResumeFailedError(c.error || 'resume error')); return; }
          onChunk(c); // 瞬时错误：surface 成脚注，保会话、不降级
          done();
          return;
        }
        if (c.kind === 'result') {
          phase = 'real';
          if (timer) { clearTimeout(timer); timer = null; }
        }
        return; // 吞掉合成回合的 text_delta / session_id 等
      }
      realEmitted = true;
      onChunk(c);
      if (c.kind === 'result' || c.kind === 'error') done();
    };

    // 仅 synthetic 阶段设超时：它本应秒回，迟迟不来即视为 resume 异常 → 降级
    if (skipSynthetic) {
      timer = setTimeout(() => { if (phase === 'synthetic') fail(new ResumeFailedError('synthetic-turn-timeout')); }, SYNTHETIC_TURN_TIMEOUT);
      timer.unref?.();
    }

    try { dp.proc.stdin?.write(userMsg(prompt)); }
    catch (e) { fail(e instanceof Error ? e : new Error(String(e))); }
  });
}

export interface RunTurnOpts {
  conversationId: string;
  prompt: string;
  model?: string;
  effort?: string;
  resumeSessionId?: string;
  onChunk: (c: ParsedChunk) => void;
  signal?: AbortSignal;
}

/** 跑一个对话回合（per-conversation 串行）。返回本回合结束时的会话 id，供前端持久化以备重启恢复。 */
export async function runTurn(opts: RunTurnOpts): Promise<{ sessionId: string }> {
  const { conversationId } = opts;
  const tail = turnLocks.get(conversationId) ?? Promise.resolve();
  const run = tail.then(() => doTurn(opts));
  const stored = run.catch(() => {}); // 吞掉 rejection 以免毒化锁链
  turnLocks.set(conversationId, stored);
  try {
    return await run;
  } finally {
    if (turnLocks.get(conversationId) === stored) turnLocks.delete(conversationId);
  }
}

// 一个回合跑在某个进程上：清/设 idle 定时器，跑 consumeTurn，返回会话 id。
async function turnOn(
  dp: DocProcess, prompt: string, onChunk: (c: ParsedChunk) => void,
  skipSynthetic: boolean, signal?: AbortSignal,
): Promise<{ sessionId: string }> {
  if (dp.idleTimer) { clearTimeout(dp.idleTimer); dp.idleTimer = null; }
  try {
    await consumeTurn(dp, prompt, onChunk, { skipSynthetic, signal });
    return { sessionId: dp.sessionId };
  } finally {
    if (dp.alive) armIdle(dp);
  }
}

async function doTurn(opts: RunTurnOpts): Promise<{ sessionId: string }> {
  const { conversationId, prompt, model = 'opus', effort = 'max', resumeSessionId, onChunk, signal } = opts;

  // 1) 复用存活的常驻进程 → 干净多轮，不 resume、不吞合成回合。
  //    但 effort 是 launch flag：若本轮 effort 与进程 spawn 时不同（用户改了精细度旋钮），
  //    必须重启进程才生效 → 杀掉旧的，落到下面用新 effort + resume 续上下文重启。
  const existing = procs.get(conversationId);
  if (existing?.alive) {
    if (existing.effort === effort) return turnOn(existing, prompt, onChunk, false, signal);
    try { existing.proc.kill('SIGTERM'); } catch { /* noop */ }
    procs.delete(conversationId);
  }

  // 2) 有 sessionId → server 重启 / 改 effort 后恢复：--resume + 吞掉合成前缀回合；失败再降级
  if (resumeSessionId) {
    const dp = makeProc(['--resume', resumeSessionId, ...baseArgs(model, effort)], resumeSessionId, effort);
    procs.set(conversationId, dp);
    try {
      return await turnOn(dp, prompt, onChunk, true, signal);
    } catch (e) {
      if (!(e instanceof ResumeFailedError)) throw e; // 真实阶段才出的错 → 不静默重试（避免重复输出）
      try { dp.proc.kill('SIGTERM'); } catch { /* noop */ }
      procs.delete(conversationId);
      // 落到下面全新会话
    }
  }

  // 3) 全新会话（首次开文档，或 resume 失败降级）
  const fresh = makeProc(baseArgs(model, effort), '', effort);
  procs.set(conversationId, fresh);
  // 会话过期重开 → 先在正文里诚实示意（走同一 onChunk，排在回复文本之前）
  if (resumeSessionId) onChunk({ kind: 'text_delta', text: '（上次会话已过期，已为你重新开始；之前的上下文我看不到了）\n\n' });
  return turnOn(fresh, prompt, onChunk, false, signal);
}

/**
 * 预热：开文档时悄悄把常驻进程 spawn 好，首条消息直接走 reuse（省掉 ~3-4s 冷启动）。
 * fire-and-forget。只预热「全新文档」（无 resumeSessionId）——有 session 的恢复要随真实消息触发
 * 合成回合、不能空预热（否则进程会卡在合成回合未消费、污染首条消息）。
 */
export function warmUp(conversationId: string, model = 'opus', effort = 'max', resumeSessionId?: string): void {
  if (procs.get(conversationId)?.alive) return; // 已有存活进程
  if (resumeSessionId) return;                   // 有 session 的恢复需随消息触发，不预热
  const dp = makeProc(baseArgs(model, effort), '', effort);
  procs.set(conversationId, dp);
  armIdle(dp);
}

// server 退出时尽力收尾子进程（常态下子进程会因 stdin 管道 EOF 自然退出，这里是双保险）。
process.on('exit', () => {
  for (const dp of procs.values()) { try { dp.proc.kill('SIGKILL'); } catch { /* noop */ } }
});
