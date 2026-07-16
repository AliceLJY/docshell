#!/bin/bash
# DocShell - rebuild and restart the GUI-session LaunchAgent safely.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

LABEL="${DOCSHELL_LAUNCHD_LABEL:-com.docshell.server}"
DOMAIN="gui/$(id -u)"
HOST="${DOCSHELL_HOST:-127.0.0.1}"
PORT="${PORT:-3010}"
URL_HOST="$HOST"
[ "$URL_HOST" = "::1" ] && URL_HOST="[::1]"

echo "[docshell] building..."
npm run build

if ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo "[docshell] $LABEL is not loaded; use scripts/start-prod.sh or bootstrap the LaunchAgent first." >&2
  exit 1
fi

echo "[docshell] restarting $LABEL through launchd..."
launchctl kickstart -k "$DOMAIN/$LABEL"
for _ in $(seq 1 40); do
  if curl --max-time 1 -fsS -o /dev/null "http://$URL_HOST:$PORT/" 2>/dev/null; then
    echo "[docshell] ready at http://$URL_HOST:$PORT/"
    exit 0
  fi
  sleep 0.25
done

echo "[docshell] restart was requested but the page did not become ready." >&2
exit 1
