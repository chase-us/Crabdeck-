# Crabdeck Omni-Layer v0.2.0 — Architecture

Single-machine full-stack scaffold: a FastAPI backend, an Express API
gateway, and a Vite React frontend, all bound to `127.0.0.1`.

```
                    ┌────────────────────────────────────────────┐
                    │  Browser → http://127.0.0.1:3001           │
                    └────────────────────┬───────────────────────┘
                                         │
                    ┌────────────────────▼───────────────────────┐
                    │  GATEWAY  (Express + TypeScript)           │
                    │  gateway/src/index.ts → gateway/dist/index.js│
                    │  127.0.0.1:3001                           │
                    │                                           │
                    │  GET  /api/health        aggregate health  │
                    │  /api/crm/*     ─┐                         │
                    │  /api/funnels/* ─┤                         │
                    │  /api/ml/*      ─┤  reverse proxy,         │
                    │  /api/quantum/* ─┤  /api prefix stripped   │
                    │  /api/memory/*  ─┤                         │
                    │  /api/rag/*     ─┤                         │
                    │  /api/anomaly/* ─┤                         │
                    │  /api/agent/*   ─┤                         │
                    │  /api/research/*┘                         │
                    │  /* (GET) → static SPA from                 │
                    │      ../frontend/dist (if built)           │
                    └────────────────────┬───────────────────────┘
                                         │ http://127.0.0.1:8000
                    ┌────────────────────▼───────────────────────┐
                    │  BACKEND  (FastAPI / uvicorn)              │
                    │  backend/main.py + backend/routers/*.py    │
                    │  127.0.0.1:8000                           │
                    │                                           │
                    │  /health              service health       │
                    │  /crm/contacts         CRUD                │
                    │  /crm/deals            CRUD                │
                    │  /crm/pipeline         stage counts/values │
                    │  /funnels              CRUD + /events +    │
                    │                        /{id}/stats        │
                    │  /ml/kmeans            Lloyd's k-means     │
                    │  /ml/regression        OLS linear fit      │
                    │  /quantum/info         simulation disclosure│
                    │  /quantum/anneal       simulated annealing │
                    │  /quantum/grover       Grover math (closed │
                    │                        form, classical)    │
                    │  /rag/ingest           doc chunk+embed     │
                    │  /rag/query            extractive cited QA │
                    │  /anomaly/{id}         funnel z-score/CUSUM│
                    │  /agent/run            ReAct tool-use loop │
                    │  /agent/tools          tool registry       │
                    │  /research/run         collect→analyze     │
                    │  /research/trends|graph|retrieve          │
                    │                                           │
                    │  storage: backend/data/*.json (local files)│
                    │  vectors: backend/shell_cracked_db/        │
                    │           (agent_observations,             │
                    │            rag_documents,                  │
                    │            research_projections)           │
                    └────────────────────────────────────────────┘
```

Process supervision is done by shell scripts, not a process manager:
`scripts/start.sh` writes PIDs to `.pids/*.pid` and logs to `logs/*.log`;
`scripts/stop.sh` reads those PIDs back.

---

## Grounded Facts

Only statements verified against the actual build (v0.1.0 source read on
2026-10-04; v0.2.0 additions verified against the running build on
2026-10-12, 46/46 smoke checks passing):

- **Bind addresses.** The backend starts with
  `python3 -m uvicorn main:app --host 127.0.0.1 --port 8000`.
  The gateway calls `app.listen(3001, "127.0.0.1")`. Nothing binds
  `0.0.0.0`; there is no network discovery, remote control, or scanning
  anywhere in the code.
- **Health endpoints.** `GET http://127.0.0.1:8000/health` returns
  `{"status":"ok","service":"crabdeck-omnilayer-backend","version":"0.2.0"}`.
  The gateway's `/api/health` reports `"version":"0.2.0"` for both gateway
  and backend (asserted by `scripts/smoke.sh`).
  `GET http://127.0.0.1:3001/api/health` returns
  `{"status":"ok","gateway":{"status":"ok",...},"backend":{...}}`, where the
  `backend` field is the backend's own `/health` body (or
  `{"status":"unreachable",...}` if the backend is down — the gateway
  degrades gracefully and still returns HTTP 200).
- **Proxy mapping.** The gateway proxies exactly
  `/api/crm`, `/api/funnels`, `/api/ml`, `/api/quantum`, `/api/memory`,
  `/api/rag`, `/api/anomaly`, `/api/agent`, `/api/research` to
  `http://127.0.0.1:8000`, rewriting `/api/crm/...` → `/crm/...`
  (the `/api` prefix is stripped). Proxying happens before body parsing so
  request bodies stream through untouched.
- **CRM.** `backend/routers/crm.py` implements contacts CRUD
  (`POST /crm/contacts` → 201 with `{"id", "name", ...}`;
  `PUT` for updates; `DELETE` returns `{"deleted": true, "id"}`;
  missing records → 404) and deals CRUD with the same shape. Deal stages
  are validated against exactly
  `["lead", "qualified", "proposal", "won", "lost"]` (anything else → 422).
  `GET /crm/pipeline` returns per-stage `{"count", "total_value"}` plus a
  grand total.
- **Funnels.** `backend/routers/funnels.py` implements funnel CRUD,
  `POST /funnels/{id}/events` with a required `{"visitor_id", "stage"}`
  body (stage must belong to the funnel, else 422), and
  `GET /funnels/{id}/stats`, which returns per-stage counts of **unique**
  visitors plus `conversion_from_previous` and `conversion_from_first`
  percentages (`null` for the first stage's previous-conversion).
- **ML.** `backend/routers/ml.py` is pure-Python, no numpy:
  `/ml/kmeans` runs Lloyd's algorithm with seeded (rng seed 42) k-means++
  init and returns `{"assignments", "centroids", "iterations", "k"}`;
  `/ml/regression` computes ordinary least squares and returns
  `{"slope", "intercept", "r_squared", "n"}`.
- **Quantum = classical simulations.** `backend/routers/quantum.py` states
  in its module docstring and in every response that no quantum hardware
  is involved. `/quantum/anneal` runs classical simulated annealing
  (seeded rng 42, geometric cooling, Gaussian proposals) on the
  `rastrigin` or `sphere` objective over `[-5.12, 5.12]^dims` and returns
  `{"best_solution", "best_value", "simulated": true, ...}`.
  `/quantum/grover` evaluates the closed-form Grover formulas classically
  and returns `{"search_space": 2**n, "success_probability", "simulated":
  true, ...}`. `/quantum/info` discloses the simulation nature in prose.
- **Shell Cracked memory vault.** `backend/routers/shell_cracked.py`
  implements a local persistent semantic memory for agent observations:
  `POST /memory/store` (`{"agent_id", "observation", "metadata"}` → 201
  with `{"status": "stored", "id" (uuid), "agent"}`) and
  `GET /memory/recall?query=...&n_results=3` (semantic search, most
  similar first, returns `{"query", "results": [{"id", "observation",
  "metadata", "distance"}]}`). Storage is ChromaDB's `PersistentClient`
  in `backend/shell_cracked_db/` (local disk, collection
  `agent_observations`) with ChromaDB's default classical ONNX embedding
  model — downloaded once on first use, then cached locally. There is no
  node-to-node networking, no remote agents, and no swarm coordination;
  nothing executes quantum circuits. If the embedding model cannot be
  downloaded, the endpoints return a clear HTTP 503 explaining why —
  there is no silent fallback.
- **Recall cache (Redis, optional).** `GET /memory/recall` checks a Redis
  cache before ChromaDB: the cache key is `recall:<md5(query:n_results)>:<n>`
  with a 60 s TTL (`setex`). Cache hits return `"source": "redis_cache"`;
  misses query the vault, populate the cache, and return
  `"source": "chromadb_vault"`. Redis is optional: if no server answers at
  `127.0.0.1:6379`, the backend starts cleanly, logs a warning, and serves
  recall straight from ChromaDB; `GET /memory/health` reports
  `"redis": "available"` or `"unavailable"` plus the collection size.
  `/memory/store` is ChromaDB-only and never touches the cache.
- **Persistence.** `backend/storage.py` keeps contacts, deals, and funnels
  in `backend/data/*.json` files, guarded by a reentrant lock. On first
  run it seeds demo contacts, deals, and one funnel ("Website signup").
  These data files are runtime state and are git-ignored.
- **Frontend.** Vite React TS app; `npm install && npm run build` emits
  `frontend/dist/`. The gateway serves `frontend/dist` statically (with an
  SPA fallback for non-`/api` GETs) only when the directory exists; the
  API works regardless.
- **Scripts.** `scripts/start.sh` starts backend → waits for
  `http://127.0.0.1:8000/health` (curl loop, 30 s) → builds the frontend
  only if `frontend/dist` is missing → `npm install` in gateway only if
  `node_modules` is missing → builds gateway `dist` only if missing →
  starts gateway → waits for `http://127.0.0.1:3001/api/health` (30 s).
  PIDs go to `.pids/*.pid`, logs to `logs/*.log`.
  `scripts/smoke.sh` asserts real computed values (not just HTTP 200) for
  every endpoint above. `scripts/stop.sh` kills the recorded PIDs and
  cleans up orphaned gateway node processes.
- **Workflow Studio view.** `frontend/src/WorkflowStudio.tsx` (styles in
  `frontend/src/workflow.css`) adds a "Workflow Studio" tab: a ReactFlow
  canvas with a node palette (Trigger, Agent, Tool, Memory, Logic),
  draggable nodes, click-to-connect edges (`addEdge`), MiniMap, Controls,
  and Background. A node inspector edits labels and per-type config
  (agent model/temperature, logic threshold, trigger source, tool
  runtime) as local workflow metadata. A terminal drawer shows only real
  local events (node added/removed, edge connected, validation results,
  save/load). Validate checks for a trigger, isolated nodes, and missing
  edges and reports into the terminal. Save/Load persist to the browser's
  `localStorage` (`crabdeck.workflow.v1`); Clear resets the canvas. The
  header pill shows **real** counts fetched from the backend via the
  gateway (contacts, deals, funnels, stored memory observations) — or
  "backend unreachable" if the fetch fails. It is a **local visual
  designer**: there is no execute/halt dispatch, no swarm, no WebSocket
  command channel, no remote nodes, and no simulated telemetry — the
  "Agent" config designs flows only.
- **Local event contract.** `frontend/src/lib/events.ts` defines the only
  three event types the UI may emit, as a typed union over a timestamped
  base (`{type, ts, source}`): `AGENT_LOG` (local workflow log lines with
  `tag`/`text`/`level`), `AGENT_SIGNAL` (local lifecycle signals with
  `agentId` and `PENDING`/`SUCCESS`/`ERROR` status — e.g. validator and
  persistence operations), and `ANALYTICS_METRIC` (real local numbers such
  as `workflow.nodes` / `workflow.edges` counts). The Workflow Studio
  terminal drawer ingests these through a zustand store fed by an RxJS
  `Subject` with `bufferTime(400)` so high-frequency local events don't
  thrash React renders. Explicitly out of scope and not implemented in
  any form: `WAR_ROOM_COMMAND` (`SPAWN_NODE`/`KILL_NODE`/`FORCE_MOLT`/
  `TRIGGER_CHAOS`), any `dispatchCommand`/WebSocket path pushing commands
  to remote nodes or a Redis command stream, swarm-mesh topology
  visualizers, and D3 swarm views.
- **Versions pinned at build time.** Backend: `fastapi==0.118.0`,
  `uvicorn==0.35.0`, `chromadb==1.5.9`, `redis==8.1.0`. Gateway: express `^4.19.2`,
  `http-proxy-middleware` `^3.0.3`, node `>=18`. Frontend:
  `reactflow@11.11.4`, `zustand@5.0.15`, `rxjs@7.8.2`,
  `lucide-react@0.454.0` (for the Workflow Studio view).
- **RAG over docs (v0.2.0).** `backend/routers/rag.py` (`/rag`):
  `POST /rag/ingest` chunks `.md/.txt/.py/.ts/.tsx` files into ~500-char
  chunks with ~50-char word-boundary overlap, embeds them with ChromaDB's
  default local ONNX model into collection `rag_documents`, and stores
  per-file sha256 in `backend/data/rag_index.json` (record id = absolute
  path). Unchanged files are skipped; changed files have old chunk ids
  deleted before re-adding. Paths are resolved against the project root
  and anything outside it is rejected with 422; files over 1 MB and
  undecodable files are skipped; 200 files per call max. Defaults when
  `paths` is omitted: `docs/`, `README.md`, `CHANGELOG.md`.
  `POST /rag/query` does semantic search and builds an **extractive**
  answer: top sentences by query-term overlap, copied verbatim, each
  cited as `[file#chunk_index]`; the response carries
  `"answer_type": "extractive"` and the note "Extractive answer assembled
  from retrieved document chunks; no generative language model was used."
  Chunk scores are `1/(1+distance)` in (0, 1]. `GET /rag/health`
  returns indexed-file and chunk counts and never 500s on an empty index.
  Embedding failures → HTTP 503, never silent.
- **Funnel anomaly detection (v0.2.0).** `backend/routers/anomaly.py`
  (`/anomaly`), pure stdlib (`statistics`). `GET /anomaly/{funnel_id}`
  (query params `window_days` default 7, `z_threshold` default 3.0)
  builds per-stage daily conversion cells from event `at` timestamps:
  `uniques(stage, date) / uniques(first_stage, date)`, skipping dates
  with a zero denominator. Each stage's sorted series is scanned with a
  rolling window of strictly-previous values (≥2 required, sample stdev
  via `statistics.stdev`, skipped when stdev is 0): z-score anomalies at
  `|z| >= z_threshold` with severity `warning` below 1.5× threshold and
  `critical` at/above, plus a CUSUM mean-shift check
  (target = window mean, k = 0.5σ, h = 5σ, severity `critical`);
  same-date+stage duplicates keep the z-score entry. Empty series →
  empty anomalies. Verified: a seeded 8-day funnel produces exactly one
  anomaly (`2026-09-27`, stage `b`, z = 8.6603, critical), matching an
  independently hand-computed value asserted in `scripts/smoke.sh`.
- **Local agent loop (v0.2.0).** `backend/routers/agent.py` (`/agent`):
  `GET /agent/tools` lists the 12 registered tools (name, description,
  JSON schema). `POST /agent/run {"goal", "max_steps"}` runs a ReAct loop:
  the system prompt embeds the tool catalog and demands exactly one JSON
  object per turn (`{"thought","tool","args"}` or
  `{"thought","final_answer"}`); tool calls execute as local Python
  function calls against the existing routers (CRM, funnels, ML, memory
  vault, RAG); observations are appended to a rolling transcript (last 12
  steps kept in the prompt). Hard caps: 20 steps, 120 s per run. Every
  step is logged server-side. Unknown tools and parse failures become
  observations, not crashes. When no LLM backend is configured the
  endpoint returns HTTP 503 whose detail contains the Ollama /
  `OPENAI_API_KEY` setup instructions — it never fabricates a transcript.
- **Deep research pipeline (v0.2.0).** `backend/routers/research.py`
  (`/research`), ChromaDB collection `research_projections`:
  `POST /research/run {"topic", "sources": [{"type":"url"|"file","ref"}],
  "perspectives?"}` runs (a) collect — URL fetch with 15 s timeout,
  512 KB cap, HTML text extraction, and an SSRF guard that resolves the
  host and rejects private/loopback/link-local/multicast/reserved IPs
  with 422; local files confined to the project root; (b) reason —
  perspective extraction (default Input/Modeling/Output/Objective/Method)
  via `llm.complete`, falling back to a labeled heuristic key-sentence
  extractor when no LLM is configured, with `"extractor": "heuristic"`
  and an explicit HEURISTIC note in the response; (c) project — embed
  perspectives with metadata `{topic, source, perspective, ingested_at,
  extractor}`; (d) analyze — seeded N-dimensional k-means (Lloyd's +
  k-means++ init, seed 42, same approach as `/ml/kmeans`; k =
  min(5, max(2, n//3))), per-cluster term momentum computed as a
  within-corpus distinctiveness proxy (labeled as such in the response,
  not a time trend), and a knowledge graph with edges for centroid
  cosine similarity > 0.7. `GET /research/trends?topic=` returns real
  per-bucket document counts by cluster; `GET /research/graph?topic=`
  returns nodes/edges; `POST /research/retrieve` does semantic search
  over projections with similarity scores.
- **Pluggable LLM interface (v0.2.0).** `backend/llm.py` (stdlib `urllib`
  only, no new dependencies): `complete(prompt, system_prompt)` returns
  `{"text","model","backend"}`. It tries an OpenAI-compatible
  `/chat/completions` endpoint when `OPENAI_BASE_URL` **and**
  `OPENAI_API_KEY` are set (model from `OPENAI_MODEL`, default
  `gpt-4o-mini`), then Ollama at `OLLAMA_HOST` (default
  `http://127.0.0.1:11434`, `/api/generate` with `stream: false`, model
  from `OLLAMA_MODEL`, default `llama3.1`). When neither answers it
  raises `LLMUnavailable`; routers surface that as HTTP 503 with setup
  instructions. `llm.status()` reports availability without raising.
  Setup: run Ollama locally (`ollama pull llama3.1`) **or** export
  `OPENAI_BASE_URL` + `OPENAI_API_KEY` (+ optional `OPENAI_MODEL`) in the
  backend's environment. Keys come from environment variables only —
  nothing is read from files and nothing is committed to the repo.

## Extrapolated Insights

Reasonable inferences from the design — labeled as such, not verified
guarantees:

- **The JSON-file store is a deliberate v0.1.0 tradeoff.** A single
  machine, a single uvicorn process, and a lock around file writes make
  JSON persistence simple and inspectable; it is a reasonable fit for a
  local single-user scaffold. Inference: it would not be a good fit for
  concurrent multi-writer load or datasets that don't fit comfortably in
  memory — if that ever matters, the `Store` class is the seam to swap
  for SQLite or Postgres.
- **Seeded algorithms favor reproducible demos over variety.** K-means and
  annealing both use `random.Random(42)`, so the same inputs always give
  the same outputs. Inference: great for smoke tests and demos, but a
  caller wanting fresh stochastic samples would need a seed parameter.
- **The gateway is a thin edge, not a service mesh.** It aggregates health
  and reverse-proxies; all domain logic lives in the backend. Inference:
  adding a new backend domain is a one-line change (another prefix in the
  proxy list) plus a new FastAPI router.
- **Health aggregation makes startup order forgiving.** Because
  `/api/health` reports the backend as `unreachable` instead of failing,
  the gateway can start before the backend without crashing. Inference:
  monitoring can key off the `backend.status` field to page only when it
  matters.
- **Idempotent-ish start supports stop/start cycles.** PID liveness checks
  plus stale-pid cleanup mean `stop.sh` → `start.sh` is safe to repeat,
  and re-running `start.sh` while up is a no-op that re-verifies health.

## Novel Proposals

Future ideas — clearly proposals, not promises, and not part of v0.1.0:

- **Proposal:** replace JSON files with SQLite (still a single local file,
  still zero network) once the CRM/funnel datasets grow or concurrent
  writes appear.
- **Proposal:** add an optional `seed` field to `/ml/kmeans` and
  `/quantum/anneal` request bodies so callers can choose between
  reproducible and fresh stochastic runs.
- **Proposal:** a `GET /api/meta/routes` introspection endpoint on the
  gateway that lists the proxied prefixes and backend routes, useful for
  the frontend's API client generation.
- **Proposal:** structured JSON logs (one JSON object per line) in
  `logs/*.log` to make local tailing/filtering easier without adding any
  log-shipping infrastructure.
- **Proposal:** a `--foreground` mode for `start.sh` that runs both
  services in the foreground for container-style supervision, keeping the
  current nohup+pidfile mode as the default.

---

## Service / endpoint table

| Service | Base URL | Endpoint | Notes |
|---|---|---|---|
| backend | `http://127.0.0.1:8000` | `GET /health` | `{"status":"ok","service":...,"version":"0.2.0"}` |
| backend | `http://127.0.0.1:8000` | `GET/POST /crm/contacts`, `GET/PUT/DELETE /crm/contacts/{id}` | Contact CRUD; 404 when missing |
| backend | `http://127.0.0.1:8000` | `GET/POST /crm/deals`, `GET/PUT/DELETE /crm/deals/{id}` | Deal CRUD; stage validated |
| backend | `http://127.0.0.1:8000` | `GET /crm/pipeline` | Per-stage counts + total value |
| backend | `http://127.0.0.1:8000` | `GET/POST /funnels`, `GET/PUT/DELETE /funnels/{id}` | Funnel CRUD |
| backend | `http://127.0.0.1:8000` | `POST /funnels/{id}/events` | Body: `{"visitor_id","stage"}` |
| backend | `http://127.0.0.1:8000` | `GET /funnels/{id}/stats` | Unique-visitor counts + conversions |
| backend | `http://127.0.0.1:8000` | `POST /ml/kmeans` | Pure-Python Lloyd's k-means |
| backend | `http://127.0.0.1:8000` | `POST /ml/regression` | OLS linear regression |
| backend | `http://127.0.0.1:8000` | `GET /quantum/info` | Simulation disclosure |
| backend | `http://127.0.0.1:8000` | `POST /quantum/anneal` | Classical simulated annealing; `simulated: true` |
| backend | `http://127.0.0.1:8000` | `POST /quantum/grover` | Classical Grover math; `simulated: true` |
| backend | `http://127.0.0.1:8000` | `POST /rag/ingest` | Chunk+embed docs; sha256-tracked, traversal-guarded |
| backend | `http://127.0.0.1:8000` | `POST /rag/query` | Extractive cited answers; `answer_type: extractive` |
| backend | `http://127.0.0.1:8000` | `GET /rag/health` | Indexed files + chunk counts |
| backend | `http://127.0.0.1:8000` | `GET /anomaly/{funnel_id}` | Daily conversion z-score + CUSUM anomalies |
| backend | `http://127.0.0.1:8000` | `GET /agent/tools` | 12 local tools: name, description, schema |
| backend | `http://127.0.0.1:8000` | `POST /agent/run` | ReAct loop; 503 with setup help when no LLM |
| backend | `http://127.0.0.1:8000` | `POST /research/run` | Collect→reason→project→analyze survey |
| backend | `http://127.0.0.1:8000` | `GET /research/trends?topic=` | Per-bucket document counts by cluster |
| backend | `http://127.0.0.1:8000` | `GET /research/graph?topic=` | Knowledge-graph nodes/edges |
| backend | `http://127.0.0.1:8000` | `POST /research/retrieve` | Semantic search over projections |
| gateway | `http://127.0.0.1:3001` | `GET /api/health` | Gateway + backend health aggregate |
| gateway | `http://127.0.0.1:3001` | `/api/crm/*`, `/api/funnels/*`, `/api/ml/*`, `/api/quantum/*`, `/api/memory/*` | Proxied to backend (`/api` stripped) |
| gateway | `http://127.0.0.1:3001` | `/api/rag/*`, `/api/anomaly/*`, `/api/agent/*`, `/api/research/*` | Proxied to backend (`/api` stripped) |
| gateway | `http://127.0.0.1:3001` | `GET /*` | Static SPA from `frontend/dist` (if built) |
