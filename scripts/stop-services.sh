#!/usr/bin/env bash
set -euo pipefail

STOP_TURN=false

for arg in "$@"; do
  case "$arg" in
    --with-turn)
      STOP_TURN=true
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: ./scripts/stop-services.sh [--with-turn]"
      exit 1
      ;;
  esac
done

stop_by_pid_file() {
  local name="$1"
  local pid_file="$2"

  if [[ ! -f "$pid_file" ]]; then
    echo "$name: pid file not found ($pid_file), skip"
    return
  fi

  local pid
  pid="$(cat "$pid_file")"

  if [[ -z "$pid" ]]; then
    echo "$name: pid file is empty, removing"
    rm -f "$pid_file"
    return
  fi

  if kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    sleep 1
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
      echo "$name: force killed pid $pid"
    else
      echo "$name: stopped pid $pid"
    fi
  else
    echo "$name: process not running (pid $pid), cleaning pid file"
  fi

  rm -f "$pid_file"
}

echo "Stopping NAS Bridge services..."
stop_by_pid_file "server" ".run/server.pid"
stop_by_pid_file "storage-client" ".run/storage-client.pid"

if [[ "$STOP_TURN" == "true" ]]; then
  if command -v docker >/dev/null 2>&1; then
    if [[ -f "deploy/turn/docker-compose.yml" ]]; then
      docker compose --env-file deploy/turn/.env -f deploy/turn/docker-compose.yml down || true
      echo "turn: stopped"
    else
      echo "turn: compose file not found, skip"
    fi
  else
    echo "turn: docker command not found, skip"
  fi
fi

echo "Done."
