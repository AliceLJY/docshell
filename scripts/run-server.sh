#!/bin/bash
# DocShell 生产服务进程（供 macOS launchd LaunchAgent 调用）。
#
# 为什么用 launchd（macOS 部署要点）：claude 的订阅凭证存在登录会话的 Keychain 里。非交互方式
# （如 ssh 起的后台进程）不在登录会话、读不到 keychain → claude 报 "Not logged in"。把服务做成
# LaunchAgent 并 bootstrap 进 gui 域，让它跑在用户 GUI 登录会话上下文 → 能读 keychain，订阅认证
# 正常。RunAtLoad + KeepAlive 顺带给开机 / 崩溃持久化。
#
# 只启动已 build 的生产服务，不 build（build 由 start-prod.sh 或部署流程单独做）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

source "$SCRIPT_DIR/launch-guard.sh"

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PORT="${PORT:-3010}"
export DOCSHELL_HOST="${DOCSHELL_HOST:-127.0.0.1}"
docshell_guard_launch "$PROJECT_ROOT" "$DOCSHELL_HOST" "$PORT" production

# exec → launchd directly tracks the guarded Next process.
exec node node_modules/.bin/next start --hostname "$DOCSHELL_HOST" --port "$PORT"
