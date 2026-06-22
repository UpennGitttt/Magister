#!/usr/bin/env bash
#
# Restart Magister with an explicit environment profile.
#
# Usage:
#   bash scripts/restart-profile.sh prod
#   bash scripts/restart-profile.sh dev
#
# The profile file defaults to `.env.<profile>`. Set
# MAGISTER_PROFILE_ENV_FILE=/path/to/file to test or launch from a
# different env file. Existing shell variables win over profile-file
# values so one-off overrides still work.

set -euo pipefail

cd "$(dirname "$0")/.."

profile="${1:-}"
if [[ -z "$profile" ]]; then
  echo "usage: bash scripts/restart-profile.sh <profile>" >&2
  exit 64
fi
if [[ ! "$profile" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "invalid profile: $profile" >&2
  exit 64
fi

env_file="${MAGISTER_PROFILE_ENV_FILE:-.env.$profile}"

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

strip_matching_quotes() {
  local value="$1"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

load_env_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0

  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(trim "$line")"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == export[[:space:]]* ]] && line="$(trim "${line#export}")"
    [[ "$line" == *=* ]] || continue
    key="$(trim "${line%%=*}")"
    value="$(trim "${line#*=}")"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="$(strip_matching_quotes "$value")"
    if [[ -z "${!key+x}" ]]; then
      export "$key=$value"
    fi
  done < "$file"
}

load_env_file "$env_file"

# cwd vs profile install-dir consistency guard.
#
# Problem this catches (running a profile from the wrong checkout):
#   $ cd <prod-checkout>
#   $ bash scripts/restart-profile.sh dev
# Without this guard, restart.sh's `cd $(dirname $0)/..` locks cwd to
# the prod checkout, then loads dev's .env.dev (which expects
# MAGISTER_INSTALL_DIR=<dev-checkout>). The result:
#   - PID files land in prod's .magister/ (overwriting prod's)
#   - stop_pid_file in restart.sh KILLS the prod processes (since
#     api.pid/web.pid still reference them)
#   - The new "dev" services come up listening on dev's ports but
#     with cwd=prod, reading prod's DB
# Net effect: prod outage + a confused half-prod/half-dev service.
# (This has bitten us in practice — a few minutes of prod downtime.)
# The guard refuses to proceed when the active checkout doesn't match
# what the loaded profile expects.
#
# Guard is opt-in via MAGISTER_INSTALL_DIR being set in the profile
# env file (all our profiles set it; missing → no guard, safe
# fallback for legacy callers).
checkout_dir="$(pwd -P)"
expected_install_dir="${MAGISTER_INSTALL_DIR:-}"
if [[ -n "$expected_install_dir" ]]; then
  # Resolve symlinks on the expected dir too (e.g. /opt/acme on
  # macOS dev might be /private/opt/acme). Skip the check if the
  # expected dir doesn't exist yet — restart.sh's later validation
  # will surface that more clearly than this guard would.
  expected_resolved="$expected_install_dir"
  if [[ -d "$expected_install_dir" ]]; then
    expected_resolved="$(cd "$expected_install_dir" && pwd -P)"
  fi
  if [[ "$checkout_dir" != "$expected_resolved" ]]; then
    echo "ERROR: restart-profile.sh '$profile' refuses to run from this checkout." >&2
    echo "       Current cwd:                    $checkout_dir" >&2
    echo "       Profile $env_file expects:      $expected_resolved" >&2
    echo "       (from MAGISTER_INSTALL_DIR in $env_file)" >&2
    echo "" >&2
    echo "       Fix: run from the right checkout, e.g." >&2
    echo "         cd $expected_resolved && bash scripts/restart-profile.sh $profile" >&2
    echo "" >&2
    echo "       This guard exists because running the wrong profile from" >&2
    echo "       the wrong checkout overwrites the other checkout's PID" >&2
    echo "       files and can kill its running services." >&2
    exit 78  # EX_CONFIG
  fi
fi

export MAGISTER_RUNTIME_PROFILE="${MAGISTER_RUNTIME_PROFILE:-$profile}"
export MAGISTER_INSTALL_DIR="${MAGISTER_INSTALL_DIR:-$(pwd)}"

if [[ -z "${API_PORT:-}" ]]; then
  API_PORT="${PORT:-}"
fi
if [[ -z "${MAGISTER_API_TARGET:-}" && -n "${API_PORT:-}" ]]; then
  export MAGISTER_API_TARGET="http://127.0.0.1:$API_PORT"
fi

exec bash scripts/restart.sh
