#!/bin/bash
# DocShell 生产服务进程（供 macOS launchd LaunchAgent 调用）。
#
# 为什么用 launchd（macOS 部署要点）：claude 的订阅凭证存在登录会话的 Keychain 里。非交互方式
# （如 ssh 起的后台进程）不在登录会话、读不到 keychain → claude 报 "Not logged in"。把服务做成
# LaunchAgent 并 bootstrap 进 gui 域，让它跑在用户 GUI 登录会话上下文 → 能读 keychain，订阅认证
# 正常。RunAtLoad + KeepAlive 顺带给开机 / 崩溃持久化。
#
# 只启动已 build 的生产服务，不 build（build 由 start-prod.sh 或部署流程单独做）。
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PORT="${PORT:-3010}"
# exec → launchd 直接跟踪 node 进程（DOCSHELL_TOKEN 由 Next.js 从 .env.local 自动载入）
exec node node_modules/.bin/next start --hostname 0.0.0.0 --port "$PORT"
