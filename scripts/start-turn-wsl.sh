#!/usr/bin/env bash
# start-turn-wsl.sh
# Installs (if needed) and starts coturn directly inside WSL2 – no Docker required.
# Run from the repo root:  bash scripts/start-turn-wsl.sh
set -euo pipefail

ENV_FILE="deploy/turn/.env"
ENV_EXAMPLE="deploy/turn/.env.example"

# ── load .env ────────────────────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  echo "[turn] Created $ENV_FILE from example – please edit TURN_EXTERNAL_IP."
fi

# Source the .env (skip comment lines)
set -o allexport
# shellcheck disable=SC2046
eval $(grep -v '^\s*#' "$ENV_FILE" | grep '=')
set +o allexport

TURN_EXTERNAL_IP="${TURN_EXTERNAL_IP:-}"
TURN_REALM="${TURN_REALM:-nas-bridge.local}"
TURN_USERNAME="${TURN_USERNAME:-nasuser}"
TURN_PASSWORD="${TURN_PASSWORD:-naspass123}"
TURN_PORT="${TURN_PORT:-3478}"

if [[ -z "$TURN_EXTERNAL_IP" || "$TURN_EXTERNAL_IP" == "192.168.x.x" ]]; then
  # Auto-detect the Windows host LAN IP from WSL (the default route's gateway)
  AUTO_IP=$(ip route show default 2>/dev/null | awk '/default/ {print $3}' | head -1)
  if [[ -z "$AUTO_IP" ]]; then
    # Fallback: find the first non-loopback IPv4 address
    AUTO_IP=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^127\.' | grep -v '^::' | head -1)
  fi
  if [[ -n "$AUTO_IP" ]]; then
    echo "[turn] TURN_EXTERNAL_IP not set – auto-detected: $AUTO_IP"
    TURN_EXTERNAL_IP="$AUTO_IP"
  else
    echo "[turn] ERROR: could not auto-detect LAN IP. Set TURN_EXTERNAL_IP in $ENV_FILE." >&2
    exit 1
  fi
fi

# ── install coturn if missing ─────────────────────────────────────────────────
if ! command -v turnserver >/dev/null 2>&1; then
  echo "[turn] coturn not found – installing via apt..."
  sudo apt-get update -qq
  sudo apt-get install -y coturn
  echo "[turn] coturn installed."
fi

# ── write a minimal turnserver.conf to a temp location ───────────────────────
CONF_FILE="/tmp/nas-bridge-coturn.conf"
PID_FILE="/tmp/nas-bridge-coturn.pid"
LOG_FILE="/tmp/nas-bridge-coturn.log"
MIN_PORT=49152
MAX_PORT=49200

cat > "$CONF_FILE" <<EOF
listening-port=${TURN_PORT}
external-ip=${TURN_EXTERNAL_IP}
realm=${TURN_REALM}
lt-cred-mech
user=${TURN_USERNAME}:${TURN_PASSWORD}
fingerprint
no-multicast-peers
min-port=${MIN_PORT}
max-port=${MAX_PORT}
log-file=${LOG_FILE}
pidfile=${PID_FILE}
EOF

# ── stop any previous instance ────────────────────────────────────────────────
if [[ -f "$PID_FILE" ]]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[turn] Stopping previous coturn (pid=$OLD_PID)..."
    kill "$OLD_PID" || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

# ── start turnserver ──────────────────────────────────────────────────────────
echo "[turn] Starting coturn on ${TURN_EXTERNAL_IP}:${TURN_PORT} (relay ${MIN_PORT}-${MAX_PORT})..."
turnserver -c "$CONF_FILE" --daemon --pidfile="$PID_FILE"

# Give it a moment, then confirm
sleep 1
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[turn] coturn started (pid=$(cat "$PID_FILE"))"
  echo "[turn] Log: $LOG_FILE"
  echo "[turn] To stop: kill \$(cat $PID_FILE)"
else
  echo "[turn] ERROR: coturn failed to start. Check: $LOG_FILE" >&2
  tail -20 "$LOG_FILE" 2>/dev/null || true
  exit 1
fi

echo ""
echo "Add these to web/.env and storage-client/.env:"
echo "  TURN_URL=turn:${TURN_EXTERNAL_IP}:${TURN_PORT}"
echo "  TURN_USERNAME=${TURN_USERNAME}"
echo "  TURN_CREDENTIAL=${TURN_PASSWORD}"
