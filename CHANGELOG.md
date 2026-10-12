# Changelog

## 0.2.0 — 2026-10-12

Four new AI features, built in dependency order and verified with 46
passing smoke checks (`scripts/smoke.sh`: the original 26 plus 20 new),
every new check asserting real computed values.

- **RAG over docs** (`backend/routers/rag.py`, `/rag`, gateway `/api/rag`):
  ingests project documentation (`.md/.txt/.py/.ts/.tsx`, ~500-char
  overlapping word-boundary chunks) into a local ChromaDB collection
  `rag_documents` (same `backend/shell_cracked_db/` dir as the memory
  vault, separate collection). `POST /rag/ingest` tracks per-file sha256
  in `backend/data/rag_index.json`, skips unchanged files, replaces
  chunks for changed files, and rejects path traversal outside the
  project root (422). `POST /rag/query` returns ranked chunks with
  similarity scores plus a strictly **extractive** cited answer
  (`"answer_type": "extractive"`, sentences copied verbatim and cited as
  `[file#chunk]`; the response states no generative model was used).
  `GET /rag/health` reports indexed files and chunk counts. Embedding
  failures surface as HTTP 503, never silent degradation.
- **Funnel anomaly detection** (`backend/routers/anomaly.py`, `/anomaly`,
  gateway `/api/anomaly`): pure-stdlib statistics over real funnel event
  data. `GET /anomaly/{funnel_id}` builds per-stage daily conversion
  series (stage uniques / first-stage uniques per day, from event `at`
  timestamps) and runs rolling-window z-scores (configurable
  `window_days=7`, `z_threshold=3.0`) plus a CUSUM mean-shift check.
  Anomalies carry `{date, stage, observed, expected, z_score, severity}`
  with severity bands (`warning` below 1.5× threshold, `critical` at or
  above). Empty series yields empty anomalies — nothing fabricated.
  The smoke suite hand-verifies one z-score (8.6603) against an
  independently computed value.
- **Local agent loop** (`backend/routers/agent.py`, `/agent`, gateway
  `/api/agent`): ReAct loop over a registry of 12 existing local tools
  only (CRM, funnels, ML, memory vault, RAG query). `POST /agent/run`
  plans via the pluggable LLM interface, parses strict-JSON tool calls,
  executes locally, and returns the full step transcript
  (`thought/tool/args/observation`) plus the final answer. Capped at 20
  steps / 120 s per run; nothing outside the registry can execute. With
  no LLM backend configured the endpoint returns HTTP 503 with setup
  instructions instead of a fabricated transcript.
- **Deep research pipeline** (`backend/routers/research.py`, `/research`,
  gateway `/api/research`): collect → reason → project → analyze.
  `POST /research/run` fetches public URLs (SSRF guard blocks
  private/loopback IPs; timeout + size caps) and project-root files,
  extracts structured perspectives (default Input/Modeling/Output/
  Objective/Method) via the LLM interface — or a **labeled heuristic**
  key-sentence extractor when no LLM is configured, honestly marked
  `"extractor": "heuristic"` in the response — embeds projections into
  ChromaDB collection `research_projections`, clusters with a real
  seeded N-dimensional k-means (same Lloyd's/k-means++ approach as
  `/ml/kmeans`), and returns a survey with categories, per-cluster term
  momentum (labeled as a distinctiveness proxy, not a time trend), and a
  knowledge graph (nodes = clusters, edges = centroid cosine similarity
  > 0.7). `GET /research/trends` (real per-bucket document counts),
  `GET /research/graph`, and `POST /research/retrieve` round it out.
- **Shared LLM interface** (`backend/llm.py`, stdlib only): `complete()`
  tries an OpenAI-compatible endpoint (`OPENAI_BASE_URL` +
  `OPENAI_API_KEY`, model via `OPENAI_MODEL`) then Ollama
  (`OLLAMA_HOST`, default `http://127.0.0.1:11434`, model via
  `OLLAMA_MODEL`); raises a clear error (surfaced as HTTP 503) when
  neither is reachable. Keys from environment only, never files.
- **Gateway**: proxy list extended with `/api/rag`, `/api/anomaly`,
  `/api/agent`, `/api/research`; version 0.2.0.
- **Frontend**: four new tabs (RAG, Anomalies, Agent, Research) with
  typed clients under `frontend/src/clients/`; the Research view renders
  the knowledge graph on a ReactFlow canvas reusing the Workflow Studio
  component library.
- **Docs**: `docs/ARCHITECTURE.md` updated (diagram, endpoint table, new
  Grounded Facts entries per feature, LLM setup documented).

## 0.1.0 — 2026-10-04

Single-machine full-stack scaffold. Verified with 26 passing smoke checks
(`scripts/smoke.sh`), all endpoints returning real computed values.

- **Backend** (FastAPI, `127.0.0.1:8000`): CRM contacts and deals CRUD
  with a validated 5-stage pipeline view; funnels with event recording
  and unique-visitor conversion stats; real pure-Python ML endpoints
  (Lloyd's k-means, OLS linear regression); classical *simulations* of
  quantum-inspired algorithms (simulated annealing, closed-form Grover
  analysis) that disclose their simulated nature in every response.
  JSON-file persistence under `backend/data/` with demo seed data.
- **Gateway** (Express + TypeScript, `127.0.0.1:3001`): aggregate health
  at `GET /api/health` with graceful backend-down degradation;
  reverse proxy of `/api/crm|funnels|ml|quantum/*` to the backend
  (stripping the `/api` prefix); static serving of the built frontend
  with SPA fallback.
- **Frontend** (Vite React TS): builds to `frontend/dist/`, served by
  the gateway. Prebuilt `dist/` ships in the release package so the
  stack runs without an `npm run build` step.
- **Shell Cracked memory vault** (local, single-machine):
  `POST /memory/store` and `GET /memory/recall` on the backend (public
  via gateway as `/api/memory/*`), backed by ChromaDB
  `PersistentClient` in `backend/shell_cracked_db/` (collection
  `agent_observations`) with the default classical embedding model.
  Embedding-model download failures surface as a clear HTTP 503, never
  a silent fallback. A Redis cache (60 s TTL, optional — clean fallback
  when no server is reachable) fronts `recall`;
  `GET /memory/health` reports vault + Redis status. Covered by a
  store→recall round-trip in `scripts/smoke.sh`; documented under
  Grounded Facts in `docs/ARCHITECTURE.md`.
- **Workflow Studio view**: ReactFlow canvas tab (Trigger/Agent/Tool/
  Memory/Logic palette, inspector, validation, localStorage save/load,
  terminal with real local events, header pill with live backend counts).
  Local designer only — no remote execution, no swarm framing, no fake
  telemetry. Terminal ingests the typed local event contract
  (`frontend/src/lib/events.ts`: `AGENT_LOG` / `AGENT_SIGNAL` /
  `ANALYTICS_METRIC`) via zustand + RxJS `bufferTime(400)` batching;
  `WAR_ROOM_COMMAND` and remote dispatch are explicitly excluded.
- **Scripts** (`scripts/`): `start.sh` (ordered startup with 30 s curl
  health waits, conditional frontend build / dependency installs,
  pidfiles, logs, idempotent re-runs), `stop.sh` (SIGTERM→SIGKILL with
  pidfile cleanup and orphan reaping), `smoke.sh` (asserts real computed
  response values across every endpoint; no `jq` required).
- **Docs**: `docs/ARCHITECTURE.md` with ASCII overview, per-service
  endpoint table, and separated Grounded Facts / Extrapolated Insights /
  Novel Proposals sections; root `README.md` with quick start and an
  explicit "What this is NOT" scope boundary.
