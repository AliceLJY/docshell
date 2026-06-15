#!/bin/bash
# DocShell - 一键重建 + 重启本地 server
set -e

cd "$(dirname "$0")/.."
echo "🔨 Building..."
npx next build

echo "🔄 Restarting server on port 3088..."
lsof -i :3088 -t 2>/dev/null | xargs kill 2>/dev/null || true
sleep 1

# 安全：绑 127.0.0.1，仅本机访问——无认证 + bypassPermissions 的服务绝不能暴露到网络
nohup npx next start --port 3088 --hostname 127.0.0.1 > /tmp/docshell.log 2>&1 &
echo "✅ DocShell running (本地 only):"
echo "   http://localhost:3088"
echo "   Logs: /tmp/docshell.log"
