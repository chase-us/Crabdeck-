import { useEffect, useState } from "react";
import { listAgentTools, runAgent, type AgentToolDef, type AgentRunResponse } from "../clients/agent";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function AgentView() {
  const [tools, setTools] = useState<AgentToolDef[]>([]);
  const [toolsError, setToolsError] = useState("");

  const [goal, setGoal] = useState("List my contacts and tell me how many deals are in the pipeline.");
  const [maxSteps, setMaxSteps] = useState("8");
  const [result, setResult] = useState<AgentRunResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    listAgentTools()
      .then(setTools)
      .catch((e) => setToolsError(errMsg(e)));
  }, []);

  const run = () => {
    setError("");
    setResult(null);
    if (!goal.trim()) {
      setError("Enter a goal for the agent.");
      return;
    }
    const steps = Math.max(1, Math.min(20, Number(maxSteps) || 8));
    setBusy(true);
    runAgent(goal.trim(), steps)
      .then(setResult)
      .catch((e) => setError(errMsg(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="view">
      <h2>Agent</h2>
      <p className="muted">
        Local ReAct loop. The agent plans with a language model, then calls only the
        registered local tools below — nothing outside this machine. Requires a
        configured LLM backend (Ollama at 127.0.0.1:11434 or an OpenAI-compatible
        endpoint); otherwise the run returns HTTP 503 with setup instructions.
      </p>
      {error && <p className="error">{error}</p>}

      <section className="card">
        <h3>Goal</h3>
        <div className="form">
          <textarea
            rows={3}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="What should the agent do?"
          />
          <label>
            Max steps
            <input inputMode="numeric" value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} />
          </label>
          <div className="btn-row">
            <button onClick={run} disabled={busy}>{busy ? "Running…" : "Run agent"}</button>
          </div>
        </div>
      </section>

      {result && (
        <section className="card">
          <h3>Result</h3>
          <p className="muted small">
            Model: <code>{result.model ?? "n/a"}</code> · backend: <code>{result.backend ?? "n/a"}</code> ·
            steps taken: {result.steps_taken}
          </p>
          <h4>Step transcript</h4>
          {result.steps.map((s, i) => (
            <div key={i} className="card" style={{ marginTop: 8 }}>
              <p><strong>Step {i + 1} — thought:</strong> {s.thought}</p>
              {s.tool ? (
                <>
                  <p><strong>Tool:</strong> <code>{s.tool}</code></p>
                  <p><strong>Args:</strong> <code>{JSON.stringify(s.args)}</code></p>
                </>
              ) : (
                <p className="muted">No tool call this step.</p>
              )}
              <p><strong>Observation:</strong> <code style={{ whiteSpace: "pre-wrap" }}>{s.observation}</code></p>
            </div>
          ))}
          <h4>Final answer</h4>
          <p style={{ whiteSpace: "pre-wrap" }}>{result.final_answer}</p>
        </section>
      )}

      <section className="card">
        <h3>Registered tools ({tools.length})</h3>
        {toolsError && <p className="error">{toolsError}</p>}
        <table>
          <thead>
            <tr><th>Tool</th><th>Description</th></tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <tr key={t.name}>
                <td><code>{t.name}</code></td>
                <td>{t.description}</td>
              </tr>
            ))}
            {tools.length === 0 && !toolsError && (
              <tr><td colSpan={2} className="muted">Loading tools…</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
