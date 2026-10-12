# Crabdeck Omni-Layer v0.1.0

Crabdeck Omni-Layer is a single-machine full-stack scaffold: a FastAPI backend (CRM with contacts/deals/pipeline, conversion funnels, real pure-Python ML endpoints for k-means and linear regression, classical *simulations* of quantum-inspired algorithms, and a local ChromaDB-backed semantic memory vault for agent observations), an Express+TypeScript API gateway that reverse-proxies `/api/*` to the backend and serves the built frontend, and a Vite React TypeScript frontend. Everything binds to `127.0.0.1` only; data lives in local JSON files under `backend/data/` and the local vector store under `backend/shell_cracked_db/`. It is a working local development stack, not a distributed system.

## Quick start

Prerequisites: `python3` (3.10+), `node` (>=18), `npm`, `curl`.

```bash
cd /home/hatch/workspace/crabdeck-omnilayer

# 1. start everything (backend -> frontend build -> gateway, with health waits)
./scripts/start.sh

# 2. verify every endpoint computes real values
./scripts/smoke.sh

# 3. when done
./scripts/stop.sh
```

URLs while running:

- Gateway / frontend: `http://127.0.0.1:3001`
- Aggregate health: `http://127.0.0.1:3001/api/health`
- API (via gateway): `http://127.0.0.1:3001/api/crm`, `/api/funnels`, `/api/ml`, `/api/quantum`, `/api/memory`
- Backend direct: `http://127.0.0.1:8000` (health: `http://127.0.0.1:8000/health`)

Notes:

- `start.sh` is idempotent-ish: re-running it while services are up just
  re-verifies health. PIDs live in `.pids/`, logs in `logs/`.
- The frontend is built only if `frontend/dist/` is missing; gateway
  dependencies install only if `node_modules/` is missing.
- The "quantum" endpoints are classical simulations — see
  `docs/ARCHITECTURE.md` and `GET /api/quantum/info`.

## What this is NOT

Scope boundary for this project — these are explicitly out of scope:

- **No remote nodes.** Every service binds `127.0.0.1` only. Nothing
  listens on an external interface.
- **No mesh discovery.** There is no node discovery, service registry, or
  peer-to-peer anything.
- **No mass restarts.** Process control is local shell scripts
  (`start.sh`/`stop.sh`) with pidfiles — no fleet orchestration.
- **No offensive agents.** Nothing here scans, probes, exploits, or
  attacks any system, local or remote.
- **No real quantum hardware.** The `/quantum/*` endpoints run ordinary
  classical algorithms (simulated annealing, closed-form Grover analysis)
  on this machine and say so in every response (`"simulated": true`).

## Layout

```
crabdeck-omnilayer/
├── backend/      # FastAPI service (sibling agent)
├── gateway/      # Express+TS gateway (sibling agent)
├── frontend/     # Vite React TS app (sibling agent)
├── scripts/      # start.sh, stop.sh, smoke.sh  <-- this agent
├── docs/         # ARCHITECTURE.md               <-- this agent
├── README.md CHANGELOG.md VERSION .gitignore     <-- this agent
├── .pids/        # runtime pid files (git-ignored)
└── logs/         # runtime logs (git-ignored)
```
