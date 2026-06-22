#!/usr/bin/env bash
#
# CI / smoke: boot the API control plane on stock Node.js (via tsx) against a
# fresh temp DB and assert it serves /health. Proves the whole startup path
# (better-sqlite3 migrations, Fastify, cli-bridge spawnProcess probes, agent
# resolution, route registration) runs on Node — see
# docs/plans/2026-06-02-runtime-portability.md.
#
# Exits non-zero if the server doesn't answer /health within the timeout.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${NODE_BOOT_CHECK_PORT:-3199}"
TMP="$(mktemp -d)"
export PORT
export HOST=127.0.0.1
export MAGISTER_DB_PATH="$TMP/control-plane.sqlite"
export MAGISTER_API_LOCK_PATH="$TMP/api.lock"
export MAGISTER_DISABLE_CHANNELS=1
export MAGISTER_INSTALL_DIR="$(pwd)"

echo "[node-boot-check] starting API on Node (tsx) :$PORT (db=$MAGISTER_DB_PATH)"
node --import tsx ./apps/api/src/server.ts > "$TMP/boot.log" 2>&1 &
PID=$!

cleanup() { kill "$PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

ok=""
for i in $(seq 1 30); do
  sleep 1
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ok="$i"; break; fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "[node-boot-check] FAILED — process exited early"; tail -20 "$TMP/boot.log"; exit 1
  fi
done

if [ -z "$ok" ]; then
  echo "[node-boot-check] FAILED — /health never answered"; tail -20 "$TMP/boot.log"; exit 1
fi

body="$(curl -s "http://127.0.0.1:$PORT/health")"
echo "[node-boot-check] /health (${ok}s): $body"
case "$body" in
  *'"ok":true'*) echo "[node-boot-check] PASS"; exit 0 ;;
  *) echo "[node-boot-check] FAILED — unexpected /health body"; exit 1 ;;
esac
