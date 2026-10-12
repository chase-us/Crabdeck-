"""RAG over docs — local extractive retrieval for the Crabdeck Omni-Layer.

Ingests project documentation (Markdown, plain text, Python/TypeScript
sources) into a local ChromaDB collection and answers questions with
EXTRACTIVE answers only: sentences are copied verbatim from retrieved chunks
and cited as [file#chunk_index]. There is no generative language model.

This is a SINGLE-MACHINE, LOCAL-ONLY feature:

- The vector store lives in ``backend/shell_cracked_db/`` on this machine
  (collection ``rag_documents``, shared DB dir with the memory vault but a
  separate collection).
- Embeddings come from ChromaDB's default classical ONNX embedding model
  (downloaded once from the network on first use, then cached locally).
- Ingest only reads files under the project root; path traversal outside
  the root is rejected with HTTP 422.
- If the embedding model cannot be downloaded (e.g. no network on first
  run), endpoints fail with a clear HTTP 503 instead of silently degrading.
"""

import hashlib
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


def _sanitize_no_proxy_env() -> None:
    """Drop bracketed-IPv6 literals (e.g. ``[::1]``) from no_proxy/NO_PROXY.

    Same helper as routers/shell_cracked.py: this process runs an httpx
    version whose proxy-pattern parser raises ``InvalidURL: Invalid port``
    on such entries, which breaks ChromaDB's embedding-model downloader.
    This service only contacts 127.0.0.1 / localhost directly (both stay
    listed), so removing the bracketed literals is safe.
    """
    for var in ("no_proxy", "NO_PROXY"):
        val = os.environ.get(var)
        if not val:
            continue
        kept = [part for part in val.split(",") if "[" not in part and "]" not in part]
        os.environ[var] = ",".join(kept)


_sanitize_no_proxy_env()

import chromadb
from fastapi import APIRouter, HTTPException

from storage import DATA_DIR, Store

router = APIRouter(prefix="/rag", tags=["rag"])
logger = logging.getLogger("rag")

DB_DIR = Path(__file__).resolve().parent.parent / "shell_cracked_db"
COLLECTION_NAME = "rag_documents"
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

TEXT_EXTENSIONS = {".md", ".txt", ".py", ".ts", ".tsx"}
CHUNK_SIZE = 500
CHUNK_OVERLAP = 50
MAX_FILE_BYTES = 1_048_576  # 1 MB
MAX_FILES_PER_CALL = 200
DEFAULT_PATHS = ["docs", "README.md", "CHANGELOG.md"]

_client: Optional[chromadb.PersistentClient] = None
_collection = None


def get_collection():
    """Return the rag_documents collection, creating client/collection lazily."""
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
            f"RAG document service {action} failed: {exc}. "
            "The local embedding model may not have downloaded correctly "
            "(first run needs network access to fetch it once). "
            "No silent fallback was used."
        ),
    )


_index_store = Store("rag_index.json")


def _ensure_index_file() -> None:
    """Create backend/data/rag_index.json as {} if it does not exist yet."""
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(_index_store.path):
        with open(_index_store.path, "w", encoding="utf-8") as f:
            json.dump({}, f)


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class IngestIn(BaseModel):
    paths: Optional[List[str]] = Field(
        default=None,
        description="Files or directories to ingest, relative to the project root. "
        "Omitted or empty means the defaults: docs, README.md, CHANGELOG.md.",
    )


class QueryIn(BaseModel):
    query: str = Field(min_length=1, description="Natural-language question over the docs")
    n_results: int = Field(default=5, ge=1, le=20, description="Max chunks to retrieve")


def _resolve_within_root(entry: str) -> Path:
    """Resolve an ingest path against the project root, rejecting traversal."""
    raw = Path(entry)
    candidate = raw if raw.is_absolute() else PROJECT_ROOT / raw
    resolved = candidate.resolve()
    root = PROJECT_ROOT.resolve()
    if resolved != root and not resolved.is_relative_to(root):
        raise HTTPException(
            status_code=422,
            detail=f"Path traversal rejected: {entry!r} is outside the project root.",
        )
    return resolved


def _collect_candidates(paths: List[str]) -> List[Path]:
    """Turn path entries (files or directories) into an ordered file list."""
    seen: List[Path] = []
    for entry in paths:
        resolved = _resolve_within_root(entry)
        if resolved.is_dir():
            for child in sorted(resolved.rglob("*")):
                if child.is_file() and child.suffix.lower() in TEXT_EXTENSIONS:
                    seen.append(child.resolve())
        elif resolved.is_file():
            if resolved.suffix.lower() in TEXT_EXTENSIONS:
                seen.append(resolved)
            else:
                seen.append(resolved)  # kept so it can be reported as skipped
        else:
            # Non-existent path: represent it so it is reported as skipped.
            seen.append(resolved)
    # Deduplicate while preserving order.
    unique: List[Path] = []
    seen_keys = set()
    for p in seen:
        key = str(p)
        if key not in seen_keys:
            seen_keys.add(key)
            unique.append(p)
    return unique


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            digest.update(block)
    return digest.hexdigest()


def _chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> List[str]:
    """Split text into ~size-char chunks with ~overlap chars of overlap.

    Breaks at word boundaries (last space before the cut point) so words are
    not split across chunks.
    """
    chunks: List[str] = []
    start = 0
    n = len(text)
    while start < n:
        end = min(start + size, n)
        if end < n:
            cut = text.rfind(" ", start, end)
            if cut > start + 100:
                end = cut
        piece = text[start:end].strip()
        if piece:
            chunks.append(piece)
        if end >= n:
            break
        start = end - overlap
    return chunks


_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


def _extractive_answer(
    query: str, chunks: List[Dict[str, Any]], max_sentences: int = 3
) -> Dict[str, Any]:
    """Build an extractive answer: verbatim sentences cited as [file#chunk_index]."""
    terms = [t.lower() for t in re.findall(r"\w+", query) if len(t) > 2]
    scored: List[Dict[str, Any]] = []
    for chunk in chunks:
        words = re.findall(r"\w+", chunk["text"].lower())
        for sentence in _SENTENCE_SPLIT.split(chunk["text"]):
            sentence = sentence.strip()
            if not sentence:
                continue
            overlap = sum(sentence.lower().count(t) for t in terms)
            scored.append(
                {
                    "file": chunk["file"],
                    "chunk_index": chunk["chunk_index"],
                    "sentence": sentence,
                    "overlap": overlap,
                    "position": len(scored),
                }
            )
    scored.sort(key=lambda s: (-s["overlap"], s["position"]))
    top = [s for s in scored[:max_sentences] if s["overlap"] > 0 or not terms]
    if not top:
        top = scored[:max_sentences]
    citations = [
        {"file": s["file"], "chunk_index": s["chunk_index"], "sentence": s["sentence"]}
        for s in top
    ]
    answer = " ".join(f"{s['sentence']} [{s['file']}#{s['chunk_index']}]" for s in top)
    return {"answer": answer, "citations": citations}


@router.post("/ingest")
def ingest_documents(payload: IngestIn):
    """Index text documents into the local RAG collection.

    Chunked (~500 chars, ~50 overlap, word-boundary breaks), embedded with
    ChromaDB's default local embedding model. Files whose sha256 is unchanged
    are skipped; changed files have their old chunks replaced.
    """
    entries = payload.paths if payload.paths else DEFAULT_PATHS
    entries = [e for e in (p.strip() for p in entries) if e]
    if not entries:
        entries = DEFAULT_PATHS
    candidates = _collect_candidates(entries)
    collection = get_collection()
    _ensure_index_file()

    files_indexed = 0
    chunks_added = 0
    files_skipped = 0
    file_reports: List[Dict[str, Any]] = []

    root = PROJECT_ROOT.resolve()

    def _display(path: Path) -> str:
        return (
            str(path.relative_to(root))
            if path.is_relative_to(root)
            else str(path)
        )

    for path in candidates:
        if len(file_reports) >= MAX_FILES_PER_CALL:
            file_reports.append(
                {"path": _display(path), "chunks": 0, "status": "skipped"}
            )
            files_skipped += 1
            continue

        display = _display(path)

        if not path.is_file() or path.suffix.lower() not in TEXT_EXTENSIONS:
            file_reports.append({"path": display, "chunks": 0, "status": "skipped"})
            files_skipped += 1
            continue

        if path.stat().st_size > MAX_FILE_BYTES:
            file_reports.append({"path": display, "chunks": 0, "status": "skipped"})
            files_skipped += 1
            continue

        abs_id = str(path)
        sha = _sha256_file(path)
        record = _index_store.get(abs_id)
        if record is not None and record.get("sha256") == sha:
            file_reports.append(
                {
                    "path": display,
                    "chunks": int(record.get("chunks", 0)),
                    "status": "skipped_unchanged",
                }
            )
            files_skipped += 1
            continue

        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            file_reports.append({"path": display, "chunks": 0, "status": "skipped"})
            files_skipped += 1
            continue

        if not text.strip():
            file_reports.append({"path": display, "chunks": 0, "status": "skipped"})
            files_skipped += 1
            continue

        # Remove this file's old chunks before re-adding (changed or new file).
        try:
            old = collection.get(where={"file": display})
            old_ids: List[str] = old.get("ids") or []
            if old_ids:
                collection.delete(ids=old_ids)
        except Exception as exc:  # noqa: BLE001 — surfaced as a clear 503, never silent
            raise _embedding_error("ingest (delete old chunks)", exc)

        chunks = _chunk_text(text)
        ids = [f"{sha[:16]}:{i}" for i in range(len(chunks))]
        metadatas = [
            {"file": display, "chunk_index": i} for i in range(len(chunks))
        ]
        try:
            collection.add(ids=ids, documents=chunks, metadatas=metadatas)
        except Exception as exc:  # noqa: BLE001 — surfaced as a clear 503, never silent
            raise _embedding_error("ingest (embed/store)", exc)

        new_record = {
            "id": abs_id,
            "path": abs_id,
            "sha256": sha,
            "chunks": len(chunks),
            "indexed_at": _now(),
        }
        if _index_store.get(abs_id) is None:
            _index_store.create(new_record)
        else:
            _index_store.update(abs_id, new_record)

        file_reports.append({"path": display, "chunks": len(chunks), "status": "indexed"})
        files_indexed += 1
        chunks_added += len(chunks)

    return {
        "files_indexed": files_indexed,
        "chunks_added": chunks_added,
        "files_skipped": files_skipped,
        "files": file_reports,
    }


@router.post("/query")
def query_documents(payload: QueryIn):
    """Semantic search over indexed docs with an extractive cited answer.

    No generative model is used: the answer is verbatim sentences from the
    retrieved chunks, each cited as [file#chunk_index].
    """
    collection = get_collection()
    try:
        if collection.count() == 0:
            return {
                "query": payload.query,
                "answer": "",
                "citations": [],
                "chunks": [],
                "answer_type": "extractive",
                "note": "Extractive answer assembled from retrieved document chunks; "
                "no generative language model was used.",
            }
        raw = collection.query(
            query_texts=[payload.query], n_results=payload.n_results
        )
    except Exception as exc:  # noqa: BLE001 — surfaced as a clear 503, never silent
        raise _embedding_error("query", exc)

    ids: List[str] = (raw.get("ids") or [[]])[0]
    documents: List[str] = (raw.get("documents") or [[]])[0]
    metadatas: List[Dict[str, Any]] = (raw.get("metadatas") or [[]])[0]
    distances: List[float] = (raw.get("distances") or [[]])[0]

    chunks = []
    for i, rid in enumerate(ids):
        distance = distances[i] if i < len(distances) else 0.0
        meta = metadatas[i] if i < len(metadatas) else {}
        chunks.append(
            {
                "file": meta.get("file", ""),
                "chunk_index": meta.get("chunk_index", 0),
                "text": documents[i] if i < len(documents) else "",
                "score": round(1 / (1 + distance), 4),
            }
        )

    extracted = _extractive_answer(payload.query, chunks)
    return {
        "query": payload.query,
        "answer": extracted["answer"],
        "citations": extracted["citations"],
        "chunks": chunks,
        "answer_type": "extractive",
        "note": "Extractive answer assembled from retrieved document chunks; "
        "no generative language model was used.",
    }


@router.get("/health")
def rag_health():
    """RAG service health: indexed-file records and total chunk count."""
    _ensure_index_file()
    indexed_files = len(_index_store.all())
    try:
        total_chunks = get_collection().count()
    except Exception as exc:  # noqa: BLE001 — surfaced as a clear 503, never silent
        raise _embedding_error("health check", exc)
    return {
        "status": "ok",
        "service": "rag",
        "indexed_files": indexed_files,
        "total_chunks": total_chunks,
    }
