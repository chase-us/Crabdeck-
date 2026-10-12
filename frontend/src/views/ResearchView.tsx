import { useMemo, useState } from "react";
import ReactFlow, { Background, Controls, MiniMap, type Node, type Edge } from "reactflow";
import "reactflow/dist/style.css";
import {
  runResearch,
  getTrends,
  retrieveProjections,
  type ResearchRunResponse,
  type TrendsResponse,
  type RetrieveResult,
} from "../clients/research";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const SOURCE_PLACEHOLDER = "file:docs/ARCHITECTURE.md\nfile:README.md";

function parseSources(text: string): { type: "url" | "file"; ref: string }[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(url|file):(.*)$/i);
      if (!m) throw new Error(`Source line must look like "url:..." or "file:...": "${line}"`);
      return { type: m[1].toLowerCase() as "url" | "file", ref: m[2].trim() };
    });
}

export default function ResearchView() {
  const [topic, setTopic] = useState("");
  const [sourcesText, setSourcesText] = useState(SOURCE_PLACEHOLDER);
  const [perspText, setPerspText] = useState("");
  const [result, setResult] = useState<ResearchRunResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [trends, setTrends] = useState<TrendsResponse | null>(null);
  const [trendsError, setTrendsError] = useState("");

  const [qText, setQText] = useState("");
  const [qResults, setQResults] = useState<RetrieveResult[]>([]);
  const [qBusy, setQBusy] = useState(false);
  const [qError, setQError] = useState("");

  const [graphTab, setGraphTab] = useState(false);

  const run = () => {
    setError("");
    setResult(null);
    setTrends(null);
    let sources;
    try {
      if (!topic.trim()) throw new Error("Topic is required.");
      sources = parseSources(sourcesText);
      if (sources.length === 0) throw new Error("Add at least one source.");
    } catch (e) {
      setError(errMsg(e));
      return;
    }
    const perspectives = perspText.split(",").map((s) => s.trim()).filter(Boolean);
    setBusy(true);
    runResearch(topic.trim(), sources, perspectives.length ? perspectives : undefined)
      .then((r) => {
        setResult(r);
        return getTrends(r.topic).catch(() => null);
      })
      .then((t) => {
        if (t) setTrends(t);
      })
      .catch((e) => setError(errMsg(e)))
      .finally(() => setBusy(false));
  };

  const retrieve = () => {
    setQError("");
    setQResults([]);
    if (!qText.trim()) {
      setQError("Enter a query.");
      return;
    }
    setQBusy(true);
    retrieveProjections(qText.trim(), 5, result?.topic)
      .then((r) => setQResults(r.results))
      .catch((e) => setQError(errMsg(e)))
      .finally(() => setQBusy(false));
  };

  const flowNodes: Node[] = useMemo(() => {
    const nodes = result?.survey.graph.nodes ?? [];
    return nodes.map((n, i) => ({
      id: String(n.id),
      data: { label: `${n.label} (${n.size})` },
      position: { x: 60 + i * 260, y: 80 + (i % 2) * 120 },
      style: {
        background: "#1b212b",
        color: "#e8ecf3",
        border: "1px solid #3a4356",
        borderRadius: 8,
        padding: 10,
        width: 220,
      },
    }));
  }, [result]);

  const flowEdges: Edge[] = useMemo(() => {
    const edges = result?.survey.graph.edges ?? [];
    return edges.map((e, i) => ({
      id: `e${i}`,
      source: String(e.from),
      target: String(e.to),
      label: e.similarity.toFixed(2),
      animated: true,
    }));
  }, [result]);

  const survey = result?.survey;

  return (
    <div className="view">
      <h2>Deep Research</h2>
      <p className="muted">
        Collect → reason → project → analyze. URLs are fetched with an SSRF guard
        (public IPs only); files are confined to the project root.
      </p>
      {error && <p className="error">{error}</p>}

      <section className="card">
        <h3>Run a research survey</h3>
        <div className="form">
          <label>
            Topic *
            <input placeholder="e.g. retrieval-augmented generation" value={topic} onChange={(e) => setTopic(e.target.value)} />
          </label>
          <label>
            Sources * <span className="muted">(one per line: <code>url:…</code> or <code>file:…</code>)</span>
            <textarea rows={4} value={sourcesText} onChange={(e) => setSourcesText(e.target.value)} />
          </label>
          <label>
            Perspectives <span className="muted">(optional, comma-separated; default: Input, Modeling, Output, Objective, Method)</span>
            <input placeholder="Input, Modeling, Output, Objective, Method" value={perspText} onChange={(e) => setPerspText(e.target.value)} />
          </label>
          <div className="btn-row">
            <button onClick={run} disabled={busy}>{busy ? "Running…" : "Run research"}</button>
            {survey && survey.graph.nodes.length > 0 && (
              <button onClick={() => setGraphTab((v) => !v)}>
                {graphTab ? "Hide research graph" : "Show research graph"}
              </button>
            )}
          </div>
        </div>
      </section>

      {survey && (
        <section className="card">
          <h3>Survey — {survey.topic}</h3>
          <p className="muted">
            Extractor: <code>{survey.extractor ?? result?.extractor}</code>
            {result?.model ? <> · model <code>{result.model}</code> ({result.backend})</> : null}
          </p>
          <p className="info-note">{survey.note}</p>
          {survey.categories.map((c, i) => (
            <div key={i} className="card" style={{ marginTop: 12 }}>
              <h4>{c.name}</h4>
              <p>{c.summary || <span className="muted">No summary extracted.</span>}</p>
              <p className="muted small">
                {c.doc_count} projection{c.doc_count === 1 ? "" : "s"} · top terms: {c.top_terms.join(", ") || "—"} ·
                term momentum {c.term_momentum.toFixed(3)} <span title={c.momentum_note}>ⓘ</span>
              </p>
              <p className="muted small">Sources: {c.sources.join(", ") || "—"}</p>
            </div>
          ))}
          {survey.categories.length === 0 && <p className="muted">No categories produced.</p>}
        </section>
      )}

      {graphTab && survey && survey.graph.nodes.length > 0 && (
        <section className="card">
          <h3>Research graph</h3>
          <p className="muted small">
            Nodes are topic clusters; edges are centroid cosine similarities above 0.7.
          </p>
          <div style={{ height: 420, border: "1px solid #2a2f3e", borderRadius: 8 }}>
            <ReactFlow nodes={flowNodes} edges={flowEdges} fitView>
              <Background color="#2a2f3e" gap={24} size={1} />
              <Controls />
              <MiniMap maskColor="rgba(10, 11, 16, 0.7)" />
            </ReactFlow>
          </div>
        </section>
      )}

      {trends && (
        <section className="card">
          <h3>Trends <span className="muted small">(by {trends.bucket_by}; real document counts)</span></h3>
          {trendsError && <p className="error">{trendsError}</p>}
          <table>
            <thead>
              <tr><th>Bucket</th><th>Cluster</th><th>Documents</th></tr>
            </thead>
            <tbody>
              {trends.buckets.flatMap((b) =>
                Object.entries(b.clusters).map(([cid, count]) => (
                  <tr key={`${b.bucket}-${cid}`}>
                    <td><code>{b.bucket}</code></td>
                    <td>{cid}</td>
                    <td>{count}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h3>Retrieve projections</h3>
        <div className="form inline-form">
          <input
            placeholder="Semantic query over research projections"
            value={qText}
            onChange={(e) => setQText(e.target.value)}
            style={{ flex: 1 }}
          />
          <button onClick={retrieve} disabled={qBusy}>{qBusy ? "Searching…" : "Search"}</button>
        </div>
        {qError && <p className="error">{qError}</p>}
        {qResults.length > 0 && (
          <table>
            <thead>
              <tr><th>Score</th><th>Source</th><th>Perspective</th><th>Text</th></tr>
            </thead>
            <tbody>
              {qResults.map((r) => (
                <tr key={r.id}>
                  <td><code>{r.score.toFixed(3)}</code></td>
                  <td>{r.source ?? "—"}</td>
                  <td>{r.perspective ?? "—"}</td>
                  <td>{r.text.slice(0, 240)}{r.text.length > 240 ? "…" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
