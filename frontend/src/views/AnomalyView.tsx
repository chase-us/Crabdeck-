import { useEffect, useState } from "react";
import { getAnomalies, type AnomalyResponse } from "../clients/anomaly";
import { listFunnels, type Funnel } from "../api";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function severityStyle(severity: string): React.CSSProperties {
  return {
    color: severity === "critical" ? "var(--danger)" : "var(--warning)",
    fontWeight: 600,
    textTransform: "capitalize",
  };
}

export default function AnomalyView() {
  const [funnels, setFunnels] = useState<Funnel[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [windowDays, setWindowDays] = useState("7");
  const [zThreshold, setZThreshold] = useState("3.0");
  const [result, setResult] = useState<AnomalyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    listFunnels()
      .then((f) => {
        setFunnels(f);
        if (f.length > 0) setSelectedId(String(f[0].id));
        setError("");
      })
      .catch((e) => setError(errMsg(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const detect = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!selectedId) {
      setError("Select a funnel first.");
      return;
    }
    const wd = Number(windowDays);
    const zt = Number(zThreshold);
    if (!Number.isInteger(wd) || wd < 2 || wd > 90) {
      setError("window_days must be an integer between 2 and 90.");
      return;
    }
    if (!Number.isFinite(zt) || zt <= 0) {
      setError("z_threshold must be a positive number.");
      return;
    }
    setLoading(true);
    setError("");
    getAnomalies(selectedId, wd, zt)
      .then((r) => {
        setResult(r);
        setError("");
      })
      .catch((e) => setError(errMsg(e)))
      .finally(() => setLoading(false));
  };

  return (
    <div className="view">
      <h2>Funnel anomaly detection</h2>
      <p className="muted small">
        Detects anomalous daily conversion changes per funnel stage using a
        rolling-window z-score detector and a CUSUM mean-shift detector.
        Conversion each day is unique visitors at the stage ÷ unique visitors
        at the first stage.
      </p>

      <section className="card">
        <h3>Detect anomalies</h3>
        <form onSubmit={detect} className="form inline-form">
          <label>
            Funnel
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              {funnels.map((f) => (
                <option key={String(f.id)} value={String(f.id)}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            window_days
            <input
              type="number"
              min={2}
              max={90}
              step={1}
              value={windowDays}
              onChange={(e) => setWindowDays(e.target.value)}
            />
          </label>
          <label>
            z_threshold
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={zThreshold}
              onChange={(e) => setZThreshold(e.target.value)}
            />
          </label>
          <button type="submit" disabled={loading}>
            Detect
          </button>
        </form>
      </section>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}

      {result && !loading && (
        <>
          <section className="card">
            <h3>
              Anomalies — {result.name} ({result.anomalies.length})
            </h3>
            <p className="muted small">
              Window: {result.window_days} days · z_threshold: {result.z_threshold}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Stage</th>
                  <th>Observed</th>
                  <th>Expected</th>
                  <th>Z-score</th>
                  <th>Severity</th>
                  <th>Method</th>
                </tr>
              </thead>
              <tbody>
                {result.anomalies.map((a) => (
                  <tr key={`${a.date}-${a.stage}-${a.method}`}>
                    <td>{a.date}</td>
                    <td>{a.stage}</td>
                    <td>{(a.observed * 100).toFixed(1)}%</td>
                    <td>{(a.expected * 100).toFixed(1)}%</td>
                    <td>{a.z_score.toFixed(4)}</td>
                    <td>
                      <span style={severityStyle(a.severity)}>{a.severity}</span>
                    </td>
                    <td>{a.method}</td>
                  </tr>
                ))}
                {result.anomalies.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted">
                      No anomalies detected in this funnel.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          <section className="card">
            <h3>Daily series ({result.daily_series.length} points)</h3>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Stage</th>
                  <th>Conversion</th>
                </tr>
              </thead>
              <tbody>
                {result.daily_series.map((d) => (
                  <tr key={`${d.date}-${d.stage}`}>
                    <td>{d.date}</td>
                    <td>{d.stage}</td>
                    <td>{(d.conversion * 100).toFixed(1)}%</td>
                  </tr>
                ))}
                {result.daily_series.length === 0 && (
                  <tr>
                    <td colSpan={3} className="muted">
                      No events in this funnel yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
