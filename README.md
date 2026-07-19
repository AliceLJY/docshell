# DocShell

> A document-style interface for the **Claude Code CLI**. You type a paragraph, the model replies as the next paragraph, and the work it does along the way shows up as **margin comments** and **revisions** — like a document editor, not a chat window or a terminal.

[中文说明 / Chinese README](./README_CN.md)

![DocShell — your message and the model's reply are document paragraphs; the files it reads and commands it runs surface as collapsible margin comments in the right rail.](docs/assets/docshell-ui.png)

---

## Why

Most AI coding frontends look like a chat app or a terminal: bubbles, avatars, "user / assistant" labels, a model picker, Send/Stop buttons, a scrolling log. DocShell takes a different stance — a **calm, document-shaped surface**:

- **Your message** is just a paragraph in the document body.
- **The model's reply** is the next paragraph.
- **Tool calls and the process in between** become **margin comments** (a one-line summary you can expand) and **inline revisions** (strikethrough + additions for file edits).

The middle process is *visible but unobtrusive* — you can see what the agent read, ran, and changed, without the page turning into a white-background terminal log.

## Features

- **Document-style UI** — no chat bubbles, avatars, role labels, sidebar, model selector, or New Chat / Send / Stop buttons. Input and output are both document paragraphs.
- **Process visibility** — tool calls land in the right-hand margin as collapsible comments (`Read 2 files`, `ran ls`, …); file edits render as inline revisions.
- **Real Claude Code backend, your subscription** — spawns the local `claude` CLI over its OAuth login (your Claude Code subscription), **not** the API/SDK. Claude Code is the only backend currently implemented.
- **Clean multi-turn** — one persistent `claude --input-format stream-json` process per document; context stays continuous across turns. Survives server restarts via `--resume`.
- **Multiple documents** — create / switch between docs; each is its own conversation, persisted locally (IndexedDB). Refresh starts a fresh conversation; old docs remain in the File menu.
- **Type-ahead queue** — keep typing while a reply streams; follow-ups queue and send automatically.
- **Esc to interrupt** — stop a generation mid-stream (the Ctrl-C you don't have in a doc).
- **Safety handbrake** — a `PreToolUse` hook hard-blocks catastrophic Bash (`rm` of root/home/system dirs, `mkfs`, `dd` to block devices, fork bombs, `shred`). It's a handbrake, **not a sandbox** (see [Security](#security)).
- **Token auth for network deploy** — a non-loopback bind requires a shared token of at least 32 characters, so you can reach it from another device over a private network without leaving the agent API open.

## How it works

```
Browser (document UI)              Server (Next.js, your machine)
┌───────────────────────┐         ┌─────────────────────────────────┐
│  paragraphs (in/out)  │◄──SSE──►│  /api/chat                       │
│  margin comments      │         │   └─ lib/cc-process.ts           │
│  IndexedDB (docs)     │         │       per-doc persistent process │──► claude (stream-json)
└───────────────────────┘         │       lib/stream-parser.ts       │
                                   │       lib/tool-comment.ts        │
                                   └─────────────────────────────────┘
```

- **`lib/cc-process.ts`** keeps one persistent `claude --input-format stream-json` process per document and feeds each turn as a structured message over stdin. This gives clean multi-turn memory and avoids the synthetic "Continue from where you left off" turn that `--resume` injects. After a server restart it recovers a document's context with `--resume <sessionId>` (swallowing the synthetic recovery turn).
- **`lib/stream-parser.ts`** parses the CLI's `stream-json` into chunks (text deltas, tool_use, tool_result, result, errors).
- **`lib/tool-comment.ts`** shapes tool calls into margin comments / revisions.
- The frontend (`app/page.tsx`) renders everything as a document and streams replies over SSE.

## Quick start (local)

Prerequisites:

- Node.js 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and logged in (`claude` on your `PATH`)

```bash
npm install
npm run dev   # http://127.0.0.1:3000
```

The guarded launcher binds to `127.0.0.1`, so no token is required (same-machine only). Open the page and start typing. Direct `npx next ...` launches do not create the local-only auth attestation and are intentionally rejected by the API when no token is set.

## Production / network deploy

`scripts/start-prod.sh` and `scripts/run-server.sh` default to `127.0.0.1`. To reach DocShell from another device on a private network, request a network bind explicitly **and set a token**. Every supported launcher fails closed if a non-loopback address is used without `DOCSHELL_TOKEN`:

```bash
npm run token:init
DOCSHELL_HOST=0.0.0.0 PORT=3010 bash scripts/start-prod.sh
```

Then open `http://<server-ip>:<port>/#token=<your-token>` once; the token is stored in the browser afterward. The token is accepted only from the URL **fragment**, which browsers never send to the server, so it stays out of access logs; `?token=` query parameters are intentionally not supported.

On macOS, run it via a **launchd LaunchAgent in the GUI session** (`scripts/run-server.sh`) rather than a bare SSH/background process — otherwise the `claude` CLI can't read the login Keychain where its subscription credentials live, and you'll see `Not logged in`.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `DOCSHELL_TOKEN` | _(unset)_ | If set, every API request must carry a matching `x-docshell-token` header. A value of at least 32 characters is required for every non-loopback bind. |
| `DOCSHELL_HOST` | `127.0.0.1` | Bind address. Without a token, only literal `127.0.0.1` or `::1` is accepted. |
| `PORT` | `3010` (prod) | Server port. |
| `DOCSHELL_NO_REMOTE_CONTROL` | _(unset)_ | Set to `1` to disable Claude's Remote Control on spawned sessions. |
| `DOCSHELL_MAX_PROCESSES` | `8` | Maximum resident Claude processes. New turns evict the least-recently-used idle process; active streams are never evicted. Valid range: 1–64. |
| `DOCSHELL_LOG_DIR` | `$XDG_STATE_HOME/docshell/logs` or `~/.local/state/docshell/logs` | Private directory for unique mode-`600` logs created by `start-prod.sh`. |

The backend is currently Claude Code and the model is currently fixed to `opus`. Effort is chosen in the document's settings panel (Standard / Deep / Fast → `high` / `max` / `low`); the default is `max`.

## Security

DocShell runs the agent with `--permission-mode bypassPermissions` (tools auto-execute) plus a destructive-command guard. **This is a handbrake, not a sandbox:**

- The guard only blocks a small set of blatant, irreversible commands; it can be bypassed by obfuscation (base64-pipe-to-shell, child interpreters, etc.).
- The working directory is the user's `HOME` by default.
- Server-only `DOCSHELL_*` authentication and bind variables are removed from the Claude child process environment, but the agent still runs as the same OS user and can access that user's permitted files. Use a separate account or stronger isolation for untrusted content.
- Uploaded temporary files are kept in a user-owned mode-`700` directory as mode-`600` files and are removed after each turn; a hard crash can still leave temporary files behind.

For anything beyond personal local use, isolate properly (container / restricted account / read-only mounts / scoped cwd), and keep `DOCSHELL_TOKEN` set whenever the server is reachable over a network. Token-in-custom-header is CSRF-resistant.

In no-token mode, Next.js does not expose a trustworthy peer socket address to Route Handlers. DocShell therefore permits requests only when its shared startup guard has attested that the exact server process was bound to the configured port on literal `127.0.0.1` or `::1`; missing or inconsistent host/port attestation is rejected. Exact same-origin validation remains an additional browser-side CSRF check, not evidence of the network source.

## Tech

Next.js · React · TypeScript · Server-Sent Events · IndexedDB · the Claude Code CLI.

## License

MIT
