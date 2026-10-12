#!/usr/bin/env bash
#
# start.sh — start the Crabdeck Omni-Layer v0.2.0 stack (single machine).
#
#   backend  : FastAPI  on http://127.0.0.1:8000  (health: /health)
#   gateway  : Express  on http://127.0.0.1:3001  (health: /api/health)
#   frontend : Vite build, served statically by the gateway when present
#
# Idempotent-ish: if a service's PID file points at a live process, the
# service is left alone ("already running") and we just re-verify health.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKEND_DIR="$ROOT/backend"
GATEWAY_DIR="$ROOT/gateway"
FRONTEND_DIR="$ROOT/frontend"

BACKEND_URL="http://127.0.0.1:8000"
GATEWAY_URL="http://127.0.0.1:3001"
BACKEND_HEALTH="$BACKEND_URL/health"
GATEWAY_HEALTH="$GATEWAY_URL/api/health"
HEALTH_TIMEOUT_S=30

mkdir -p .pids logs

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
log()  { echo "[start] $*"; }
err()  { echo "[start] ERROR: $*" >&2; }

read_pid() {
  # Prints the PID stored in a pid file, or nothing if absent/blank.
  local file="$1"
  [ -f "$file" ] && tr -d '[:space:]' < "$file" || true
}

pid_alive() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

wait_for() {
  # wait_for <url> <name> [timeout_s]
  local url="$1" name="$2" timeout="${3:-$HEALTH_TIMEOUT_S}"
  local i=0
  while [ "$i" -lt "$timeout" ]; do
    if curl -sf --max-time 2 "$url" >/dev/null 2>&1; then
      log "$name is healthy ($url)"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  err "$name did not become healthy within ${timeout}s ($url)"
  return 1
}

# ---------------------------------------------------------------------------
# 1. backend (FastAPI / uvicorn)
# ---------------------------------------------------------------------------
start_backend() {
  if [ ! -d "$BACKEND_DIR" ]; then
    err "backend directory not found at $BACKEND_DIR; sibling agent has not delivered it yet."
    return 1
  fi
  [ -f "$BACKEND_DIR/requirements.txt" ] || { err "backend/requirements.txt missing."; return 1; }
  [ -f "$BACKEND_DIR/main.py" ] || { err "backend/main.py missing."; return 1; }
  command -v python3 >/dev/null 2>&1 || { err "python3 not found on PATH."; return 1; }

  local pid
  pid="$(read_pid .pids/backend.pid)"
  if pid_alive "$pid"; then
    log "backend already running (PID $pid); leaving it alone."
    wait_for "$BACKEND_HEALTH" "backend"
    return 0
  fi
  rm -f .pids/backend.pid   # stale pid file, if any

  if ! python3 -c "import fastapi, uvicorn" 2>/dev/null; then
    log "installing backend requirements (fastapi/uvicorn not importable)..."
    python3 -m pip install -r "$BACKEND_DIR/requirements.txt"
  fi

  log "starting backend: python3 -m uvicorn main:app --host 127.0.0.1 --port 8000"
  (
    cd "$BACKEND_DIR"
    # shellcheck disable=SC2086
    nohup python3 -m uvicorn main:app --host 127.0.0.1 --port 8000 \
      >> "$ROOT/logs/backend.log" 2>&1 &
    echo $! > "$ROOT/.pids/backend.pid"
  )
  sleep 1
  pid="$(read_pid .pids/backend.pid)"
  if ! pid_alive "$pid"; then
    err "backend process died immediately; see logs/backend.log"
    rm -f .pids/backend.pid
    return 1
  fi
  log "backend started (PID $pid)"
  wait_for "$BACKEND_HEALTH" "backend"
}

# ---------------------------------------------------------------------------
# 2. frontend build (only when dist is missing)
# ---------------------------------------------------------------------------
build_frontend() {
  if [ ! -d "$FRONTEND_DIR" ]; then
    err "frontend directory not found at $FRONTEND_DIR; sibling agent has not delivered it yet."
    return 1
  fi
  if [ -d "$FRONTEND_DIR/dist" ] && [ -f "$FRONTEND_DIR/dist/index.html" ]; then
    log "frontend/dist already built; skipping build."
    return 0
  fi
  command -v npm >/dev/null 2>&1 || { err "npm not found on PATH; cannot build frontend."; return 1; }
  [ -f "$FRONTEND_DIR/package.json" ] || { err "frontend/package.json missing."; return 1; }
  log "building frontend (npm install && npm run build)..."
  ( cd "$FRONTEND_DIR" && npm install && npm run build )
  [ -f "$FRONTEND_DIR/dist/index.html" ] \
    || { err "frontend build finished but frontend/dist/index.html is missing."; return 1; }
  log "frontend built into frontend/dist."
}

# ---------------------------------------------------------------------------
# 3. gateway (Express / node)
# ---------------------------------------------------------------------------
start_gateway() {
  if [ ! -d "$GATEWAY_DIR" ]; then
    err "gateway directory not found at $GATEWAY_DIR; sibling agent has not delivered it yet."
    return 1
  fi
  [ -f "$GATEWAY_DIR/package.json" ] || { err "gateway/package.json missing."; return 1; }
  command -v npm >/dev/null 2>&1 || { err "npm not found on PATH; cannot start gateway."; return 1; }
  command -v node >/dev/null 2>&1 || { err "node not found on PATH; cannot start gateway."; return 1; }

  local pid
  pid="$(read_pid .pids/gateway.pid)"
  if pid_alive "$pid"; then
    log "gateway already running (PID $pid); leaving it alone."
    wait_for "$GATEWAY_HEALTH" "gateway"
    return 0
  fi
  rm -f .pids/gateway.pid   # stale pid file, if any

  if [ ! -d "$GATEWAY_DIR/node_modules" ]; then
    log "installing gateway dependencies (node_modules missing)..."
    ( cd "$GATEWAY_DIR" && npm install )
  fi
  if [ ! -f "$GATEWAY_DIR/dist/index.js" ]; then
    if grep -q '"build"' "$GATEWAY_DIR/package.json"; then
      log "building gateway (npm run build: tsc)..."
      ( cd "$GATEWAY_DIR" && npm run build )
    else
      err "gateway/dist/index.js missing and package.json has no build script."
      return 1
    fi
    [ -f "$GATEWAY_DIR/dist/index.js" ] \
      || { err "gateway build finished but gateway/dist/index.js is missing."; return 1; }
  fi

  log "starting gateway: node dist/index.js (direct; PID file tracks the real server)"
  (
    cd "$GATEWAY_DIR"
    # NOTE: launched directly (not via `npm start`) so .pids/gateway.pid
    # holds the actual node server PID and stop.sh can kill it reliably.
    nohup node dist/index.js >> "$ROOT/logs/gateway.log" 2>&1 &
    echo $! > "$ROOT/.pids/gateway.pid"
  )
  sleep 1
  pid="$(read_pid .pids/gateway.pid)"
  if ! pid_alive "$pid"; then
    err "gateway process died immediately; see logs/gateway.log"
    rm -f .pids/gateway.pid
    return 1
  fi
  log "gateway started (PID $pid)"
  wait_for "$GATEWAY_HEALTH" "gateway"
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
start_backend
build_frontend
start_gateway

echo
echo "=============================================="
echo " Crabdeck Omni-Layer v0.2.0 is UP"
echo "=============================================="
echo "  backend : $BACKEND_URL            (health: $BACKEND_HEALTH)"
echo "  gateway : $GATEWAY_URL            (health: $GATEWAY_HEALTH)"
echo "  frontend: served by gateway at $GATEWAY_URL (when frontend/dist exists)"
echo "  API via gateway:"
echo "    $GATEWAY_URL/api/crm      (contacts, deals, pipeline)"
echo "    $GATEWAY_URL/api/funnels  (funnels, events, stats)"
echo "    $GATEWAY_URL/api/ml       (kmeans, regression)"
echo "    $GATEWAY_URL/api/quantum  (info, anneal, grover) — classical simulations"
echo "    $GATEWAY_URL/api/memory   (store, recall, health) — local semantic vault + optional Redis cache"
echo "  logs    : logs/backend.log, logs/gateway.log"
echo "  pids    : .pids/backend.pid, .pids/gateway.pid"
echo "  smoke   : ./scripts/smoke.sh"
echo "  stop    : ./scripts/stop.sh"
echo "=============================================="
