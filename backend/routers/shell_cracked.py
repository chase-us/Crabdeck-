"""Shell Cracked — local persistent semantic memory vault.

Stores agent observations in a local ChromaDB collection and recalls them by
semantic similarity. A small Redis cache (60 s TTL) sits in front of recall.
This is a SINGLE-MACHINE, LOCAL-ONLY feature:

- The vector store lives in ``backend/shell_cracked_db/`` on this machine.
- Embeddings come from ChromaDB's default classical ONNX embedding model
  (downloaded once from the network on first use, then cached locally).
- Redis, when reachable at 127.0.0.1:6379, only caches recall *results*;
  it is OPTIONAL — if no server is reachable the backend starts cleanly,
  logs a warning, and serves recall straight from ChromaDB.
- There is no node-to-node networking, no remote agents, and no swarm
  coordination of any kind.
- Nothing here executes quantum circuits. If the embedding model cannot be
  downloaded (e.g. no network on first run), endpoints fail with a clear
  HTTP 503 instead of silently degrading.
"""

import hashlib
import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional


def _sanitize_no_proxy_env() -> None:
    """Drop bracketed-IPv6 literals (e.g. ``[::1]``) from no_proxy/NO_PROXY.

    This process runs an httpx version whose proxy-pattern parser raises
    ``InvalidURL: Invalid port`` on such entries, which breaks ChromaDB's
    embedding-model downloader. This service only contacts 127.0.0.1 /
    localhost directly (both stay listed), so removing the bracketed
    literals is safe.
    """
    for var in ("no_proxy", "NO_PROXY"):
        val = os.environ.get(var)
        if not val:
            continue
        kept = [part for part in val.split(",") if "[" not in part and "]" not in part]
        os.environ[var] = ",".join(kept)


_sanitize_no_proxy_env()

import chromadb
import redis
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

router = APIRouter(prefix="/memory", tags=["memory"])
logger = logging.getLogger("shell_cracked")

DB_DIR = Path(__file__).resolve().parent.parent / "shell_cracked_db"
COLLECTION_NAME = "agent_observations"

REDIS_HOST = "127.0.0.1"
REDIS_PORT = 6379
RECALL_CACHE_TTL_S = 60

_client: Optional[chromadb.PersistentClient] = None
_collection = None
_redis: Optional["redis.Redis"] = None
_redis_checked = False


def get_collection():
    """Return the agent_observations collection, creating client/collection lazily."""
    global _client, _collection
    if _collection is None:
        DB_DIR.mkdir(parents=True, exist_ok=True)
        _client = chromadb.PersistentClient(path=str(DB_DIR))
        _collection = _client.get_or_create_collection(name=COLLECTION_NAME)
    return _collection


def get_redis() -> Optional["redis.Redis"]:
    """Return a Redis client if a server is reachable, else None (checked once)."""
    global _redis, _redis_checked
    if not _redis_checked:
        _redis_checked = True
        try:
            client = redis.Redis(
                host=REDIS_HOST,
                port=REDIS_PORT,
                socket_connect_timeout=2,
                socket_timeout=2,
                decode_responses=True,
            )
            client.ping()
            _redis = client
            logger.info(
                "Shell Cracked: Redis cache available at %s:%d", REDIS_HOST, REDIS_PORT
            )
        except Exception as exc:  # noqa: BLE001 — Redis is optional by design
            _redis = None
            logger.warning(
                "Shell Cracked: Redis unavailable at %s:%d (%s); "
                "recall falls back to ChromaDB directly.",
                REDIS_HOST,
                REDIS_PORT,
                exc,
            )
    return _redis


def _cache_key(query: str, n_results: int) -> str:
    digest = hashlib.md5(f"{query}:{n_results}".encode("utf-8")).hexdigest()
    return f"recall:{digest}:{n_results}"


class StoreIn(BaseModel):
    agent_id: str = Field(min_length=1, description="ID of the agent recording the observation")
    observation: str = Field(min_length=1, description="Free-text observation to remember")
    metadata: Dict[str, Any] = Field(
        default_factory=dict,
        description="Extra metadata; values are coerced to str/int/float/bool",
    )


def _coerce_metadata(metadata: Dict[str, Any], agent_id: str) -> Dict[str, Any]:
    coerced: Dict[str, Any] = {}
    for key, value in metadata.items():
        if value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            coerced[str(key)] = value
        else:
            coerced[str(key)] = str(value)
    coerced["agent_id"] = agent_id
    return coerced


def _embedding_error(action: str, exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=503,
        detail=(
            f"Shell Cracked memory vault {action} failed: {exc}. "
            "The local embedding model may not have downloaded correctly "
            "(first run needs network access to fetch it once). "
            "No silent fallback was used."
        ),
    )


@router.get("/health")
def memory_health():
    """Vault health: collection size and whether the Redis cache is reachable."""
    collection = get_collection()
    try:
        count = collection.count()
    except Exception as exc:  # noqa: BLE001 — report, don't crash
        raise _embedding_error("health check", exc)
    return {
        "status": "ok",
        "service": "shell-cracked-vault",
        "collection": COLLECTION_NAME,
        "stored_observations": count,
        "redis": "available" if get_redis() is not None else "unavailable",
        "recall_cache_ttl_s": RECALL_CACHE_TTL_S,
    }


@router.post("/store", status_code=201)
def store_observation(payload: StoreIn):
    """Store one agent observation; returns its UUID. ChromaDB-only (no cache)."""
    collection = get_collection()
    record_id = uuid.uuid4().hex
    try:
        collection.add(
            ids=[record_id],
            documents=[payload.observation],
            metadatas=[_coerce_metadata(payload.metadata, payload.agent_id)],
        )
    except Exception as exc:  # noqa: BLE001 — surfaced as a clear 503, never silent
        raise _embedding_error("store", exc)
    return {"status": "stored", "id": record_id, "agent": payload.agent_id}


@router.get("/recall")
def recall_observations(
    query: str = Query(min_length=1, description="Natural-language recall query"),
    n_results: int = Query(3, ge=1, le=50, description="Max observations to return"),
):
    """Semantic recall, most similar first.

    Checks the Redis cache first (key ``recall:<md5(query:n_results)>:<n>``,
    60 s TTL). ``"source"`` in the response says where the answer came from:
    ``"redis_cache"`` or ``"chromadb_vault"``.
    """
    key = _cache_key(query, n_results)
    r = get_redis()
    if r is not None:
        try:
            cached = r.get(key)
        except Exception as exc:  # noqa: BLE001 — a broken cache is a miss, not a crash
            logger.warning("Shell Cracked: Redis GET failed (%s); treating as cache miss.", exc)
            cached = None
        if cached:
            return {"query": query, "results": json.loads(cached), "source": "redis_cache"}

    collection = get_collection()
    try:
        raw = collection.query(query_texts=[query], n_results=n_results)
    except Exception as exc:  # noqa: BLE001 — surfaced as a clear 503, never silent
        raise _embedding_error("recall", exc)

    ids: List[str] = (raw.get("ids") or [[]])[0]
    documents: List[str] = (raw.get("documents") or [[]])[0]
    metadatas: List[Dict[str, Any]] = (raw.get("metadatas") or [[]])[0]
    distances: List[float] = (raw.get("distances") or [[]])[0]

    results = []
    for i, rid in enumerate(ids):
        results.append(
            {
                "id": rid,
                "observation": documents[i] if i < len(documents) else "",
                "metadata": metadatas[i] if i < len(metadatas) else {},
                "distance": distances[i] if i < len(distances) else None,
            }
        )

    if r is not None:
        try:
            r.setex(key, RECALL_CACHE_TTL_S, json.dumps(results))
        except Exception as exc:  # noqa: BLE001 — cache write failure must not fail recall
            logger.warning("Shell Cracked: Redis SETEX failed (%s); recall still served.", exc)

    return {"query": query, "results": results, "source": "chromadb_vault"}
