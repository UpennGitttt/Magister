#!/bin/bash
#
# Restart Magister in **prod / long-running mode**.
#
# This is the production launch path: web bundle is built (no HMR),
# API runs plain (no `bun --watch`), services are detached via setsid
# so they survive this script exiting, PID files land under
# .magister/, and SSE proxy + auth health checks must pass before
# the script returns success.
#
# For active development use `bun run dev` (API, --watch) +
# `bun run dev:web` (web, vite HMR). See CLAUDE.md "Launching the
# stack" for the rationale on why these are intentionally separate
# (watchers recycle the leader-loop runtime on every .ts mtime
# change, which costs seconds per reload and risks a tight recycle
# loop if generated files land under apps/api/src/).
#
# Usage: bash scripts/restart.sh

set -euo pipefail

cd "$(dirname "$0")/.."

# Kill by PID file, not by pattern matching
API_PID_FILE=".magister/api.pid"
WEB_PID_FILE=".magister/web.pid"

# Resolve API port from .env (PORT=…) so the health check below
# matches whatever the API actually binds. Hardcoding 3000 here
# desync'd from the .env-driven server bind once we moved off port
# 3000 (sample-app squats it locally) and produced a false
# `API: FAILED` even when the server was healthy. Precedence:
# explicit env > .env file > legacy default.
read_dotenv_value() {
  local key="$1"
  local file=".env"
  [[ -f "$file" ]] || return 1
  awk -F= -v k="$key" '
    $1 == k {
      sub(/^[^=]*=/, "")
      sub(/^[ \t"]+/, "")
      sub(/[ \t"]+$/, "")
      print
      exit
    }
  ' "$file"
}

api_port_from_shell=0
if [[ -n "${API_PORT:-}" || -n "${PORT:-}" ]]; then
  api_port_from_shell=1
fi

if [[ -z "${API_PORT:-}" ]]; then
  if [[ -n "${PORT:-}" ]]; then
    API_PORT="$PORT"
  else
    dotenv_port="$(read_dotenv_value PORT 2>/dev/null || true)"
    API_PORT="${dotenv_port:-3700}"
  fi
fi
export API_PORT
export PORT="$API_PORT"

if [[ -z "${WEB_PORT:-}" ]]; then
  dotenv_web_port="$(read_dotenv_value WEB_PORT 2>/dev/null || true)"
  WEB_PORT="${dotenv_web_port:-3701}"
fi
export WEB_PORT

if [[ -z "${MAGISTER_API_TARGET:-}" ]]; then
  dotenv_api_target=""
  if [[ "$api_port_from_shell" != "1" ]]; then
    dotenv_api_target="$(read_dotenv_value MAGISTER_API_TARGET 2>/dev/null || true)"
  fi
  MAGISTER_API_TARGET="${dotenv_api_target:-http://127.0.0.1:$API_PORT}"
fi
export MAGISTER_API_TARGET

REPO_ROOT="$(pwd)"
export MAGISTER_INSTALL_DIR="${MAGISTER_INSTALL_DIR:-$REPO_ROOT}"
MAGISTER_RUNTIME_PROFILE="${MAGISTER_RUNTIME_PROFILE:-}"
export MAGISTER_RUNTIME_PROFILE

if [[ "${MAGISTER_RESTART_DRY_RUN:-}" == "1" ]]; then
  echo "MAGISTER_RUNTIME_PROFILE=$MAGISTER_RUNTIME_PROFILE"
  echo "MAGISTER_INSTALL_DIR=$MAGISTER_INSTALL_DIR"
  echo "API_PORT=$API_PORT"
  echo "PORT=$PORT"
  echo "WEB_PORT=$WEB_PORT"
  echo "MAGISTER_API_TARGET=$MAGISTER_API_TARGET"
  echo "MAGISTER_DISABLE_CHANNELS=${MAGISTER_DISABLE_CHANNELS:-}"
  exit 0
fi

log_suffix=""
if [[ -n "$MAGISTER_RUNTIME_PROFILE" ]]; then
  log_suffix="-$MAGISTER_RUNTIME_PROFILE"
fi
API_LOG_FILE="${MAGISTER_API_LOG_FILE:-/tmp/magister${log_suffix}-api.log}"
WEB_LOG_FILE="${MAGISTER_WEB_LOG_FILE:-/tmp/magister${log_suffix}-web.log}"

migrate_legacy_runtime_dir() {
  if [ -d ".ultimate" ] && [ ! -e ".magister" ]; then # // legacy
    mv ".ultimate" ".magister" # // legacy
    printf "moved to .magister/\n" > ".ultimate" # // legacy
    echo "[migration] .ultimate/ → .magister/ (one-time)" # // legacy
  elif [ -d ".ultimate" ] && [ -e ".magister" ]; then # // legacy
    echo "[migration] both .ultimate/ and .magister/ exist — skipping; manually consolidate." # // legacy
  fi
}

migrate_legacy_runtime_dir
mkdir -p .magister

# Poll until `kill -0 $pid` fails, up to $2 seconds. Returns 0 when
# the process is gone, 1 if it's still alive at the deadline.
wait_for_pid_death() {
  local pid="$1"
  local timeout="${2:-5}"
  local deadline=$(( $(date +%s) + timeout ))
  while [ $(date +%s) -lt "$deadline" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

# Graceful SIGTERM → wait → escalate to SIGKILL. The API's
# `app.close()` runs Feishu WS gateway shutdown + retention loops in
# series and can take 3-6 seconds; a flat `sleep 1` was too short and
# left the old PID alive when the new instance tried to grab the lock,
# producing the "Process lock already held by pid <X>" startup crash
# this helper exists to prevent.
graceful_kill() {
  local pid="$1"
  local label="$2"

  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  # Wait window MUST exceed the server's own graceful-shutdown timeout
  # (runGracefulShutdown DEFAULT_TIMEOUT_MS = 5s) so the process can
  # force-exit cleanly on its own before we escalate to SIGKILL.
  if wait_for_pid_death "$pid" 20; then
    return 0
  fi

  echo "[restart] $label PID $pid did not exit on SIGTERM (20s), escalating to SIGKILL"
  kill -KILL "$pid" 2>/dev/null || true
  if wait_for_pid_death "$pid" 2; then
    return 0
  fi

  echo "[restart] $label PID $pid still alive after SIGKILL — manual cleanup required"
  return 1
}

stop_pid_file() {
  local pid_file="$1"
  local label="$2"
  local old_pid

  if [ ! -f "$pid_file" ]; then
    return
  fi

  old_pid="$(cat "$pid_file" 2>/dev/null || true)"
  rm -f "$pid_file"

  if ! [[ "$old_pid" =~ ^[0-9]+$ ]]; then
    echo "[restart] Ignored stale $label PID file"
    return
  fi

  if kill -0 "$old_pid" 2>/dev/null; then
    if graceful_kill "$old_pid" "$label"; then
      echo "[restart] Stopped old $label (PID $old_pid)"
    fi
  else
    echo "[restart] Removed stale $label PID file (PID $old_pid)"
  fi
}

pid_for_port() {
  local port="$1"
  ss -lntp "sport = :$port" 2>/dev/null \
    | sed -nE 's/.*pid=([0-9]+).*/\1/p' \
    | head -1
}

is_magister_process() {
  local pid="$1"
  local args

  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  [[ "$args" == *"$REPO_ROOT"* ]] \
    || [[ "$args" == *"apps/api/src/server.ts"* ]] \
    || [[ "$args" == *"apps/web/serve-prod.ts"* ]]
}

stop_port_owner() {
  local port="$1"
  local label="$2"
  local pid

  pid="$(pid_for_port "$port")"
  if [ -z "$pid" ]; then
    return
  fi

  if is_magister_process "$pid"; then
    if graceful_kill "$pid" "$label port owner on :$port"; then
      echo "[restart] Stopped $label port owner on :$port (PID $pid)"
    fi
    return
  fi

  echo "[restart] Refusing to stop non-Magister process on :$port (PID $pid)"
  ps -p "$pid" -o pid=,args= 2>/dev/null || true
  exit 1
}

# Defensive cleanup of stale process locks. The API server writes
# `.magister/api-server.lock` from `acquireProcessLock` and releases it
# on SIGTERM. If a previous instance was SIGKILLed (by graceful_kill's
# escalation, or out-of-band), the lock file lingers with its now-dead
# pid. The acquireProcessLock helper handles this on EEXIST race, but
# sweeping it here makes the failure mode visible if even this falls
# over. Only removes the lock when the recorded pid is dead.
sweep_stale_lock() {
  local lock_file="$1"
  local label="$2"
  [ -f "$lock_file" ] || return 0

  local lock_pid
  lock_pid="$(awk -F'[":, ]+' '
    /"pid"/ { for (i=1; i<=NF; i++) if ($i == "pid") { print $(i+1); exit } }
    /^[0-9]+$/ { print; exit }
  ' "$lock_file" 2>/dev/null)"

  if [[ "$lock_pid" =~ ^[0-9]+$ ]] && kill -0 "$lock_pid" 2>/dev/null; then
    return 0  # live owner, leave it alone
  fi

  rm -f "$lock_file"
  if [[ -n "$lock_pid" ]]; then
    echo "[restart] Swept stale $label lock (pid=$lock_pid was dead)"
  fi
}

# Build web and migrate BEFORE stopping old services (blue-green safety).
# If either step fails, set -euo pipefail aborts here and the old
# services remain running — a "didn't update" degradation rather than
# "prod is completely down". Stop/start only happens after both succeed.
echo "[restart] Building + migrating BEFORE stopping old services (blue-green safety)"

# Build web
echo "[restart] Building web..."
bun run build:web 2>&1 | tail -1

# Run migration
echo "[restart] Running migration..."
bun run migrate 2>&1 | tail -1

# Stop old processes
stop_pid_file "$API_PID_FILE" "API"
stop_pid_file "$WEB_PID_FILE" "Web"
stop_port_owner "$API_PORT" "API"
stop_port_owner "$WEB_PORT" "Web"

# After all stops, sweep any process-lock file that's still on disk
# pointing at a dead pid — happens when graceful_kill escalates to
# SIGKILL (the server can't run its onClose hook). The next API spawn
# would otherwise hit "Process lock already held by pid <X>" and crash.
sweep_stale_lock ".magister/api-server.lock" "API"

# Start API in a separate session so it survives this script's parent process.
setsid bun ./apps/api/src/server.ts >> "$API_LOG_FILE" 2>&1 &
API_PID=$!
echo $API_PID > "$API_PID_FILE"
echo "[restart] API started (PID $API_PID)"

# Start Web in a separate session so it survives this script's parent process.
setsid bun apps/web/serve-prod.ts >> "$WEB_LOG_FILE" 2>&1 &
WEB_PID=$!
echo $WEB_PID > "$WEB_PID_FILE"
echo "[restart] Web started (PID $WEB_PID)"

# Verify
sleep 5
if [ "$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$API_PORT/system/status")" = "200" ]; then
  echo "[restart] API: OK"
else
  echo "[restart] API: FAILED — check $API_LOG_FILE"
fi

if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$WEB_PORT/" | grep -q "401"; then
  echo "[restart] Web: OK"
else
  echo "[restart] Web: FAILED — check $WEB_LOG_FILE"
fi

# SSE proxy guardrail.
#
# Historical bug (b56465c): Bun.serve's default 10s idleTimeout severed
# SSE streams mid-task, making the chat appear "one-shot" (nothing until
# everything at once) and causing POSTs to look like they succeeded while
# actually timing out. These two checks fail loudly if we regress:
#
#   1. Static guard — the proxy file must set idleTimeout: 0.
#   2. Live guard — a real SSE request through the proxy must deliver the
#      snapshot event inside a few seconds.
#
# Runs after API/Web checks above so both services are up.

if grep -qE "idleTimeout:[[:space:]]*0" apps/web/serve-prod.ts; then
  : # guardrail present
else
  echo "[restart] WARN: apps/web/serve-prod.ts is missing idleTimeout: 0 — SSE streams may be cut at 10s (see commit b56465c)"
fi

SSE_PASS=""
if [ -n "${MAGISTER_WEB_AUTH_PASS:-}" ]; then
  SSE_PASS="$MAGISTER_WEB_AUTH_PASS"
elif [ -f .env ]; then
  SSE_PASS="$(sed -nE 's/^MAGISTER_WEB_AUTH_PASS=(.*)$/\1/p' .env | head -1)"
fi

sse_task_id="$(curl -s ${SSE_PASS:+-u "admin:$SSE_PASS"} "http://127.0.0.1:$WEB_PORT/api/tasks?limit=1" 2>/dev/null \
  | bun -e 'try { const items = JSON.parse(await Bun.stdin.text()).data.items; process.stdout.write(items?.[0]?.id ?? ""); } catch {}' 2>/dev/null)"

if [ -z "$sse_task_id" ]; then
  echo "[restart] SSE proxy: SKIPPED (no tasks available to probe)"
else
  # curl | head closes the pipe early → SIGPIPE exit 23; also a clean
  # timeout via --max-time exits 28. Neither is a real failure here, so
  # disable pipefail just for the probe.
  set +o pipefail
  # Read more than just the first line — SSE responses now start with a
  # ~2KB padding comment (": ...") to flush mobile WebKit/proxy buffers
  # before the real `event: task.snapshot` line.
  sse_head="$(curl -s ${SSE_PASS:+-u "admin:$SSE_PASS"} --max-time 3 \
    "http://127.0.0.1:$WEB_PORT/api/tasks/$sse_task_id/stream" 2>/dev/null \
    | head -c 8192)"
  set -o pipefail

  if printf '%s' "$sse_head" | grep -q "^event: task.snapshot"; then
    echo "[restart] SSE proxy: OK"
  else
    echo "[restart] SSE proxy: FAILED — snapshot event did not arrive (SSE may be buffered or cut)"
  fi
fi
