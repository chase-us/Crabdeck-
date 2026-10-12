"""Deep research pipeline — collect, reason, project, analyze.

Four stages, all local except the explicit "collect" step (fetching public
URLs is the point of research; private-range IPs are blocked to avoid SSRF):

a. Collect: fetch URLs (text extraction, timeout + size caps) and read local
   files (confined to the project root).
b. Reason: extract structured perspectives per document via the pluggable
   LLM interface (backend/llm.py). When no LLM is configured, a labeled
   heuristic key-sentence extractor is used instead and the response says
   ``"extractor": "heuristic"`` HONESTLY — never presented as LLM output.
c. Project: embed extracted perspectives into the ``research_projections``
   ChromaDB collection with metadata {topic, source, perspective}.
d. Analyze: cluster embeddings with a real seeded k-means (same Lloyd's /
   k-means++ approach as routers/ml.py, generalized to N dimensions),
   compute per-cluster term momentum (a distinctiveness proxy, labeled as
   such — not a time trend), and build a knowledge graph whose edges are
   centroid cosine similarities above 0.7.

Single-machine. Every number returned is computed from real local data.
"""

import hashlib
import html.parser
import ipaddress
import logging
import math
import os
import random
import re
import socket
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

import chromadb
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

import llm
from llm import LLMUnavailable

router = APIRouter(prefix="/research", tags=["research"])
logger = logging.getLogger("crabdeck.research")

DB_DIR = Path(__file__).resolve().parent.parent / "shell_cracked_db"
COLLECTION_NAME = "research_projections"
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

DEFAULT_PERSPECTIVES = ["Input", "Modeling", "Output", "Objective", "Method"]
GRAPH_EDGE_THRESHOLD = 0.7

FETCH_TIMEOUT_S = 15
FETCH_MAX_BYTES = 512 * 1024
MAX_SOURCES = 20
MAX_DOC_CHARS = 200_000

_STOPWORDS = frozenset(
    "a an the and or of to in on for with is are was were be been being "
    "it its this that these those as at by from we you they he she him her "
    "them his our ours your yours their theirs not no nor but if then than "
    "so such can will just into over under about between through during "
    "each other more most some any all only own same also do does did done "
    "has have had having may might must shall should would could there here "
    "when where which who whom whose what how why".split()
)

_client = None
_collection = None


def get_collection():
    """Return the research_projections collection (lazy ChromaDB init)."""
    global _client, _collection
    if _collection is None:
        DB_DIR.mkdir(parents=True, exist_ok=True)
        _client = chromadb.PersistentClient(path=str(DB_DIR))
        _collection = _client.get_or_create_collection(name=COLLECTION_NAME)
    return _collection


def _embedding_error(action: str, exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=503,
        detail=(
            f"Research pipeline {action} failed: {exc}. "
            "The local embedding model may not have downloaded correctly "
            "(first run needs network access to fetch it once). "
            "No silent fallback was used."
        ),
    )


# ---------------------------------------------------------------------------
# Collect
# ---------------------------------------------------------------------------


class _TextExtractor(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts: List[str] = []
        self._skip = False

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript"):
            self._skip = True

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript"):
            self._skip = False

    def handle_data(self, data):
        if not self._skip:
            text = data.strip()
            if text:
                self.parts.append(text)

    def text(self) -> str:
        return re.sub(r"\s+", " ", " ".join(self.parts)).strip()


def _assert_public_url(url: str) -> urllib.parse.ParseResult:
    """Parse a URL and reject anything resolving to a non-public IP (SSRF guard)."""
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Unparseable URL {url!r}: {exc}")
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(
            status_code=422, detail=f"Only http(s) URLs are allowed: {url!r}"
        )
    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise HTTPException(status_code=422, detail=f"Could not resolve {parsed.hostname}: {exc}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            raise HTTPException(
                status_code=422,
                detail=f"URL {url!r} resolves to non-public IP {ip}; blocked (SSRF guard).",
            )
    return parsed


def _fetch_url(url: str) -> str:
    _assert_public_url(url)
    req = urllib.request.Request(url, headers={"User-Agent": "CrabdeckResearch/0.2.0"})
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp:
            ctype = resp.headers.get("Content-Type", "")
            raw = resp.read(FETCH_MAX_BYTES + 1)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Failed to fetch {url!r}: {exc}")
    if len(raw) > FETCH_MAX_BYTES:
        raw = raw[:FETCH_MAX_BYTES]
    text = raw.decode("utf-8", "replace")
    if "html" in ctype.lower() or "<html" in text[:2000].lower():
        extractor = _TextExtractor()
        extractor.feed(text)
        text = extractor.text()
    text = re.sub(r"\s+", " ", text).strip()
    return text[:MAX_DOC_CHARS]


def _read_local_file(ref: str) -> str:
    candidate = (PROJECT_ROOT / ref).resolve()
    try:
        candidate.relative_to(PROJECT_ROOT)
    except ValueError:
        raise HTTPException(
            status_code=422, detail=f"File {ref!r} is outside the project root; blocked."
        )
    if not candidate.is_file():
        raise HTTPException(status_code=422, detail=f"File not found: {ref!r}")
    if candidate.stat().st_size > FETCH_MAX_BYTES:
        raise HTTPException(status_code=422, detail=f"File too large: {ref!r}")
    try:
        text = candidate.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not read {ref!r}: {exc}")
    return re.sub(r"\s+", " ", text).strip()[:MAX_DOC_CHARS]


# ---------------------------------------------------------------------------
# Reason
# ---------------------------------------------------------------------------


def _split_sentences(text: str) -> List[str]:
    parts = re.split(r"(?<=[.!?])\s+", text)
    return [p.strip() for p in parts if len(p.strip()) > 20]


def _top_terms(texts: List[str], n: int = 10) -> List[str]:
    counts: Dict[str, int] = {}
    for text in texts:
        for word in re.findall(r"[a-zA-Z]{3,}", text.lower()):
            if word not in _STOPWORDS:
                counts[word] = counts.get(word, 0) + 1
    return [w for w, _ in sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:n]]


def _heuristic_extract(text: str) -> Dict[str, str]:
    """Labeled heuristic extractor: key-sentence extraction, honestly labeled."""
    sentences = _split_sentences(text)
    terms = _top_terms([text], n=25)
    term_set = set(terms)
    scored = []
    for s in sentences:
        words = set(re.findall(r"[a-zA-Z]{3,}", s.lower()))
        overlap = len(words & term_set)
        scored.append((overlap, len(s), s))
    scored.sort(key=lambda t: (t[0], -t[1]), reverse=True)
    top = [s for _, _, s in scored[:5]]
    return {"Key sentences": " ".join(top) if top else text[:2000]}


_LLM_PROMPT = (
    "Extract the following perspectives from the document below. "
    "Return STRICT JSON only — an object whose keys are exactly: {keys}. "
    "Each value is 1-3 sentences summarizing that perspective as expressed in "
    "the document; use an empty string when the document says nothing about a "
    "perspective. No markdown fences, no commentary.\n\nDOCUMENT:\n{doc}"
)


def _llm_extract(text: str, perspectives: List[str]) -> Dict[str, str]:
    prompt = _LLM_PROMPT.format(keys=", ".join(perspectives), doc=text[:12000])
    result = llm.complete(
        prompt,
        system_prompt="You extract structured perspectives from documents. You return strict JSON only.",
        timeout_s=90,
    )
    raw = result["text"].strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        parsed = __import__("json").loads(raw)
    except Exception as exc:
        raise RuntimeError(f"LLM did not return parseable JSON: {exc}")
    if not isinstance(parsed, dict):
        raise RuntimeError("LLM did not return a JSON object")
    return {p: str(parsed.get(p, "")) for p in perspectives}


# ---------------------------------------------------------------------------
# Analyze: real seeded k-means over embedding vectors (N-dimensional)
# ---------------------------------------------------------------------------


def _dist2(a: List[float], b: List[float]) -> float:
    return sum((ai - bi) ** 2 for ai, bi in zip(a, b))


def _kmeans_general(points: List[List[float]], k: int, seed: int = 42,
                    max_iter: int = 100):
    """Lloyd's k-means with k-means++ init — same approach as routers/ml.py."""
    n = len(points)
    dim = len(points[0])
    rng = random.Random(seed)
    centroids = [list(rng.choice(points))]
    while len(centroids) < k:
        d2 = [min(_dist2(p, c) for c in centroids) for p in points]
        total = sum(d2)
        if total == 0.0:
            centroids.append(list(rng.choice(points)))
            continue
        r = rng.random() * total
        cumulative = 0.0
        chosen = points[-1]
        for p, d in zip(points, d2):
            cumulative += d
            if cumulative >= r:
                chosen = p
                break
        centroids.append(list(chosen))
    assignments = [0] * n
    for _ in range(max_iter):
        changed = False
        for i, p in enumerate(points):
            best = min(range(k), key=lambda c: _dist2(p, centroids[c]))
            if best != assignments[i]:
                assignments[i] = best
                changed = True
        new_centroids = []
        for c in range(k):
            members = [points[i] for i in range(n) if assignments[i] == c]
            if members:
                new_centroids.append(
                    [sum(m[d] for m in members) / len(members) for d in range(dim)]
                )
            else:
                new_centroids.append(list(rng.choice(points)))
        centroids = new_centroids
        if not changed:
            break
    return assignments, centroids


def _cosine(a: List[float], b: List[float]) -> float:
    denom = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(x * x for x in b))
    if denom == 0:
        return 0.0
    return sum(x * y for x, y in zip(a, b)) / denom


def _choose_k(n: int) -> int:
    if n < 2:
        return 1
    return min(5, max(2, n // 3))


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class SourceIn(BaseModel):
    type: str = Field(description='"url" or "file"')
    ref: str = Field(min_length=1, description="URL or project-relative file path")


class RunIn(BaseModel):
    topic: str = Field(min_length=1)
    sources: List[SourceIn] = Field(min_length=1, max_length=MAX_SOURCES)
    perspectives: Optional[List[str]] = Field(
        default=None, description="Custom perspectives; defaults to Input/Modeling/Output/Objective/Method"
    )


class RetrieveIn(BaseModel):
    query: str = Field(min_length=1)
    n_results: int = Field(default=5, ge=1, le=20)
    topic: Optional[str] = Field(default=None)


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _coerce_meta(meta: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for k, v in meta.items():
        if v is None:
            continue
        out[str(k)] = v if isinstance(v, (str, int, float, bool)) else str(v)
    return out


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/run")
def run_research(payload: RunIn):
    perspectives = payload.perspectives or DEFAULT_PERSPECTIVES
    if len(payload.sources) > MAX_SOURCES:
        raise HTTPException(status_code=422, detail=f"At most {MAX_SOURCES} sources per run")

    # a. Collect
    documents = []
    for src in payload.sources:
        if src.type == "url":
            text = _fetch_url(src.ref)
        elif src.type == "file":
            text = _read_local_file(src.ref)
        else:
            raise HTTPException(status_code=422, detail=f'Unknown source type {src.type!r}; use "url" or "file"')
        if not text.strip():
            raise HTTPException(status_code=422, detail=f"Source {src.ref!r} yielded no text")
        documents.append({"ref": src.ref, "type": src.type, "text": text})

    # b. Reason
    extractor = "llm"
    model = backend_name = None
    extracted: List[Dict[str, Any]] = []
    try:
        for doc in documents:
            parsed = _llm_extract(doc["text"], perspectives)
            extracted.append({"ref": doc["ref"], "perspectives": parsed})
        # probe which backend answered (cheap: reuse last result info is not
        # available, so report generically)
        model = os.environ.get("OPENAI_MODEL", os.environ.get("OLLAMA_MODEL", "ollama-default"))
        backend_name = "openai_compatible" if os.environ.get("OPENAI_API_KEY") else "ollama"
    except LLMUnavailable:
        extractor = "heuristic"
        for doc in documents:
            extracted.append({"ref": doc["ref"], "perspectives": _heuristic_extract(doc["text"])})
    except Exception as exc:  # LLM misbehaved (bad JSON etc.) — fail loudly
        raise HTTPException(status_code=502, detail=f"Perspective extraction failed: {exc}")

    # c. Project
    collection = get_collection()
    ids, docs, metas = [], [], []
    ingested_at = _now()
    for item in extracted:
        for pname, ptext in item["perspectives"].items():
            if not ptext.strip():
                continue
            ids.append(hashlib.sha256(f"{payload.topic}|{item['ref']}|{pname}|{ingested_at}".encode()).hexdigest()[:16]
                       + "-" + str(len(ids)))
            docs.append(ptext)
            metas.append(_coerce_meta({
                "topic": payload.topic,
                "source": item["ref"],
                "perspective": pname,
                "ingested_at": ingested_at,
                "extractor": extractor,
            }))
    try:
        collection.add(ids=ids, documents=docs, metadatas=metas)
    except Exception as exc:
        raise _embedding_error("projection", exc)

    # d. Analyze (clusters the just-projected documents for this topic+run)
    survey = _analyze_topic(payload.topic, doc_ids=ids)

    doc_summary = [
        {"source": item["ref"], "chars": len(documents[i]["text"]),
         "perspectives": list(item["perspectives"].keys())}
        for i, item in enumerate(extracted)
    ]
    note = (
        "Perspectives extracted by a language model."
        if extractor == "llm"
        else "HEURISTIC MODE: no language model is configured — perspectives are "
             "key-sentence extracts, not LLM reasoning. Configure Ollama or an "
             "OpenAI-compatible endpoint (see docs/ARCHITECTURE.md) for full extraction."
    )
    return {
        "topic": payload.topic,
        "extractor": extractor,
        "model": model,
        "backend": backend_name,
        "documents": doc_summary,
        "survey": {**survey, "note": note},
    }


def _analyze_topic(topic: str, doc_ids: Optional[List[str]] = None) -> Dict[str, Any]:
    """Cluster a topic's projections and build the survey + knowledge graph."""
    collection = get_collection()
    where = {"topic": topic}
    try:
        stored = collection.get(where=where, include=["embeddings", "documents", "metadatas"])
    except Exception as exc:
        raise _embedding_error("analysis", exc)
    ids: List[str] = stored.get("ids") or []
    # NOTE: ChromaDB returns embeddings as a numpy array — never use `or`
    # on it (ambiguous truth value). Check None explicitly, then tolist().
    _emb = stored.get("embeddings")
    embeddings: List[List[float]] = (
        _emb.tolist() if _emb is not None and hasattr(_emb, "tolist") else (_emb or [])
    )
    documents: List[str] = stored.get("documents") or []
    metadatas: List[Dict[str, Any]] = stored.get("metadatas") or []
    if doc_ids is not None:
        keep = set(doc_ids)
        idx = [i for i, rid in enumerate(ids) if rid in keep]
        ids = [ids[i] for i in idx]
        embeddings = [embeddings[i] for i in idx]
        documents = [documents[i] for i in idx]
        metadatas = [metadatas[i] for i in idx]

    n = len(ids)
    if n == 0:
        return {"topic": topic, "categories": [],
                "graph": {"nodes": [], "edges": []}, "extractor": None}

    k = _choose_k(n)
    if k == 1:
        assignments, centroids = [0] * n, [[sum(e[d] for e in embeddings) / n for d in range(len(embeddings[0]))]]
    else:
        assignments, centroids = _kmeans_general(embeddings, k)

    # persist cluster ids for the trends endpoint
    try:
        collection.update(
            ids=ids,
            metadatas=[_coerce_meta({**(metadatas[i] or {}), "cluster_id": int(assignments[i])})
                       for i in range(n)],
        )
    except Exception as exc:
        raise _embedding_error("cluster persist", exc)

    global_terms = _top_terms(documents, n=50)
    categories = []
    for c in range(k):
        members = [i for i in range(n) if assignments[i] == c]
        cdocs = [documents[i] for i in members]
        top = _top_terms(cdocs, n=5)
        # term momentum: distinctiveness proxy = sum of (cluster TF / (1 + global TF))
        gcounts: Dict[str, int] = {}
        for t in documents:
            for w in set(re.findall(r"[a-zA-Z]{3,}", t.lower())):
                gcounts[w] = gcounts.get(w, 0) + 1
        ccounts: Dict[str, int] = {}
        for t in cdocs:
            for w in re.findall(r"[a-zA-Z]{3,}", t.lower()):
                if w not in _STOPWORDS:
                    ccounts[w] = ccounts.get(w, 0) + 1
        momentum = round(sum(ccounts.get(t, 0) / (1 + gcounts.get(t, 0)) for t in top), 4)
        # extractive summary: top sentences by overlap with cluster top terms
        term_set = set(top)
        sents = []
        for t in cdocs:
            sents.extend(_split_sentences(t))
        scored = []
        for s in sents:
            words = set(re.findall(r"[a-zA-Z]{3,}", s.lower()))
            scored.append((len(words & term_set), -len(s), s))
        scored.sort(reverse=True)
        summary = " ".join(s for _, _, s in scored[:2])
        sources = sorted({(metadatas[i] or {}).get("source", "?") for i in members})
        categories.append({
            "name": f"Cluster {c}: {', '.join(top[:3])}" if top else f"Cluster {c}",
            "summary": summary,
            "sources": sources,
            "doc_count": len(members),
            "top_terms": top,
            "term_momentum": momentum,
            "momentum_note": "Term momentum is a within-corpus distinctiveness proxy, not a time trend.",
        })

    nodes = [{"id": c,
              "label": categories[c]["name"],
              "size": categories[c]["doc_count"]} for c in range(k)]
    edges = []
    for a in range(k):
        for b in range(a + 1, k):
            sim = round(_cosine(centroids[a], centroids[b]), 4)
            if sim > GRAPH_EDGE_THRESHOLD:
                edges.append({"from": a, "to": b, "similarity": sim})

    extractor = (metadatas[0] or {}).get("extractor")
    return {"topic": topic, "categories": categories,
            "graph": {"nodes": nodes, "edges": edges},
            "extractor": extractor}


@router.get("/trends")
def research_trends(topic: str = Query(min_length=1)):
    """Per-cluster document counts over ingest time buckets (real counts)."""
    collection = get_collection()
    try:
        stored = collection.get(where={"topic": topic}, include=["metadatas"])
    except Exception as exc:
        raise _embedding_error("trends", exc)
    metadatas: List[Dict[str, Any]] = stored.get("metadatas") or []
    if not metadatas:
        raise HTTPException(status_code=404, detail=f"No projections for topic {topic!r}")
    buckets: Dict[str, Dict[str, int]] = {}
    bucket_by = "day"
    dates = {(m or {}).get("ingested_at", "")[:10] for m in metadatas}
    if len(dates) == 1:
        bucket_by = "hour"
    for m in metadatas:
        m = m or {}
        ts = str(m.get("ingested_at", ""))
        bucket = ts[:13] if bucket_by == "hour" else ts[:10]
        cid = str(m.get("cluster_id", "unclustered"))
        buckets.setdefault(bucket, {})
        buckets[bucket][cid] = buckets[bucket].get(cid, 0) + 1
    return {
        "topic": topic,
        "bucket_by": bucket_by,
        "buckets": [
            {"bucket": b, "clusters": buckets[b]} for b in sorted(buckets)
        ],
    }


@router.get("/graph")
def research_graph(topic: str = Query(min_length=1)):
    """Knowledge-graph nodes/edges for a topic (recomputed deterministically)."""
    collection = get_collection()
    try:
        stored = collection.get(where={"topic": topic}, include=["embeddings", "documents", "metadatas"])
    except Exception as exc:
        raise _embedding_error("graph", exc)
    if not (stored.get("ids") or []):
        return {"topic": topic, "nodes": [], "edges": []}
    survey = _analyze_topic(topic)
    return {"topic": topic, **survey["graph"]}


@router.post("/retrieve")
def research_retrieve(payload: RetrieveIn):
    """Semantic search over research projections, most similar first."""
    collection = get_collection()
    where = {"topic": payload.topic} if payload.topic else None
    try:
        raw = collection.query(
            query_texts=[payload.query], n_results=payload.n_results, where=where
        )
    except Exception as exc:
        raise _embedding_error("retrieve", exc)
    ids: List[str] = (raw.get("ids") or [[]])[0]
    documents: List[str] = (raw.get("documents") or [[]])[0]
    metadatas: List[Dict[str, Any]] = (raw.get("metadatas") or [[]])[0]
    distances: List[float] = (raw.get("distances") or [[]])[0]
    results = []
    for i, rid in enumerate(ids):
        meta = metadatas[i] if i < len(metadatas) else {}
        dist = distances[i] if i < len(distances) else 0.0
        results.append({
            "id": rid,
            "source": meta.get("source"),
            "perspective": meta.get("perspective"),
            "topic": meta.get("topic"),
            "text": documents[i] if i < len(documents) else "",
            "score": round(1 / (1 + dist), 4),
        })
    return {"query": payload.query, "results": results}
