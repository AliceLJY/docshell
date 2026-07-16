#!/bin/bash

# Shared startup boundary for every supported DocShell launcher.
# Next Route Handlers do not expose a trustworthy peer socket address, so the
# auth layer relies on this process-local attestation when DOCSHELL_TOKEN is absent.
docshell_guard_launch() {
  if [ "$#" -ne 4 ]; then
    echo "[docshell] internal launch-guard error: expected project root, bind host, bind port, and Next mode." >&2
    return 1
  fi

  local project_root="$1"
  local bind_host="$2"
  local bind_port="$3"
  local next_mode="$4"

  node "$project_root/scripts/check-bind.mjs" "$project_root" "$bind_host" "$bind_port" "$next_mode" || return 1

  # These values are inherited by the exact Next process launched with bind_host.
  # lib/auth.ts rejects no-token requests if any attestation value is absent or inconsistent.
  export DOCSHELL_BIND_GUARD="loopback-bind-v1"
  export DOCSHELL_BIND_HOST="$bind_host"
  export DOCSHELL_BIND_PORT="$bind_port"
}
