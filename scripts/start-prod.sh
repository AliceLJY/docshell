#!/bin/bash
# DocShell 生产启动（网络部署）：绑 0.0.0.0 + 强制 DOCSHELL_TOKEN。
# token 放 .env.local（gitignore），Next.js 自动载入 server 运行时 process.env。
set -euo pipefail
cd "$(dirname "$0")/.."

# 后台进程的 PATH 可能不含 claude → cc-process 的 spawn('claude') 会失败。补进常见安装路径。
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

PORT="${PORT:-3010}"

# 安全卫士：绑 0.0.0.0 暴露到网络，必须有 token，否则就是无认证 RCE，拒绝启动。
if [ ! -f .env.local ] || ! grep -q '^DOCSHELL_TOKEN=..' .env.local; then
  echo "[docshell] 拒绝启动：.env.local 缺 DOCSHELL_TOKEN（绑 0.0.0.0 必须有令牌）。" >&2
  echo "[docshell] 生成一个：echo \"DOCSHELL_TOKEN=\$(openssl rand -hex 16)\" >> .env.local" >&2
  exit 1
fi

echo "[docshell] building..."
npm run build

echo "[docshell] (re)starting on 0.0.0.0:$PORT ..."
pkill -f "next start --hostname 0.0.0.0" 2>/dev/null || true
sleep 1
nohup npx next start --hostname 0.0.0.0 --port "$PORT" > /tmp/docshell.log 2>&1 &
sleep 2
echo "[docshell] started PID $! on 0.0.0.0:$PORT (log: /tmp/docshell.log)"
echo "[docshell] 访问： http://<server-ip>:$PORT/?token=<你的token>"
