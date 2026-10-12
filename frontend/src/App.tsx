import { useEffect, useMemo, useState } from "react";
import {
  getHealth,
  listContacts,
  createContact,
  listDeals,
  createDeal,
  updateDealStage,
  getPipeline,
  listFunnels,
  createFunnel,
  recordEvent,
  getFunnelStats,
  kmeans,
  regression,
  quantumInfo,
  quantumAnneal,
  quantumGrover,
  type Contact,
  type Deal,
  type PipelineStageTotal,
  type Funnel,
  type FunnelStat,
  type KmeansResponse,
  type RegressionResponse,
  type AnnealResponse,
  type GroverResponse,
} from "./api";
import WorkflowStudioView from "./WorkflowStudio";
import RagView from "./views/RagView";
import AnomalyView from "./views/AnomalyView";
import AgentView from "./views/AgentView";
import ResearchView from "./views/ResearchView";

type Tab = "overview" | "crm" | "funnels" | "ml" | "quantum" | "workflow" | "rag" | "anomalies" | "agent" | "research";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "crm", label: "CRM" },
  { id: "funnels", label: "Funnels" },
  { id: "ml", label: "ML" },
  { id: "quantum", label: "Quantum Lab" },
  { id: "workflow", label: "Workflow Studio" },
  { id: "rag", label: "RAG" },
  { id: "anomalies", label: "Anomalies" },
  { id: "agent", label: "Agent" },
  { id: "research", label: "Research" },
];

const DEAL_STAGES = ["lead", "qualified", "proposal", "won", "lost"] as const;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function fmtNum(n: number, digits = 4): string {
  return Number.isFinite(n) ? n.toFixed(digits) : String(n);
}

function statusOk(status: unknown): boolean {
  return String(status ?? "").toLowerCase() === "ok";
}

export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <div className="app">
      <header className="header">
        <h1>
          Crabdeck Omni-Layer <span className="version">v0.2.0</span>
        </h1>
        <p className="subtitle">Single-machine operations console · gateway 127.0.0.1:3001</p>
      </header>
      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "tab active" : "tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main className="main">
        {tab === "overview" && <OverviewView />}
        {tab === "crm" && <CrmView />}
        {tab === "funnels" && <FunnelsView />}
        {tab === "ml" && <MlView />}
        {tab === "quantum" && <QuantumView />}
        {tab === "workflow" && <WorkflowStudioView />}
        {tab === "rag" && <RagView />}
        {tab === "anomalies" && <AnomalyView />}
        {tab === "agent" && <AgentView />}
        {tab === "research" && <ResearchView />}
      </main>
    </div>
  );
}

/* ================= Overview ================= */

function OverviewView() {
  const [gateway, setGateway] = useState<string | null>(null);
  const [backend, setBackend] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getHealth()
      .then((h) => {
        setGateway(h.gateway);
        setBackend(h.backend);
        setVersion(h.version ?? null);
        setError("");
      })
      .catch((e) => setError(errMsg(e)))
      .finally(() => setLoading(false));
  }, []);

  const apiGroups = [
    { group: "CRM", prefix: "/crm", desc: "Contacts, deals, pipeline" },
    { group: "Funnels", prefix: "/funnels", desc: "Funnels, events, stats" },
    { group: "ML", prefix: "/ml", desc: "K-means, regression" },
    { group: "Quantum Lab", prefix: "/quantum", desc: "Classical simulations only" },
    { group: "Memory", prefix: "/memory", desc: "Local semantic vault + recall cache" },
    { group: "RAG", prefix: "/rag", desc: "Extractive doc retrieval (no generative model)" },
    { group: "Anomalies", prefix: "/anomaly", desc: "Funnel conversion anomaly detection" },
    { group: "Agent", prefix: "/agent", desc: "Local ReAct tool-use loop" },
    { group: "Research", prefix: "/research", desc: "Deep-research pipeline + knowledge graph" },
  ];

  return (
    <div className="view">
      <h2>Overview</h2>
      {loading && <p className="muted">Checking services…</p>}
      {error && <p className="error">Health check failed: {error}</p>}
      {!loading && !error && (
        <div className="cards">
          <div className="card">
            <h3>Gateway</h3>
            <p>
              <span className={`dot ${statusOk(gateway) ? "green" : "red"}`} />{" "}
              {gateway ?? "unknown"} <span className="muted">· 127.0.0.1:3001</span>
            </p>
          </div>
          <div className="card">
            <h3>Backend</h3>
            <p>
              <span className={`dot ${statusOk(backend) ? "green" : "red"}`} />{" "}
              {backend ?? "unknown"} <span className="muted">· 127.0.0.1:8000</span>
            </p>
          </div>
          <div className="card">
            <h3>Version</h3>
            <p>{version ?? "not reported"}</p>
          </div>
        </div>
      )}
      <h3>API groups</h3>
      <table>
        <thead>
          <tr>
            <th>Group</th>
            <th>Path prefix</th>
            <th>Description</th>
            <th>Served from</th>
          </tr>
        </thead>
        <tbody>
          {apiGroups.map((g) => (
            <tr key={g.group}>
              <td>{g.group}</td>
              <td><code>{g.prefix}</code></td>
              <td>{g.desc}</td>
              <td><code>127.0.0.1:3001</code></td>
            </tr>
          ))}
          <tr>
            <td>Backend services</td>
            <td><code>/</code></td>
            <td>Upstream services proxied by the gateway</td>
            <td><code>127.0.0.1:8000</code></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/* ================= CRM ================= */

function CrmView() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [pipeline, setPipeline] = useState<PipelineStageTotal[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  // contact form
  const [cName, setCName] = useState("");
  const [cEmail, setCEmail] = useState("");
  const [cCompany, setCCompany] = useState("");
  const [cNotes, setCNotes] = useState("");
  // deal form
  const [dTitle, setDTitle] = useState("");
  const [dValue, setDValue] = useState("");
  const [dStage, setDStage] = useState<string>(DEAL_STAGES[0]);

  const refresh = () => {
    setLoading(true);
    Promise.all([listContacts(), listDeals(), getPipeline()])
      .then(([c, d, p]) => {
        setContacts(c);
        setDeals(d);
        setPipeline(p.stages);
        setError("");
      })
      .catch((e) => setError(errMsg(e)))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  const addContact = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cName.trim() || !cEmail.trim()) {
      setError("Contact name and email are required.");
      return;
    }
    createContact({
      name: cName.trim(),
      email: cEmail.trim(),
      company: cCompany.trim() || undefined,
      notes: cNotes.trim() || undefined,
    })
      .then((c) => {
        setContacts((prev) => [...prev, c]);
        setCName(""); setCEmail(""); setCCompany(""); setCNotes("");
        setError("");
      })
      .catch((e) => setError(errMsg(e)));
  };

  const addDeal = (e: React.FormEvent) => {
    e.preventDefault();
    const value = Number(dValue);
    if (!dTitle.trim() || !Number.isFinite(value)) {
      setError("Deal title and a numeric value are required.");
      return;
    }
    createDeal({ title: dTitle.trim(), value, stage: dStage })
      .then((d) => {
        setDeals((prev) => [...prev, d]);
        setDTitle(""); setDValue(""); setDStage(DEAL_STAGES[0]);
        return getPipeline();
      })
      .then((p) => setPipeline(p.stages))
      .catch((e) => setError(errMsg(e)));
  };

  const changeStage = (deal: Deal, stage: string) => {
    updateDealStage(deal.id, stage)
      .then((updated) => {
        setDeals((prev) => prev.map((d) => (d.id === deal.id ? updated : d)));
        return getPipeline();
      })
      .then((p) => setPipeline(p.stages))
      .catch((e) => setError(errMsg(e)));
  };

  const dealsByStage = useMemo(() => {
    const map: Record<string, Deal[]> = {};
    for (const s of DEAL_STAGES) map[s] = [];
    for (const d of deals) {
      (map[d.stage] ??= []).push(d);
    }
    return map;
  }, [deals]);

  const totals = useMemo(() => {
    const count = pipeline.reduce((a, s) => a + s.count, 0);
    const value = pipeline.reduce((a, s) => a + s.total_value, 0);
    return { count, value };
  }, [pipeline]);

  return (
    <div className="view">
      <h2>CRM</h2>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}

      <div className="grid-2">
        <section className="card">
          <h3>Contacts ({contacts.length})</h3>
          <table>
            <thead>
              <tr><th>Name</th><th>Email</th><th>Company</th><th>Notes</th></tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.email}</td>
                  <td>{c.company ?? "—"}</td>
                  <td>{c.notes ?? "—"}</td>
                </tr>
              ))}
              {contacts.length === 0 && !loading && (
                <tr><td colSpan={4} className="muted">No contacts yet.</td></tr>
              )}
            </tbody>
          </table>
          <h4>Add contact</h4>
          <form onSubmit={addContact} className="form">
            <input placeholder="Name *" value={cName} onChange={(e) => setCName(e.target.value)} />
            <input placeholder="Email *" value={cEmail} onChange={(e) => setCEmail(e.target.value)} />
            <input placeholder="Company" value={cCompany} onChange={(e) => setCCompany(e.target.value)} />
            <input placeholder="Notes" value={cNotes} onChange={(e) => setCNotes(e.target.value)} />
            <button type="submit">Add contact</button>
          </form>
        </section>

        <section className="card">
          <h3>Pipeline totals</h3>
          <table>
            <thead>
              <tr><th>Stage</th><th>Deals</th><th>Total value</th></tr>
            </thead>
            <tbody>
              {pipeline.map((s) => (
                <tr key={s.stage}>
                  <td>{s.stage}</td>
                  <td>{s.count}</td>
                  <td>{fmtMoney(s.total_value)}</td>
                </tr>
              ))}
              {pipeline.length === 0 && !loading && (
                <tr><td colSpan={3} className="muted">No pipeline data.</td></tr>
              )}
            </tbody>
            {pipeline.length > 0 && (
              <tfoot>
                <tr>
                  <td><strong>Total</strong></td>
                  <td><strong>{totals.count}</strong></td>
                  <td><strong>{fmtMoney(totals.value)}</strong></td>
                </tr>
              </tfoot>
            )}
          </table>
        </section>
      </div>

      <section className="card">
        <h3>Deals board</h3>
        <form onSubmit={addDeal} className="form inline-form">
          <input placeholder="Deal title *" value={dTitle} onChange={(e) => setDTitle(e.target.value)} />
          <input placeholder="Value *" inputMode="decimal" value={dValue} onChange={(e) => setDValue(e.target.value)} />
          <select value={dStage} onChange={(e) => setDStage(e.target.value)}>
            {DEAL_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button type="submit">Add deal</button>
        </form>
        <div className="board">
          {DEAL_STAGES.map((stage) => (
            <div key={stage} className="board-col">
              <h4>{stage} ({dealsByStage[stage].length})</h4>
              {dealsByStage[stage].map((d) => (
                <div key={d.id} className="deal-card">
                  <div className="deal-title">{d.title}</div>
                  <div className="deal-value">{fmtMoney(d.value)}</div>
                  <select
                    value={d.stage}
                    onChange={(e) => changeStage(d, e.target.value)}
                    aria-label={`Move deal ${d.title} to stage`}
                  >
                    {DEAL_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ================= Funnels ================= */

function FunnelsView() {
  const [funnels, setFunnels] = useState<Funnel[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [stats, setStats] = useState<FunnelStat[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const [fName, setFName] = useState("");
  const [fStages, setFStages] = useState("");
  const [visitorId, setVisitorId] = useState("");
  const [eventStage, setEventStage] = useState("");

  const selected = funnels.find((f) => f.id === selectedId) ?? null;

  const loadStats = (id: number) => {
    getFunnelStats(id)
      .then((r) => {
        setStats(r.stats);
        setError("");
      })
      .catch((e) => setError(errMsg(e)));
  };

  useEffect(() => {
    listFunnels()
      .then((f) => {
        setFunnels(f);
        if (f.length > 0) {
          setSelectedId(f[0].id);
          setEventStage(f[0].stages[0] ?? "");
          loadStats(f[0].id);
        }
        setError("");
      })
      .catch((e) => setError(errMsg(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (id: number) => {
    setSelectedId(id);
    const f = funnels.find((x) => x.id === id);
    setEventStage(f?.stages[0] ?? "");
    setStats([]);
    loadStats(id);
  };

  const addFunnel = (e: React.FormEvent) => {
    e.preventDefault();
    const stages = fStages.split(",").map((s) => s.trim()).filter(Boolean);
    if (!fName.trim() || stages.length === 0) {
      setError("Funnel name and at least one stage are required.");
      return;
    }
    createFunnel({ name: fName.trim(), stages })
      .then((f) => {
        setFunnels((prev) => [...prev, f]);
        setFName(""); setFStages("");
        pick(f.id);
      })
      .catch((e) => setError(errMsg(e)));
  };

  const submitEvent = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedId == null || !visitorId.trim() || !eventStage) {
      setError("Select a funnel and provide a visitor id and stage.");
      return;
    }
    recordEvent(selectedId, { visitor_id: visitorId.trim(), stage: eventStage })
      .then(() => {
        setVisitorId("");
        loadStats(selectedId);
      })
      .catch((e) => setError(errMsg(e)));
  };

  return (
    <div className="view">
      <h2>Funnels</h2>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}

      <div className="grid-2">
        <section className="card">
          <h3>Funnels ({funnels.length})</h3>
          <ul className="list">
            {funnels.map((f) => (
              <li key={f.id}>
                <button
                  className={f.id === selectedId ? "link active" : "link"}
                  onClick={() => pick(f.id)}
                >
                  {f.name}
                </button>
                <span className="muted"> · {f.stages.join(" → ")}</span>
              </li>
            ))}
            {funnels.length === 0 && !loading && <li className="muted">No funnels yet.</li>}
          </ul>
          <h4>Create funnel</h4>
          <form onSubmit={addFunnel} className="form">
            <input placeholder="Funnel name *" value={fName} onChange={(e) => setFName(e.target.value)} />
            <input
              placeholder="Stages, comma-separated * (e.g. visit, signup, purchase)"
              value={fStages}
              onChange={(e) => setFStages(e.target.value)}
            />
            <button type="submit">Create funnel</button>
          </form>
        </section>

        <section className="card">
          <h3>Record event{selected ? ` — ${selected.name}` : ""}</h3>
          {selected ? (
            <form onSubmit={submitEvent} className="form">
              <input placeholder="Visitor id *" value={visitorId} onChange={(e) => setVisitorId(e.target.value)} />
              <select value={eventStage} onChange={(e) => setEventStage(e.target.value)}>
                {selected.stages.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button type="submit">Record event</button>
            </form>
          ) : (
            <p className="muted">Create or select a funnel to record events.</p>
          )}
        </section>
      </div>

      {selected && (
        <section className="card">
          <h3>Stats — {selected.name}</h3>
          <table>
            <thead>
              <tr>
                <th>Stage</th>
                <th>Unique visitors</th>
                <th>Conversion from previous</th>
                <th>Conversion from first</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.stage}>
                  <td>{s.stage}</td>
                  <td>{s.unique_visitors}</td>
                  <td>{s.conversion_from_previous == null ? "—" : `${(s.conversion_from_previous * 100).toFixed(1)}%`}</td>
                  <td>{`${(s.conversion_from_first * 100).toFixed(1)}%`}</td>
                </tr>
              ))}
              {stats.length === 0 && (
                <tr><td colSpan={4} className="muted">No stats yet — record some events.</td></tr>
              )}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

/* ================= ML ================= */

const KMEANS_SAMPLE = "1,2\n1.5,1.8\n1,0.6\n5,8\n8,8\n9,11\n8,2\n10,2\n9,3";
const REG_X_SAMPLE = "1,2,3,4,5,6,7,8";
const REG_Y_SAMPLE = "2.1,3.9,6.2,8.1,9.8,12.2,13.9,16.1";

function parsePoints(text: string): [number, number][] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error("Enter at least one point (one x,y per line).");
  return lines.map((line, i) => {
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length !== 2) throw new Error(`Line ${i + 1}: expected "x,y", got "${line}".`);
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Line ${i + 1}: "${line}" is not a pair of numbers.`);
    }
    return [x, y] as [number, number];
  });
}

function parseSeries(text: string, label: string): number[] {
  const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error(`Enter at least one value for ${label}.`);
  return parts.map((p, i) => {
    const v = Number(p);
    if (!Number.isFinite(v)) throw new Error(`${label}[${i}]: "${p}" is not a number.`);
    return v;
  });
}

function MlView() {
  const [pointsText, setPointsText] = useState(KMEANS_SAMPLE);
  const [kText, setKText] = useState("3");
  const [kmeansResult, setKmeansResult] = useState<KmeansResponse | null>(null);
  const [kmeansPoints, setKmeansPoints] = useState<[number, number][]>([]);
  const [kmeansError, setKmeansError] = useState("");
  const [kmeansBusy, setKmeansBusy] = useState(false);

  const [xText, setXText] = useState(REG_X_SAMPLE);
  const [yText, setYText] = useState(REG_Y_SAMPLE);
  const [regResult, setRegResult] = useState<RegressionResponse | null>(null);
  const [regError, setRegError] = useState("");
  const [regBusy, setRegBusy] = useState(false);

  const runKmeans = () => {
    setKmeansError("");
    setKmeansResult(null);
    let points: [number, number][];
    try {
      points = parsePoints(pointsText);
    } catch (e) {
      setKmeansError(errMsg(e));
      return;
    }
    const k = Number(kText);
    if (!Number.isInteger(k) || k < 1) {
      setKmeansError("k must be a positive integer.");
      return;
    }
    if (k > points.length) {
      setKmeansError(`k (${k}) cannot exceed the number of points (${points.length}).`);
      return;
    }
    setKmeansBusy(true);
    kmeans(points, k)
      .then((r) => {
        setKmeansResult(r);
        setKmeansPoints(points);
      })
      .catch((e) => setKmeansError(errMsg(e)))
      .finally(() => setKmeansBusy(false));
  };

  const runRegression = () => {
    setRegError("");
    setRegResult(null);
    let x: number[];
    let y: number[];
    try {
      x = parseSeries(xText, "x");
      y = parseSeries(yText, "y");
    } catch (e) {
      setRegError(errMsg(e));
      return;
    }
    if (x.length !== y.length) {
      setRegError(`x and y must have the same length (got ${x.length} and ${y.length}).`);
      return;
    }
    setRegBusy(true);
    regression(x, y)
      .then(setRegResult)
      .catch((e) => setRegError(errMsg(e)))
      .finally(() => setRegBusy(false));
  };

  return (
    <div className="view">
      <h2>ML</h2>
      <div className="grid-2">
        <section className="card">
          <h3>K-means clustering</h3>
          <div className="form">
            <label>
              Points <span className="muted">(one <code>x,y</code> per line)</span>
              <textarea rows={8} value={pointsText} onChange={(e) => setPointsText(e.target.value)} />
            </label>
            <label>
              k (clusters)
              <input inputMode="numeric" value={kText} onChange={(e) => setKText(e.target.value)} />
            </label>
            <div className="btn-row">
              <button onClick={() => setPointsText(KMEANS_SAMPLE)}>Load sample</button>
              <button onClick={runKmeans} disabled={kmeansBusy}>
                {kmeansBusy ? "Running…" : "Run k-means"}
              </button>
            </div>
          </div>
          {kmeansError && <p className="error">{kmeansError}</p>}
          {kmeansResult && (
            <div>
              <h4>Cluster assignments</h4>
              <table>
                <thead>
                  <tr><th>Point</th><th>Cluster</th></tr>
                </thead>
                <tbody>
                  {kmeansResult.assignments.map((c, i) => (
                    <tr key={i}>
                      <td><code>({kmeansPoints[i]?.[0]}, {kmeansPoints[i]?.[1]})</code></td>
                      <td>{c}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h4>Centroids</h4>
              <table>
                <thead>
                  <tr><th>Cluster</th><th>Centroid (x, y)</th></tr>
                </thead>
                <tbody>
                  {kmeansResult.centroids.map((c, i) => (
                    <tr key={i}>
                      <td>{i}</td>
                      <td><code>({fmtNum(c[0])}, {fmtNum(c[1])})</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card">
          <h3>Linear regression</h3>
          <div className="form">
            <label>
              x values <span className="muted">(comma-separated)</span>
              <textarea rows={3} value={xText} onChange={(e) => setXText(e.target.value)} />
            </label>
            <label>
              y values <span className="muted">(comma-separated)</span>
              <textarea rows={3} value={yText} onChange={(e) => setYText(e.target.value)} />
            </label>
            <div className="btn-row">
              <button onClick={() => { setXText(REG_X_SAMPLE); setYText(REG_Y_SAMPLE); }}>Load sample</button>
              <button onClick={runRegression} disabled={regBusy}>
                {regBusy ? "Running…" : "Run regression"}
              </button>
            </div>
          </div>
          {regError && <p className="error">{regError}</p>}
          {regResult && (
            <table>
              <tbody>
                <tr><td>Slope</td><td><code>{fmtNum(regResult.slope)}</code></td></tr>
                <tr><td>Intercept</td><td><code>{fmtNum(regResult.intercept)}</code></td></tr>
                <tr><td>R²</td><td><code>{fmtNum(regResult.r_squared)}</code></td></tr>
                <tr><td>n</td><td><code>{regResult.n}</code></td></tr>
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

/* ================= Quantum Lab ================= */

const SIM_LABEL = "Classical simulation — no quantum hardware involved";

function QuantumView() {
  const [infoNote, setInfoNote] = useState<string | null>(null);
  const [infoError, setInfoError] = useState("");

  const [objective, setObjective] = useState<"rastrigin" | "sphere">("rastrigin");
  const [dims, setDims] = useState("2");
  const [iterations, setIterations] = useState("500");
  const [annealResult, setAnnealResult] = useState<AnnealResponse | null>(null);
  const [annealError, setAnnealError] = useState("");
  const [annealBusy, setAnnealBusy] = useState(false);

  const [nQubits, setNQubits] = useState("3");
  const [target, setTarget] = useState("101");
  const [groverResult, setGroverResult] = useState<GroverResponse | null>(null);
  const [groverError, setGroverError] = useState("");
  const [groverBusy, setGroverBusy] = useState(false);

  useEffect(() => {
    quantumInfo()
      .then((info) => {
        setInfoNote(info.note);
        setInfoError("");
      })
      .catch((e) => setInfoError(errMsg(e)));
  }, []);

  const runAnneal = () => {
    setAnnealError("");
    setAnnealResult(null);
    const d = Number(dims);
    const it = Number(iterations);
    if (!Number.isInteger(d) || d < 1) {
      setAnnealError("Dimensions must be a positive integer.");
      return;
    }
    if (!Number.isInteger(it) || it < 1) {
      setAnnealError("Iterations must be a positive integer.");
      return;
    }
    setAnnealBusy(true);
    quantumAnneal({ objective, dims: d, iterations: it })
      .then(setAnnealResult)
      .catch((e) => setAnnealError(errMsg(e)))
      .finally(() => setAnnealBusy(false));
  };

  const runGrover = () => {
    setGroverError("");
    setGroverResult(null);
    const n = Number(nQubits);
    if (!Number.isInteger(n) || n < 1 || n > 8) {
      setGroverError("n_qubits must be an integer between 1 and 8.");
      return;
    }
    if (!/^[01]+$/.test(target.trim()) || target.trim().length !== n) {
      setGroverError(`Target must be a binary string of exactly ${n} bits.`);
      return;
    }
    setGroverBusy(true);
    quantumGrover({ n_qubits: n, target: target.trim() })
      .then(setGroverResult)
      .catch((e) => setGroverError(errMsg(e)))
      .finally(() => setGroverBusy(false));
  };

  return (
    <div className="view">
      <h2>Quantum Lab</h2>
      <div className="sim-banner">
        <strong>⚛ {SIM_LABEL}</strong>
        <p>
          Every result on this page comes from a classical numerical simulation running on this
          machine. Nothing here executes on quantum hardware.
        </p>
      </div>
      {infoNote && <p className="info-note"><strong>Backend note:</strong> {infoNote}</p>}
      {infoError && <p className="error">Could not load /quantum/info: {infoError}</p>}

      <div className="grid-2">
        <section className="card">
          <h3>Simulated annealing</h3>
          <p className="muted small">{SIM_LABEL}</p>
          <div className="form">
            <label>
              Objective
              <select value={objective} onChange={(e) => setObjective(e.target.value as "rastrigin" | "sphere")}>
                <option value="rastrigin">rastrigin</option>
                <option value="sphere">sphere</option>
              </select>
            </label>
            <label>
              Dimensions
              <input inputMode="numeric" value={dims} onChange={(e) => setDims(e.target.value)} />
            </label>
            <label>
              Iterations
              <input inputMode="numeric" value={iterations} onChange={(e) => setIterations(e.target.value)} />
            </label>
            <div className="btn-row">
              <button onClick={runAnneal} disabled={annealBusy}>
                {annealBusy ? "Running…" : "Run annealing"}
              </button>
            </div>
          </div>
          {annealError && <p className="error">{annealError}</p>}
          {annealResult && (
            <div>
              <p className="muted small">{SIM_LABEL}</p>
              <table>
                <tbody>
                  <tr><td>Objective</td><td><code>{annealResult.objective}</code></td></tr>
                  <tr><td>Best value</td><td><code>{fmtNum(annealResult.best_value)}</code></td></tr>
                  <tr>
                    <td>Best solution</td>
                    <td><code>[{annealResult.best_solution.map((v) => fmtNum(v)).join(", ")}]</code></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card">
          <h3>Grover search simulation</h3>
          <p className="muted small">{SIM_LABEL}</p>
          <div className="form">
            <label>
              Qubits (n ≤ 8)
              <input inputMode="numeric" value={nQubits} onChange={(e) => setNQubits(e.target.value)} />
            </label>
            <label>
              Target <span className="muted">(binary string, n bits)</span>
              <input value={target} onChange={(e) => setTarget(e.target.value)} />
            </label>
            <div className="btn-row">
              <button onClick={runGrover} disabled={groverBusy}>
                {groverBusy ? "Running…" : "Run Grover simulation"}
              </button>
            </div>
          </div>
          {groverError && <p className="error">{groverError}</p>}
          {groverResult && (
            <div>
              <p className="muted small">{SIM_LABEL}</p>
              <table>
                <tbody>
                  <tr><td>Target</td><td><code>{groverResult.target}</code></td></tr>
                  <tr><td>Search space</td><td><code>{groverResult.search_space}</code></td></tr>
                  <tr><td>Optimal iterations</td><td><code>{groverResult.optimal_iterations}</code></td></tr>
                  <tr>
                    <td>Success probability</td>
                    <td><code>{(groverResult.success_probability * 100).toFixed(2)}%</code></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
