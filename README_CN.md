# DocShell

> 给 **Claude Code**（及 Codex）CLI 套一层「文档式」界面。你打一段字，模型的回复就是下一段正文，它中间做的事（读文件、跑命令、改代码）以**页边批注**和**修订记录**的形式呈现——像在用文档编辑器，而不是聊天窗口或终端。

[English README](./README.md)

---

## 为什么做这个

大多数 AI 编码前端长得像聊天应用或终端：气泡、头像、「user / assistant」标签、模型选择器、Send/Stop 按钮、不断滚动的日志。DocShell 走另一条路——一个**安静的、文档形状的界面**：

- **你的输入**就是文档正文里的一段。
- **模型的回复**是下一段正文。
- **工具调用和中间过程**变成**页边批注**（一行摘要，可展开看细节）和**正文里的修订记录**（文件改动以删除线 + 新增呈现）。

中间过程「可见但不喧宾夺主」——你能看到 agent 读了什么、跑了什么、改了什么，但页面不会变成一个白底的终端日志。

## 功能

- **文档式界面**——没有聊天气泡、头像、角色标签、侧边栏、模型选择器，也没有 New Chat / Send / Stop 按钮。输入和输出都是文档段落。
- **过程可见**——工具调用落在右侧页边、成为可折叠批注（「读取 2 个文件」「运行 ls」…）；文件编辑渲染成正文里的修订。
- **真 CLI 后端、用你的订阅**——spawn 本地 `claude` CLI、走它的 OAuth 登录（你的 Claude Code 订阅），**不是** API/SDK。双后端就绪（Claude / Codex）。
- **干净的多轮**——每个文档一个常驻 `claude --input-format stream-json` 进程，跨轮上下文连续；服务器重启后用 `--resume` 恢复。
- **多文档**——新建 / 切换文档，每个是独立对话、本地持久化（IndexedDB）。刷新即开新对话，旧文档仍在「文件」菜单里。
- **边等边输入（排队）**——回复还在生成时也能继续打字，补充的消息排队、自动接力发出。
- **Esc 中断**——生成中途停下（文档里没有 Ctrl-C，用 Esc 代替）。
- **危险命令手刹**——`PreToolUse` hook 硬拦灾难性 Bash（删根/家/系统目录的 `rm`、`mkfs`、`dd` 写块设备、fork 炸弹、`shred`）。它是**手刹，不是沙箱**（见[安全](#安全)）。
- **网络部署的 token 认证**——绑到 `0.0.0.0` 并要求共享 token，就能从私有网络里的另一台设备访问。

## 工作原理

```
浏览器（文档界面）                  服务端（Next.js，你的机器）
┌───────────────────────┐         ┌─────────────────────────────────┐
│  正文段（输入/输出）   │◄──SSE──►│  /api/chat                       │
│  页边批注             │         │   └─ lib/cc-process.ts           │
│  IndexedDB（文档）    │         │       每文档常驻进程             │──► claude (stream-json)
└───────────────────────┘         │       lib/stream-parser.ts       │
                                   │       lib/tool-comment.ts        │
                                   └─────────────────────────────────┘
```

- **`lib/cc-process.ts`** 为每个文档维持一个常驻 `claude --input-format stream-json` 进程，每轮把消息以结构化形式通过 stdin 喂进去。这样多轮记忆天然连续，并避开 `--resume` 注入的「Continue from where you left off」合成回合。服务器重启后用 `--resume <sessionId>` 恢复某文档的上下文（并吞掉那个合成恢复回合）。
- **`lib/stream-parser.ts`** 把 CLI 的 `stream-json` 解析成 chunk（文本增量、tool_use、tool_result、result、错误）。
- **`lib/tool-comment.ts`** 把工具调用塑形成页边批注 / 修订。
- 前端（`app/page.tsx`）把这一切渲染成文档，回复经 SSE 流式接收。

## 快速开始（本地）

前置：

- Node.js 20+
- 已安装并登录的 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（`claude` 在你的 `PATH` 里）

```bash
npm install
npx next dev --hostname 127.0.0.1   # http://127.0.0.1:3000
```

绑 `127.0.0.1` 时不需要 token（仅本机可访问）。打开页面开始打字即可。

## 生产 / 网络部署

要从私有网络里另一台设备访问 DocShell，绑到 `0.0.0.0` **并设一个 token**（不设 token 时应用会拒绝在 `0.0.0.0` 上启动）：

```bash
echo "DOCSHELL_TOKEN=$(openssl rand -hex 16)" >> .env.local
PORT=3010 bash scripts/start-prod.sh
```

然后用 `http://<server-ip>:<port>/?token=<你的token>` 打开一次；之后 token 会存进浏览器。

在 macOS 上，请通过**跑在 GUI 会话里的 launchd LaunchAgent**（`scripts/run-server.sh`）启动，而不是裸的 SSH / 后台进程——否则 `claude` CLI 读不到登录会话 Keychain 里的订阅凭证，会报 `Not logged in`。

## 配置

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `DOCSHELL_TOKEN` | _(未设)_ | 设了之后，每个请求都必须带匹配的 `x-docshell-token` 头。绑 `0.0.0.0` 时必须设。 |
| `PORT` | `3010`（生产） | 服务端口。 |
| `DOCSHELL_NO_REMOTE_CONTROL` | _(未设)_ | 设为 `1` 可关闭对 spawn 出的会话开启 Claude Remote Control。 |

模型与精细度在文档的设置面板里选（标准 / 深度 / 快速 → effort `high` / `max` / `low`）；默认 `opus` + `max` effort。

## 安全

DocShell 以 `--permission-mode bypassPermissions`（工具自动执行）+ 危险命令护栏运行。**这是手刹，不是沙箱：**

- 护栏只拦一小撮直白、不可逆的命令；可被混淆写法绕过（base64 管道进 shell、子解释器等）。
- 工作目录默认是用户的 `HOME`。

任何超出「个人本地使用」的场景，请做真正的隔离（容器 / 受限账户 / 只读挂载 / 限定 cwd），并在服务可经网络访问时始终设置 `DOCSHELL_TOKEN`。token 放自定义头天然防 CSRF；不设 token 的本机回退模式依赖同源校验。

## 技术栈

Next.js · React · TypeScript · Server-Sent Events · IndexedDB · Claude Code CLI。

## 许可

MIT
