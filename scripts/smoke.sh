#!/usr/bin/env bash
#
# smoke.sh — end-to-end smoke tests for Crabdeck Omni-Layer v0.2.0.
#
# Assumes the stack is already up (./scripts/start.sh).
# Uses curl -sf for HTTP and python3 for JSON assertions (no jq required).
# Prints "OK <name>" per check; exits nonzero on the FIRST failure with a
# clear message. Cleans up the records it creates.
#
# NOTE on URL paths: the gateway reverse-proxies /api/crm, /api/funnels,
# /api/ml, /api/quantum, /api/memory to the backend (stripping the /api
# prefix), so all API calls below use the /api-prefixed form.
#
set -uo pipefail

BASE="${SMOKE_BASE:-http://127.0.0.1:3001}"

fail() { echo "FAIL $1" >&2; exit 1; }

# api <method> <path> [json-body]  -> prints response body on success
api() {
  local method="$1" path="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -sf --max-time 30 -X "$method" \
      -H 'Content-Type: application/json' -d "$data" "$BASE$path"
  else
    curl -sf --max-time 30 -X "$method" "$BASE$path"
  fi
}

# assert_json <name> <python-snippet>
# $BODY holds the latest response; the snippet runs with `b` = parsed JSON.
# (Assertions use plain message strings — no f-strings — for maximum
# portability across Python versions.)
assert_json() {
  local name="$1" snippet="$2"
  if BODY="$BODY" python3 -c "
import json, os
b = json.loads(os.environ['BODY'])
$snippet
"; then
    echo "OK $name"
  else
    echo "FAIL $name" >&2
    exit 1
  fi
}

get_id() {  # get_id <response-body> -> prints b["id"]
  BODY="$1" python3 -c "import json, os; print(json.loads(os.environ['BODY'])['id'])"
}

# ---------------------------------------------------------------- health
BODY="$(api GET /api/health)" || fail "health: request failed"
assert_json "health" 'assert b["status"] == "ok", "top-level status is not ok"
assert isinstance(b.get("gateway"), dict) and b["gateway"].get("status") == "ok", "gateway status is not ok"
assert isinstance(b.get("backend"), dict) and b["backend"].get("status") == "ok", "backend status is not ok"'

# ---------------------------------------------------------------- CRM: contacts full lifecycle
BODY="$(api POST /api/crm/contacts '{"name":"Smoke Contact","email":"smoke@example.com","company":"Smoke Inc"}')" \
  || fail "crm-contact-create: request failed"
assert_json "crm-contact-create" 'assert isinstance(b.get("id"), str) and b["id"], "missing contact id"
assert b["name"] == "Smoke Contact", "created contact name mismatch"'
CID="$(get_id "$BODY")"

BODY="$(api GET "/api/crm/contacts/$CID")" || fail "crm-contact-read: request failed"
assert_json "crm-contact-read" 'assert b["name"] == "Smoke Contact", "read-back contact name mismatch"'

BODY="$(api PUT "/api/crm/contacts/$CID" '{"name":"Smoke Contact Updated"}')" \
  || fail "crm-contact-update: request failed"
assert_json "crm-contact-update" 'assert b["name"] == "Smoke Contact Updated", "updated contact name mismatch"'

BODY="$(api DELETE "/api/crm/contacts/$CID")" || fail "crm-contact-delete: request failed"
assert_json "crm-contact-delete" 'assert b.get("deleted") is True, "delete did not return deleted:true"'

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$BASE/api/crm/contacts/$CID")"
if [ "$code" = "404" ]; then
  echo "OK crm-contact-gone"
else
  fail "crm-contact-gone: expected HTTP 404 after delete, got $code"
fi

# ---------------------------------------------------------------- CRM: deals + pipeline
BODY="$(api POST /api/crm/deals '{"title":"Smoke Deal A","value":100,"stage":"lead"}')" \
  || fail "crm-deal-create-a: request failed"
assert_json "crm-deal-create-a" 'assert isinstance(b.get("id"), str) and b["id"], "missing deal id"'
DEAL_A="$(get_id "$BODY")"

BODY="$(api POST /api/crm/deals '{"title":"Smoke Deal B","value":250.5,"stage":"won"}')" \
  || fail "crm-deal-create-b: request failed"
assert_json "crm-deal-create-b" 'assert isinstance(b.get("id"), str) and b["id"], "missing deal id"'
DEAL_B="$(get_id "$BODY")"

BODY="$(api GET /api/crm/pipeline)" || fail "crm-pipeline: request failed"
assert_json "crm-pipeline" 'assert b["stages"]["lead"]["count"] >= 1, "pipeline lead count too low"
assert b["stages"]["won"]["count"] >= 1, "pipeline won count too low"
assert b["total"]["count"] >= 2, "pipeline total count too low"'

# cleanup deals
api DELETE "/api/crm/deals/$DEAL_A" >/dev/null || fail "crm-deal-cleanup-a: request failed"
api DELETE "/api/crm/deals/$DEAL_B" >/dev/null || fail "crm-deal-cleanup-b: request failed"
echo "OK crm-deal-cleanup"

# ---------------------------------------------------------------- funnels
BODY="$(api POST /api/funnels '{"name":"Smoke Funnel","stages":["a","b","c"]}')" \
  || fail "funnel-create: request failed"
assert_json "funnel-create" 'assert isinstance(b.get("id"), str) and b["id"], "missing funnel id"
assert b["stages"] == ["a", "b", "c"], "funnel stages mismatch"'
FID="$(get_id "$BODY")"

# 4 events across the 3 stages; stats count UNIQUE visitors per stage
api POST "/api/funnels/$FID/events" '{"visitor_id":"smoke-v1","stage":"a"}' >/dev/null || fail "funnel-event-1: request failed"
api POST "/api/funnels/$FID/events" '{"visitor_id":"smoke-v2","stage":"a"}' >/dev/null || fail "funnel-event-2: request failed"
api POST "/api/funnels/$FID/events" '{"visitor_id":"smoke-v3","stage":"b"}' >/dev/null || fail "funnel-event-3: request failed"
api POST "/api/funnels/$FID/events" '{"visitor_id":"smoke-v4","stage":"c"}' >/dev/null || fail "funnel-event-4: request failed"
echo "OK funnel-events"

BODY="$(api GET "/api/funnels/$FID/stats")" || fail "funnel-stats: request failed"
assert_json "funnel-stats" 'assert [s["stage"] for s in b["stages"]] == ["a", "b", "c"], "stage order mismatch"
assert [s["count"] for s in b["stages"]] == [2, 1, 1], "per-stage counts mismatch"
for s in b["stages"]:
    for key in ("conversion_from_previous", "conversion_from_first"):
        v = s[key]
        assert v is None or isinstance(v, (int, float)), "conversion percentage is not a number"'

api DELETE "/api/funnels/$FID" >/dev/null || fail "funnel-cleanup: request failed"
echo "OK funnel-cleanup"

# ---------------------------------------------------------------- ML: kmeans
BODY="$(api POST /api/ml/kmeans '{"points":[[0,0],[0,1],[10,10],[10,11]],"k":2}')" \
  || fail "ml-kmeans: request failed"
assert_json "ml-kmeans" 'assert len(b["assignments"]) == 4, "expected 4 cluster assignments"
assert len(b["centroids"]) == 2, "expected 2 centroids"
for c in b["centroids"]:
    assert isinstance(c, list) and len(c) == 2, "centroid is not an [x, y] pair"
    assert all(isinstance(x, (int, float)) for x in c), "centroid coordinates are not numbers"
a0, a1, a2, a3 = b["assignments"]
assert a0 == a1 and a2 == a3 and a0 != a2, "points did not cluster into two separated groups"'

# ---------------------------------------------------------------- ML: linear regression
BODY="$(api POST /api/ml/regression '{"x":[1,2,3,4],"y":[2,4,6,8]}')" \
  || fail "ml-regression: request failed"
assert_json "ml-regression" 'assert abs(b["slope"] - 2.0) < 1e-9, "slope is not approx 2"
assert abs(b["intercept"] - 0.0) < 1e-9, "intercept is not approx 0"
assert abs(b["r_squared"] - 1.0) < 1e-9, "r_squared is not approx 1"'

# ---------------------------------------------------------------- quantum (classical simulations)
BODY="$(api GET /api/quantum/info)" || fail "quantum-info: request failed"
assert_json "quantum-info" 'import json as _json
assert "simulation" in _json.dumps(b).lower(), "info response does not contain the word simulation"
assert b.get("simulated") is True, "top-level simulated flag is not true"'

BODY="$(api POST /api/quantum/anneal '{"objective":"sphere","dims":2,"iterations":2000}')" \
  || fail "quantum-anneal: request failed"
assert_json "quantum-anneal" 'assert isinstance(b["best_value"], (int, float)), "best_value is not a number"
assert b["best_value"] < 1.0, "best_value is not < 1.0"
sol = b["best_solution"]
assert isinstance(sol, list) and len(sol) == 2, "best_solution does not have 2 entries"
assert all(isinstance(x, (int, float)) for x in sol), "best_solution entries are not numbers"
assert b.get("simulated") is True, "simulated flag is not true"'

BODY="$(api POST /api/quantum/grover '{"n_qubits":3,"target":5}')" \
  || fail "quantum-grover: request failed"
assert_json "quantum-grover" 'assert b["search_space"] == 8, "search_space is not 8"
assert isinstance(b["success_probability"], (int, float)), "success_probability is not a number"
assert b["success_probability"] > 0.9, "success_probability is not > 0.9"
assert b.get("simulated") is True, "simulated flag is not true"'

# ---------------------------------------------------------------- frontend: Workflow Studio bundled & served
# Build-time proof the Workflow Studio route is compiled into the SPA bundle
# the gateway serves (SPA renders client-side, so we assert on the bundle).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
[ -f "$ROOT_DIR/frontend/dist/index.html" ] \
  || fail "frontend-dist: frontend/dist/index.html missing (run npm run build in frontend/)"
BUNDLE="$(ls "$ROOT_DIR"/frontend/dist/assets/*.js 2>/dev/null | head -1)"
[ -n "$BUNDLE" ] || fail "frontend-bundle: no JS bundle in frontend/dist/assets/"
grep -q "WORKFLOW STUDIO" "$BUNDLE" \
  || fail "frontend-workflow: Workflow Studio marker not found in the built bundle"
echo "OK frontend-workflow-bundled"
# Gateway serves the SPA shell with HTTP 200
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$BASE/")"
[ "$code" = "200" ] || fail "frontend-served: expected HTTP 200 for /, got $code"
echo "OK frontend-served"

# ---------------------------------------------------------------- Shell Cracked memory vault
# store-then-recall round trip: the stored observation must come back
SENTINEL="quasar-banyan-42"
BODY="$(api POST /api/memory/store "{\"agent_id\":\"smoke-agent\",\"observation\":\"The smoke-test sentinel phrase is $SENTINEL\",\"metadata\":{\"source\":\"smoke\"}}")" \
  || fail "memory-store: request failed"
assert_json "memory-store" 'assert b.get("status") == "stored", "store status is not stored"
assert isinstance(b.get("id"), str) and b["id"], "missing stored observation id"
assert b.get("agent") == "smoke-agent", "stored agent mismatch"'

BODY="$(api GET "/api/memory/recall?query=$SENTINEL&n_results=3")" \
  || fail "memory-recall: request failed"
assert_json "memory-recall" 'assert b.get("query") == "quasar-banyan-42", "recall query echo mismatch"
results = b.get("results")
assert isinstance(results, list) and len(results) >= 1, "recall returned no results"
assert any("quasar-banyan-42" in (r.get("observation") or "") for r in results), "stored observation not found in recall results"
assert b.get("source") in ("chromadb_vault", "redis_cache"), "recall source is not a known value"'

# ---------------------------------------------------------------- Shell Cracked: memory health + recall cache behavior
BODY="$(api GET /api/memory/health)" || fail "memory-health: request failed"
assert_json "memory-health" 'assert b.get("status") == "ok", "memory health status is not ok"
assert b.get("service") == "shell-cracked-vault", "memory health service mismatch"
assert isinstance(b.get("stored_observations"), int) and b["stored_observations"] >= 1, "stored_observations is not a positive int"
assert b.get("redis") in ("available", "unavailable"), "redis field is not available/unavailable"'
REDIS_STATE="$(BODY="$BODY" python3 -c "import json, os; print(json.loads(os.environ['BODY'])['redis'])")"

# recall-twice on a fresh query: first call always misses -> chromadb_vault;
# second call hits the Redis cache -> redis_cache (only when Redis is up)
FRESH_Q="quasar-banyan-99"
BODY="$(api GET "/api/memory/recall?query=$FRESH_Q&n_results=2")" \
  || fail "memory-recall-miss: request failed"
assert_json "memory-recall-miss" 'assert b.get("source") == "chromadb_vault", "first recall of a fresh query did not come from chromadb_vault"'

BODY="$(api GET "/api/memory/recall?query=$FRESH_Q&n_results=2")" \
  || fail "memory-recall-hit: request failed"
if [ "$REDIS_STATE" = "available" ]; then
  assert_json "memory-recall-cached" 'assert b.get("source") == "redis_cache", "second recall did not come from redis_cache"'
else
  assert_json "memory-recall-direct" 'assert b.get("source") == "chromadb_vault", "recall without redis did not come from chromadb_vault"
print("note: redis unavailable, cache-hit assertion skipped (recall still served from vault)")'
fi

# ---------------------------------------------------------------- v0.2.0: version pins
BODY="$(api GET /api/health)" || fail "health-v020: request failed"
assert_json "health-v020" 'assert b["backend"].get("version") == "0.2.0", "backend version is not 0.2.0"
assert b["gateway"].get("version") == "0.2.0", "gateway version is not 0.2.0"'

# ---------------------------------------------------------------- v0.2.0: RAG over docs
BODY="$(api GET /api/rag/health)" || fail "rag-health: request failed"
assert_json "rag-health" 'assert b.get("status") == "ok", "rag health status is not ok"
assert b.get("service") == "rag", "rag health service mismatch"
assert isinstance(b.get("indexed_files"), int) and b["indexed_files"] >= 0, "indexed_files is not a non-negative int"
assert isinstance(b.get("total_chunks"), int) and b["total_chunks"] >= 0, "total_chunks is not a non-negative int"'

BODY="$(api POST /api/rag/ingest '{}')" || fail "rag-ingest: request failed"
assert_json "rag-ingest" 'assert b["files_indexed"] + b["files_skipped"] >= 3, "expected at least 3 files touched (docs/, README.md, CHANGELOG.md)"
assert b["chunks_added"] >= 0, "chunks_added is negative"
for f in b["files"]:
    assert f["status"] in ("indexed", "skipped_unchanged", "skipped"), "unexpected file status"
    assert isinstance(f["chunks"], int) and f["chunks"] >= 0, "chunks count is not a non-negative int"'

# idempotency: re-ingesting unchanged docs must index nothing new
BODY="$(api POST /api/rag/ingest '{"paths":["docs"]}')" || fail "rag-reingest: request failed"
assert_json "rag-reingest" 'assert b["files_indexed"] == 0, "re-ingest of unchanged docs indexed new files"
assert b["chunks_added"] == 0, "re-ingest of unchanged docs added chunks"
assert all(f["status"] == "skipped_unchanged" for f in b["files"]), "re-ingest did not skip everything as unchanged"'

BODY="$(api POST /api/rag/query '{"query":"What is Crabdeck Omni-Layer?","n_results":5}')" \
  || fail "rag-query: request failed"
assert_json "rag-query" 'assert b.get("answer_type") == "extractive", "answer_type is not extractive"
assert "no generative language model was used" in b.get("note", ""), "extractive note missing"
assert isinstance(b.get("answer"), str) and len(b["answer"]) > 0, "extractive answer is empty"
assert isinstance(b.get("citations"), list) and len(b["citations"]) >= 1, "no citations returned"
assert any("[" in b["answer"] and "#" in b["answer"] for _ in [0]), "answer has no [file#chunk] citation"
for c in b["chunks"]:
    assert 0 < c["score"] <= 1, "chunk score out of range (0, 1]"
    assert c["file"] and isinstance(c["chunk_index"], int), "chunk missing file/chunk_index"'

# negative cases: empty query, n_results out of range, path traversal
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$BASE/api/rag/query" -H 'Content-Type: application/json' -d '{"query":""}')"
[ "$code" = "422" ] || fail "rag-query-empty: expected HTTP 422, got $code"
echo "OK rag-query-empty"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$BASE/api/rag/query" -H 'Content-Type: application/json' -d '{"query":"q","n_results":21}')"
[ "$code" = "422" ] || fail "rag-query-nrange: expected HTTP 422, got $code"
echo "OK rag-query-nrange"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$BASE/api/rag/ingest" -H 'Content-Type: application/json' -d '{"paths":["../"]}' )"
[ "$code" = "422" ] || fail "rag-ingest-traversal: expected HTTP 422, got $code"
echo "OK rag-ingest-traversal"

# ---------------------------------------------------------------- v0.2.0: funnel anomaly detection
# Seed a funnel with 8 days of events (direct JSON write; the record_event API
# stamps "now", which cannot produce multi-day series). Day-8 conversion for
# stage b spikes to 1.0 against a [0.5,0.5,0.6,0.5,0.4,0.5,0.5] baseline.
# Hand-computed: mean=0.5, sample stdev=sqrt(0.02/6)=0.057735, z=8.6603 -> critical.
python3 - "$ROOT_DIR" <<'PYEOF' || fail "anomaly-seed: python seeding failed"
import json, os, sys
root = sys.argv[1]
path = os.path.join(root, "backend", "data", "funnels.json")
with open(path) as f:
    data = json.load(f)
fid = "smoke-anomaly-v2"
data.pop(fid, None)
convs = [0.5, 0.5, 0.6, 0.5, 0.4, 0.5, 0.5, 1.0]
events = []
for day_i, conv in enumerate(convs):
    date = "2026-09-%02d" % (20 + day_i)
    for v in range(10):
        events.append({"visitor_id": "sav2-%d-%d" % (day_i, v), "stage": "a", "at": date + "T10:00:00Z"})
    for v in range(int(round(10 * conv))):
        events.append({"visitor_id": "sbv2-%d-%d" % (day_i, v), "stage": "b", "at": date + "T11:00:00Z"})
data[fid] = {"id": fid, "name": "Smoke Anomaly Funnel v2", "stages": ["a", "b"],
             "created_at": "2026-09-20T00:00:00Z", "events": events}
with open(path, "w") as f:
    json.dump(data, f, indent=2)
print("seeded", fid, "with", len(events), "events")
PYEOF
echo "OK anomaly-seed"

BODY="$(api GET "/api/anomaly/smoke-anomaly-v2?window_days=7&z_threshold=3.0")" \
  || fail "anomaly-detect: request failed"
assert_json "anomaly-detect" 'assert b["funnel_id"] == "smoke-anomaly-v2", "funnel id mismatch"
assert len(b["daily_series"]) == 16, "expected 16 daily cells (8 days x 2 stages)"
assert len(b["anomalies"]) == 1, "expected exactly 1 anomaly, got %d" % len(b["anomalies"])
a = b["anomalies"][0]
assert a["date"] == "2026-09-27", "anomaly date mismatch"
assert a["stage"] == "b", "anomaly stage mismatch"
assert abs(a["z_score"] - 8.6603) < 0.001, "z_score %.4f does not match hand-computed 8.6603" % a["z_score"]
assert abs(a["observed"] - 1.0) < 1e-9 and abs(a["expected"] - 0.5) < 1e-9, "observed/expected mismatch"
assert a["severity"] == "critical", "severity is not critical"
assert a["method"] == "zscore", "method is not zscore"'

# empty-series funnel -> empty anomalies, never fabricated
BODY="$(api POST /api/funnels '{"name":"Smoke Empty Funnel","stages":["x","y"]}')" \
  || fail "anomaly-empty-create: request failed"
EMPTY_FID="$(get_id "$BODY")"
BODY="$(api GET "/api/anomaly/$EMPTY_FID")" || fail "anomaly-empty: request failed"
assert_json "anomaly-empty" 'assert b["daily_series"] == [], "empty funnel should have empty daily_series"
assert b["anomalies"] == [], "empty funnel should have empty anomalies"'
api DELETE "/api/funnels/$EMPTY_FID" >/dev/null || fail "anomaly-empty-cleanup: request failed"
api DELETE "/api/funnels/smoke-anomaly-v2" >/dev/null || fail "anomaly-cleanup: request failed"
echo "OK anomaly-cleanup"

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$BASE/api/anomaly/no-such-funnel")"
[ "$code" = "404" ] || fail "anomaly-404: expected HTTP 404, got $code"
echo "OK anomaly-404"

# ---------------------------------------------------------------- v0.2.0: local agent loop
BODY="$(api GET /api/agent/tools)" || fail "agent-tools: request failed"
assert_json "agent-tools" 'names = [t["name"] for t in b]
assert len(names) == 12, "expected 12 registered tools, got %d" % len(names)
for required in ("crm_list_contacts", "funnels_stats", "ml_kmeans", "memory_recall", "rag_query"):
    assert required in names, "tool %s missing from registry" % required
for t in b:
    assert t["description"] and isinstance(t["schema"], dict), "tool entry malformed"'

# No LLM backend is configured in this environment, so a run must 503 with
# setup instructions (never a fabricated transcript).
code="$(curl -s --max-time 90 -o /tmp/agent_run_body.json -w '%{http_code}' -X POST "$BASE/api/agent/run" \
  -H 'Content-Type: application/json' -d '{"goal":"List my contacts","max_steps":2}')"
[ "$code" = "503" ] || fail "agent-run-no-llm: expected HTTP 503 without an LLM backend, got $code"
BODY="$(cat /tmp/agent_run_body.json)"
assert_json "agent-run-no-llm" 'assert "Ollama" in b.get("detail", ""), "503 detail does not explain Ollama setup"
assert "OPENAI_API_KEY" in b.get("detail", ""), "503 detail does not mention OPENAI_API_KEY"'
rm -f /tmp/agent_run_body.json

# ---------------------------------------------------------------- v0.2.0: deep research pipeline
RTOPIC="smoke-research-v1"
BODY="$(api POST /api/research/run "{\"topic\":\"$RTOPIC\",\"sources\":[{\"type\":\"file\",\"ref\":\"README.md\"},{\"type\":\"file\",\"ref\":\"CHANGELOG.md\"}]}")" \
  || fail "research-run: request failed"
assert_json "research-run" 'assert b["topic"] == "smoke-research-v1", "topic mismatch"
assert b["extractor"] == "heuristic", "extractor should be heuristic with no LLM configured"
assert isinstance(b["documents"], list) and len(b["documents"]) == 2, "expected 2 collected documents"
s = b["survey"]
assert isinstance(s["categories"], list) and len(s["categories"]) >= 1, "survey has no categories"
assert "HEURISTIC" in s.get("note", ""), "survey note does not honestly label heuristic mode"
assert len(s["graph"]["nodes"]) >= 1, "knowledge graph has no nodes"
for c in s["categories"]:
    assert c["doc_count"] >= 1, "category has no documents"
    assert isinstance(c["term_momentum"], (int, float)), "term_momentum is not a number"'

BODY="$(api GET "/api/research/trends?topic=$RTOPIC")" || fail "research-trends: request failed"
assert_json "research-trends" 'assert b["topic"] == "smoke-research-v1", "trends topic mismatch"
assert isinstance(b["buckets"], list) and len(b["buckets"]) >= 1, "no trend buckets"
total = sum(sum(cl.values()) for bk in b["buckets"] for cl in [bk["clusters"]])
assert total >= 2, "trend buckets do not account for the projected documents"'

BODY="$(api GET "/api/research/graph?topic=$RTOPIC")" || fail "research-graph: request failed"
assert_json "research-graph" 'assert len(b["nodes"]) >= 1, "graph has no nodes"
for e in b["edges"]:
    assert e["similarity"] > 0.7, "graph edge below the 0.7 similarity threshold"'

BODY="$(api POST /api/research/retrieve "{\"query\":\"funnel stages\",\"n_results\":3,\"topic\":\"$RTOPIC\"}")" \
  || fail "research-retrieve: request failed"
assert_json "research-retrieve" 'assert isinstance(b["results"], list) and len(b["results"]) >= 1, "retrieve returned no results"
for r in b["results"]:
    assert 0 < r["score"] <= 1, "retrieve score out of range (0, 1]"
    assert r["text"], "retrieve result has empty text"'

# SSRF guard: loopback URLs must be rejected
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST "$BASE/api/research/run" \
  -H 'Content-Type: application/json' -d '{"topic":"smoke-ssrf","sources":[{"type":"url","ref":"http://127.0.0.1:8000/health"}]}')"
[ "$code" = "422" ] || fail "research-ssrf: expected HTTP 422 for loopback URL, got $code"
echo "OK research-ssrf"

# ---------------------------------------------------------------- v0.2.0: new frontend views bundled
BUNDLE2="$(ls "$ROOT_DIR"/frontend/dist/assets/*.js 2>/dev/null | head -1)"
[ -n "$BUNDLE2" ] || fail "frontend-bundle-v2: no JS bundle in frontend/dist/assets/"
for marker in "Deep Research" "Anomalies" "Run agent" "RAG"; do
  grep -q "$marker" "$BUNDLE2" \
    || fail "frontend-view-v2: marker '$marker' not found in the built bundle"
done
echo "OK frontend-views-v2-bundled"

echo
echo "ALL SMOKE CHECKS PASSED"
