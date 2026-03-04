#!/usr/bin/env bash
set -euo pipefail

# One-click deploy for Ubuntu 24.04 LTS (server + web + TURN)
# Run from repo root: sudo bash scripts/deploy-ubuntu-24.sh

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ---- Config (edit or pass via env) ----
SERVER_PORT="${SERVER_PORT:-9000}"
TURN_PORT="${TURN_PORT:-3478}"
TURN_MIN_PORT="${TURN_MIN_PORT:-49152}"
TURN_MAX_PORT="${TURN_MAX_PORT:-49200}"
TURN_REALM="${TURN_REALM:-nas-bridge.local}"
TURN_USERNAME="${TURN_USERNAME:-nasuser}"
TURN_PASSWORD="${TURN_PASSWORD:-naspass123}"
START_STORAGE_CLIENT="${START_STORAGE_CLIENT:-false}"

SERVER_ENV="server/.env"
CLIENT_ENV="storage-client/.env"
WEB_ENV="web/.env"
TURN_ENV="deploy/turn/.env"

log() { echo "[deploy] $*"; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "Missing command: $1"
    exit 1
  fi
}

ensure_env() {
  local target="$1"
  local example="$2"
  if [[ ! -f "$target" ]]; then
    cp "$example" "$target"
    log "Created $target from $example"
  fi
}

# ---- System deps ----
log "Installing system dependencies..."
sudo apt-get update -qq
sudo apt-get install -y curl git ufw coturn

# ---- Node.js 20 LTS ----
if ! command -v node >/dev/null 2>&1; then
  log "Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
require_cmd node
require_cmd npm

# ---- Detect LAN IP ----
LAN_IP="${LAN_IP:-}"
PUBLIC_IP="${PUBLIC_IP:-}"
if [[ -z "$LAN_IP" ]]; then
  LAN_IP=$(hostname -I | tr ' ' '\n' | grep -v '^127\.' | head -1 || true)
fi
if [[ -z "$LAN_IP" ]]; then
  log "Could not detect LAN IP. Set LAN_IP environment variable and rerun."
  exit 1
fi
log "Using LAN IP: $LAN_IP"
if [[ -n "$PUBLIC_IP" ]]; then
  log "Using PUBLIC IP: $PUBLIC_IP"
fi

# ---- Prepare env files ----
log "Preparing .env files..."
ensure_env "$SERVER_ENV" "server/.env.example"
ensure_env "$WEB_ENV" "web/.env.example"
ensure_env "$TURN_ENV" "deploy/turn/.env.example"
if [[ "$START_STORAGE_CLIENT" == "true" ]]; then
  ensure_env "$CLIENT_ENV" "storage-client/.env.example"
fi

# server/.env
sed -i "s#^SERVER_BASE_URL=.*#SERVER_BASE_URL=http://localhost:${SERVER_PORT}#" "$SERVER_ENV" || true
sed -i "s#^VITE_SERVER_BASE_URL=.*#VITE_SERVER_BASE_URL=http://${LAN_IP}:${SERVER_PORT}#" "$WEB_ENV" || true

# TURN envs
TURN_EXTERNAL_IP_VALUE="$LAN_IP"
if [[ -n "$PUBLIC_IP" ]]; then
  TURN_EXTERNAL_IP_VALUE="$PUBLIC_IP"
fi
sed -i "s#^TURN_EXTERNAL_IP=.*#TURN_EXTERNAL_IP=${TURN_EXTERNAL_IP_VALUE}#" "$TURN_ENV" || true
sed -i "s#^TURN_REALM=.*#TURN_REALM=${TURN_REALM}#" "$TURN_ENV" || true
sed -i "s#^TURN_USERNAME=.*#TURN_USERNAME=${TURN_USERNAME}#" "$TURN_ENV" || true
sed -i "s#^TURN_PASSWORD=.*#TURN_PASSWORD=${TURN_PASSWORD}#" "$TURN_ENV" || true
sed -i "s#^TURN_PORT=.*#TURN_PORT=${TURN_PORT}#" "$TURN_ENV" || true

TURN_URL_HOST="$LAN_IP"
if [[ -n "$PUBLIC_IP" ]]; then
  TURN_URL_HOST="$PUBLIC_IP"
fi
sed -i "s#^VITE_TURN_URL=.*#VITE_TURN_URL=turn:${TURN_URL_HOST}:${TURN_PORT}#" "$WEB_ENV" || true
sed -i "s#^VITE_TURN_USERNAME=.*#VITE_TURN_USERNAME=${TURN_USERNAME}#" "$WEB_ENV" || true
sed -i "s#^VITE_TURN_CREDENTIAL=.*#VITE_TURN_CREDENTIAL=${TURN_PASSWORD}#" "$WEB_ENV" || true

if [[ "$START_STORAGE_CLIENT" == "true" ]]; then
  sed -i "s#^TURN_URL=.*#TURN_URL=turn:${TURN_URL_HOST}:${TURN_PORT}#" "$CLIENT_ENV" || true
  sed -i "s#^TURN_USERNAME=.*#TURN_USERNAME=${TURN_USERNAME}#" "$CLIENT_ENV" || true
  sed -i "s#^TURN_CREDENTIAL=.*#TURN_CREDENTIAL=${TURN_PASSWORD}#" "$CLIENT_ENV" || true
fi

# ---- Configure coturn ----
log "Configuring coturn..."
COTURN_CONF="/etc/turnserver.conf"
cat > "$COTURN_CONF" <<EOF
listening-port=${TURN_PORT}
external-ip=${LAN_IP}
realm=${TURN_REALM}
lt-cred-mech
user=${TURN_USERNAME}:${TURN_PASSWORD}
fingerprint
no-multicast-peers
min-port=${TURN_MIN_PORT}
max-port=${TURN_MAX_PORT}
EOF

# Enable and restart coturn
sudo sed -i "s/^TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/" /etc/default/coturn || true
sudo systemctl enable coturn
sudo systemctl restart coturn

# ---- Firewall ----
log "Opening firewall ports..."
sudo ufw allow ${SERVER_PORT}/tcp
sudo ufw allow ${TURN_PORT}/udp
sudo ufw allow ${TURN_PORT}/tcp
sudo ufw allow ${TURN_MIN_PORT}:${TURN_MAX_PORT}/udp
sudo ufw --force enable

# ---- Install deps & build ----
log "Installing npm dependencies..."
npm install

log "Building web..."
npm run build -w web

# ---- Start services (systemd user services) ----
log "Starting server with nohup..."
mkdir -p .run
nohup npm run start -w server > .run/server.log 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > .run/server.pid
if [[ "$START_STORAGE_CLIENT" == "true" ]]; then
  log "Starting storage-client with nohup..."
  nohup npm run start -w storage-client > .run/storage-client.log 2>&1 &
  CLIENT_PID=$!
  echo "$CLIENT_PID" > .run/storage-client.pid
fi

log "Done."
SERVER_HOST="$LAN_IP"
if [[ -n "$PUBLIC_IP" ]]; then
  SERVER_HOST="$PUBLIC_IP"
fi
log "Server: http://${SERVER_HOST}:${SERVER_PORT}"
log "TURN: turn:${TURN_URL_HOST}:${TURN_PORT} (relay ${TURN_MIN_PORT}-${TURN_MAX_PORT})"
if [[ "$START_STORAGE_CLIENT" == "true" ]]; then
  log "PIDs: server=${SERVER_PID} client=${CLIENT_PID}"
  log "Logs: .run/server.log .run/storage-client.log"
else
  log "PIDs: server=${SERVER_PID}"
  log "Logs: .run/server.log"
fi
