#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

source "$SCRIPT_DIR/launch-guard.sh"

export DOCSHELL_HOST="${DOCSHELL_HOST:-127.0.0.1}"
export PORT="${PORT:-3000}"
docshell_guard_launch "$PROJECT_ROOT" "$DOCSHELL_HOST" "$PORT" development

exec node node_modules/.bin/next dev --hostname "$DOCSHELL_HOST" --port "$PORT"
