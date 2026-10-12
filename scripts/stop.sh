#!/usr/bin/env bash
#
# stop.sh — stop the Crabdeck Omni-Layer v0.2.0 stack.
#
# Reads PIDs from .pids/backend.pid and .pids/gateway.pid, sends SIGTERM
# (then SIGKILL if needed), removes the pid files, and cleans up any
# orphaned gateway node child processes. Prints what was stopped.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { echo "[stop] $*"; }

stop_one() {
  # stop_one <name> <pidfile>
  local name="$1" pidfile="$2"
  if [ ! -f "$pidfile" ]; then
    log "no pid file for $name ($pidfile) — nothing to stop."
    return 0
  fi
  local pid
  pid="$(tr -d '[:space:]' < "$pidfile")"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log "stopping $name (PID $pid)..."
    kill "$pid" 2>/dev/null || true
    # Give it up to 5s to exit on SIGTERM before escalating.
    local i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 5 ]; do
      sleep 1
      i=$((i + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      log "$name (PID $pid) ignored SIGTERM; sending SIGKILL."
      kill -9 "$pid" 2>/dev/null || true
      sleep 1
    fi
    if kill -0 "$pid" 2>/dev/null; then
      log "WARNING: could not kill $name (PID $pid); it may need manual attention."
    else
      log "stopped $name (PID $pid)."
    fi
  else
    log "$name not running (stale pid file $pidfile); removing it."
  fi
  rm -f "$pidfile"
}

stop_one "backend" ".pids/backend.pid"
stop_one "gateway" ".pids/gateway.pid"

# Fallback: the pid files should have covered everything, but if anything is
# still listening on our two ports (e.g. a server started outside these
# scripts), stop it so a fresh start.sh doesn't hit EADDRINUSE.
for port in 8000 3001; do
  leftover="$(ss -ltnp 2>/dev/null | grep "127.0.0.1:$port" | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1 || true)"
  if [ -n "$leftover" ] && kill -0 "$leftover" 2>/dev/null; then
    log "stopping leftover process on 127.0.0.1:$port (PID $leftover)..."
    kill "$leftover" 2>/dev/null || true
    sleep 1
    kill -9 "$leftover" 2>/dev/null || true
  fi
done

log "done."
