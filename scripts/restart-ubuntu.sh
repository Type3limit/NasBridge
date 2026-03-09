#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

if [[ -x "${SCRIPT_DIR}/stop-ubuntu-24.sh" ]]; then
  "${SCRIPT_DIR}/stop-ubuntu-24.sh"
elif [[ -x "${SCRIPT_DIR}/stop-services.sh" ]]; then
  "${SCRIPT_DIR}/stop-services.sh" --with-turn
fi

sudo systemctl start coturn

if [[ -x "${SCRIPT_DIR}/deploy-and-start.sh" ]]; then
  "${SCRIPT_DIR}/deploy-and-start.sh" --skip-deploy
else
  if [[ -f "${REPO_ROOT}/package.json" ]]; then
    npm install
    npm run build
    node server/src/index.js &
  fi

  if [[ -f "${REPO_ROOT}/web/package.json" ]]; then
    cd "${REPO_ROOT}/web"
    npm install
    npm run dev -- --host
  fi
fi
