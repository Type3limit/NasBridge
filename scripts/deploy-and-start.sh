#!/usr/bin/env bash
set -euo pipefail

ENABLE_TURN=false
ENABLE_TURN_WSL=false
SERVER_ENV_PATH="server/.env"
CLIENT_ENV_PATH="storage-client/.env"
WEB_ENV_PATH="web/.env"

for arg in "$@"; do
  case "$arg" in
    --enable-turn)
      ENABLE_TURN=true
      ;;
    --enable-turn-wsl)
      ENABLE_TURN_WSL=true
      ;;
    --server-env=*)
      SERVER_ENV_PATH="${arg#*=}"
      ;;
    --client-env=*)
      CLIENT_ENV_PATH="${arg#*=}"
      ;;
    --web-env=*)
      WEB_ENV_PATH="${arg#*=}"
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: ./scripts/deploy-and-start.sh [--enable-turn|--enable-turn-wsl] [--server-env=path] [--client-env=path] [--web-env=path]"
      exit 1
      ;;
  esac
done

ensure_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Required command not found: $name" >&2
    exit 1
  fi
}

ensure_file_from_example() {
  local target="$1"
  local example="$2"
  if [[ ! -f "$target" ]]; then
    cp "$example" "$target"
    echo "Created $target from $example"
  fi
}

echo "[1/6] Checking prerequisites..."
ensure_command node
ensure_command npm

if [[ "$ENABLE_TURN" == "true" ]]; then
  ensure_command docker
fi

echo "[2/6] Preparing env files..."
ensure_file_from_example "$SERVER_ENV_PATH" "server/.env.example"
ensure_file_from_example "$CLIENT_ENV_PATH" "storage-client/.env.example"
ensure_file_from_example "$WEB_ENV_PATH" "web/.env.example"

if [[ "$ENABLE_TURN" == "true" ]]; then
  echo "[3/6] Starting TURN (coturn) with Docker..."
  if [[ ! -f "deploy/turn/.env" ]]; then
    cp "deploy/turn/.env.example" "deploy/turn/.env"
    echo "Created deploy/turn/.env from deploy/turn/.env.example"
    echo "Please edit deploy/turn/.env and set TURN_EXTERNAL_IP before production use."
  fi
  docker compose --env-file deploy/turn/.env -f deploy/turn/docker-compose.yml up -d
elif [[ "$ENABLE_TURN_WSL" == "true" ]]; then
  echo "[3/6] Starting TURN (coturn) natively in WSL (no Docker)..."
  bash scripts/start-turn-wsl.sh
else
  echo "[3/6] Skipping TURN startup (use --enable-turn or --enable-turn-wsl to enable)."
fi

echo "[4/6] Installing dependencies..."
npm install

echo "[5/6] Building web..."
npm run build -w web

echo "[6/6] Starting server and storage client..."
mkdir -p .run

nohup npm run start -w server > .run/server.log 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > .run/server.pid

nohup npm run start -w storage-client > .run/storage-client.log 2>&1 &
CLIENT_PID=$!
echo "$CLIENT_PID" > .run/storage-client.pid

echo "All services started."
echo "- Server PID: $SERVER_PID (log: .run/server.log)"
echo "- Client PID: $CLIENT_PID (log: .run/storage-client.log)"
echo "- Server URL: http://localhost:8080"
echo "- To stop: kill \$(cat .run/server.pid) \$(cat .run/storage-client.pid)"
