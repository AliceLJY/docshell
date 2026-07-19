#!/bin/bash

# Create a new, private log file for a background DocShell server. The unique
# filename avoids following a pre-created log symlink during shell redirection.
docshell_create_private_log() {
  local state_root log_dir log_file
  umask 077
  state_root="${XDG_STATE_HOME:-$HOME/.local/state}"
  log_dir="${DOCSHELL_LOG_DIR:-$state_root/docshell/logs}"

  case "$log_dir" in
    /*) ;;
    *)
      echo "[docshell] log directory must be an absolute path." >&2
      return 1
      ;;
  esac
  if [ -L "$log_dir" ]; then
    echo "[docshell] refusing symlink log directory: $log_dir" >&2
    return 1
  fi

  mkdir -p "$log_dir"
  if [ ! -d "$log_dir" ] || [ -L "$log_dir" ]; then
    echo "[docshell] log directory is not a private directory: $log_dir" >&2
    return 1
  fi
  chmod 700 "$log_dir"

  log_file="$(mktemp "$log_dir/docshell.XXXXXX")"
  chmod 600 "$log_file"
  printf '%s\n' "$log_file"
}
