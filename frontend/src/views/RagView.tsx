import { useState } from "react";
import {
  ingestDocs,
  queryDocs,
  getRagHealth,
  type RagIngestResponse,
  type RagQueryResponse,
  type RagHealth,
} from "../clients/rag";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmtNum(n: number, digits = 4): string {
  return Number.isFinite(n) ? n.toFixed(digits) : String(n);
}

function excerpt(text: string, maxLen = 140): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
}

export default function RagView() {
  // ---- ingest state ----
  const [pathsInput, setPathsInput] = useState("");
  const [ingestResult, setIngestResult] = useState<RagIngestResponse | null>(null);
  const [ingestLoading, setIngestLoading] = useState(false);
  const [ingestError, setIngestError] = useState("");

  // ---- query state ----
  const [query, setQuery] = useState("");
  const [nResults, setNResults] = useState(5);
  const [queryResult, setQueryResult] = useState<RagQueryResponse | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState("");

  // ---- health state ----
  const [health, setHealth] = useState<RagHealth | null>(null);
  const [healthError, setHealthError] = useState("");

  const runIngest = (e: React.FormEvent) => {
    e.preventDefault();
    setIngestLoading(true);
    setIngestError("");
    const paths = pathsInput
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    ingestDocs(paths.length > 0 ? paths : undefined)
      .then((r) => {
        setIngestResult(r);
        setIngestError("");
      })
      .catch((err) => setIngestError(errMsg(err)))
      .finally(() => setIngestLoading(false));
  };

  const runQuery = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) {
      setQueryError("Enter a question first.");
      return;
    }
    setQueryLoading(true);
    setQueryError("");
    queryDocs(query.trim(), nResults)
      .then((r) => {
        setQueryResult(r);
        setQueryError("");
      })
      .catch((err) => setQueryError(errMsg(err)))
      .finally(() => setQueryLoading(false));
  };

  const checkHealth = () => {
    setHealthError("");
    getRagHealth()
      .then((h) => setHealth(h))
      .catch((err) => setHealthError(errMsg(err)));
  };

  return (
    <div className="view">
      <h2>RAG over docs</h2>
      <p className="muted">
        Local-only document retrieval: docs are chunked and embedded on this
        machine, and answers are <strong>extractive</strong> — verbatim
        sentences from the retrieved chunks, cited as{" "}
        <code>[file#chunk_index]</code>. No generative language model is used.
      </p>
      <div className="btn-row" style={{ marginBottom: 16 }}>
        <button type="button" onClick={checkHealth}>
          Check index health
        </button>
      </div>
      {healthError && <p className="error">Health check failed: {healthError}</p>}
      {health && (
        <p className="muted">
          Indexed files: {health.indexed_files} · Total chunks: {health.total_chunks} ·
          Status: {health.status}
        </p>
      )}

      <div className="grid-2">
        {/* ---- Ingest card ---- */}
        <section className="card">
          <h3>Ingest</h3>
          <form onSubmit={runIngest} className="form">
            <input
              placeholder="Comma-separated paths (empty = defaults: docs, README.md, CHANGELOG.md)"
              value={pathsInput}
              onChange={(e) => setPathsInput(e.target.value)}
            />
            <div className="btn-row">
              <button type="submit" disabled={ingestLoading}>
                {ingestLoading ? "Indexing…" : "Ingest"}
              </button>
            </div>
          </form>
          {ingestError && <p className="error">{ingestError}</p>}
          {ingestResult && !ingestLoading && (
            <div style={{ marginTop: 12 }}>
              <p className="muted small">
                Files indexed: {ingestResult.files_indexed} · Chunks added:{" "}
                {ingestResult.chunks_added} · Files skipped:{" "}
                {ingestResult.files_skipped}
              </p>
              <table>
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Chunks</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {ingestResult.files.map((f, i) => (
                    <tr key={`${f.path}-${i}`}>
                      <td>
                        <code>{f.path}</code>
                      </td>
                      <td>{f.chunks}</td>
                      <td>{f.status}</td>
                    </tr>
                  ))}
                  {ingestResult.files.length === 0 && (
                    <tr>
                      <td colSpan={3} className="muted">
                        No files matched.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ---- Query card ---- */}
        <section className="card">
          <h3>Query</h3>
          <form onSubmit={runQuery} className="form">
            <input
              placeholder="Ask a question about the docs *"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label>
              Results to retrieve
              <input
                type="number"
                min={1}
                max={20}
                value={nResults}
                onChange={(e) => setNResults(Number(e.target.value) || 5)}
              />
            </label>
            <div className="btn-row">
              <button type="submit" disabled={queryLoading}>
                {queryLoading ? "Searching…" : "Ask"}
              </button>
            </div>
          </form>
          {queryError && <p className="error">{queryError}</p>}
          {queryResult && !queryLoading && (
            <div style={{ marginTop: 12 }}>
              <h4>Extractive answer</h4>
              {queryResult.answer ? (
                <div className="info-note" style={{ marginBottom: 12 }}>
                  {queryResult.answer}
                </div>
              ) : (
                <p className="muted">No matching sentences found.</p>
              )}
              <p className="muted small">
                answer_type: {queryResult.answer_type} · citations:{" "}
                {queryResult.citations.length} · {queryResult.note}
              </p>
            </div>
          )}
        </section>
      </div>

      {/* ---- Retrieved chunks table ---- */}
      {queryResult && !queryLoading && (
        <section className="card">
          <h3>Retrieved chunks ({queryResult.chunks.length})</h3>
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Chunk #</th>
                <th>Score</th>
                <th>Excerpt</th>
              </tr>
            </thead>
            <tbody>
              {queryResult.chunks.map((c, i) => (
                <tr key={i}>
                  <td>
                    <code>{c.file}</code>
                  </td>
                  <td>{c.chunk_index}</td>
                  <td>{fmtNum(c.score)}</td>
                  <td className="small">{excerpt(c.text)}</td>
                </tr>
              ))}
              {queryResult.chunks.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No chunks retrieved — index is empty.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
