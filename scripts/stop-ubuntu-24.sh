#!/usr/bin/env bash
set -euo pipefail

# Stop services started by deploy-ubuntu-24.sh
# Run from repo root: sudo bash scripts/stop-ubuntu-24.sh

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[stop] $*"; }

stop_pidfile() {
  local pidfile="$1"
  local name="$2"
  if [[ -f "$pidfile" ]]; then
    local pid
    pid=$(cat "$pidfile" 2>/dev/null || true)
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      log "Stopping $name (pid=$pid)..."
      kill "$pid" || true
      sleep 1
    else
      log "$name pidfile exists but process not running."
    fi
    rm -f "$pidfile"
  else
    log "$name pidfile not found."
  fi
}

stop_pidfile ".run/server.pid" "server"
stop_pidfile ".run/storage-client.pid" "storage-client"

if systemctl is-active --quiet coturn; then
  log "Stopping coturn..."
  sudo systemctl stop coturn
else
  log "coturn is not running."
fi

log "Done."
