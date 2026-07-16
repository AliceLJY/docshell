#!/bin/bash
# DocShell production build + background start.
# Safe default is loopback. Network binding must be requested explicitly and requires DOCSHELL_TOKEN.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

source "$SCRIPT_DIR/launch-guard.sh"

# 后台进程的 PATH 可能不含 claude → cc-process 的 spawn('claude') 会失败。补进常见安装路径。
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

export PORT="${PORT:-3010}"
export DOCSHELL_HOST="${DOCSHELL_HOST:-127.0.0.1}"
docshell_guard_launch "$PROJECT_ROOT" "$DOCSHELL_HOST" "$PORT" production

echo "[docshell] building..."
npm run build

echo "[docshell] (re)starting on $DOCSHELL_HOST:$PORT ..."
LISTENER_PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$LISTENER_PIDS" ]; then
  # next-server rewrites its process title, so command-line matching cannot reliably stop the old bind.
  # Verify cwd before stopping anything so an unrelated service on the same port is never killed.
  while IFS= read -r listener_pid; do
    [ -z "$listener_pid" ] && continue
    LISTENER_CWD="$(lsof -a -p "$listener_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    if [ "$LISTENER_CWD" != "$PROJECT_ROOT" ]; then
      echo "[docshell] refusing to stop unrelated listener PID $listener_pid on port $PORT." >&2
      exit 1
    fi
  done <<< "$LISTENER_PIDS"
  while IFS= read -r listener_pid; do
    [ -n "$listener_pid" ] && kill "$listener_pid"
  done <<< "$LISTENER_PIDS"
fi
sleep 1
nohup node node_modules/.bin/next start --hostname "$DOCSHELL_HOST" --port "$PORT" > /tmp/docshell.log 2>&1 &
SERVER_PID=$!
sleep 2
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "[docshell] server exited during startup; see /tmp/docshell.log" >&2
  exit 1
fi
echo "[docshell] started PID $SERVER_PID on $DOCSHELL_HOST:$PORT (log: /tmp/docshell.log)"
if [ "$DOCSHELL_HOST" = "127.0.0.1" ]; then
  echo "[docshell] open: http://127.0.0.1:$PORT/"
elif [ "$DOCSHELL_HOST" = "::1" ]; then
  echo "[docshell] open: http://[::1]:$PORT/"
else
  # Use a URL fragment so the token is not sent in the HTTP request or access log.
  echo "[docshell] open: http://<server-ip>:$PORT/#token=<your-token>"
fi
