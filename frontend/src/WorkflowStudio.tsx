import { useCallback, useEffect, useRef, useState } from "react";
import ReactFlow, {
  addEdge,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type NodeChange,
} from "reactflow";
import "reactflow/dist/style.css";
import { create } from "zustand";
import { Subject } from "rxjs";
import { bufferTime } from "rxjs/operators";
import {
  makeLog,
  makeSignal,
  makeMetric,
  type LocalEvent,
  type LogLevel,
} from "./lib/events";
import {
  Zap,
  Cpu,
  Terminal,
  Database,
  GitBranch,
  Activity,
  Layers,
  Save,
  FolderOpen,
  Trash2,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  X,
} from "lucide-react";
import { listContacts, listDeals, listFunnels, getMemoryHealth } from "./api";
import "./workflow.css";

/* ==========================================================================
   Local event bus (zustand + rxjs) — typed via the canonical local event
   contract in ./lib/events. Terminal entries are REAL local workflow
   events — node added/removed, edges connected, validation results,
   save/load. Nothing here is simulated telemetry and nothing leaves
   this machine. No WAR_ROOM_COMMAND or remote dispatch exists.
   ========================================================================== */

interface WfState {
  logs: LocalEvent[];
  pushLogs: (entries: LocalEvent[]) => void;
  clearLogs: () => void;
}

const useWfStore = create<WfState>()((set) => ({
  logs: [],
  pushLogs: (entries) =>
    set((s) => ({ logs: [...entries, ...s.logs].slice(0, 150) })),
  clearLogs: () => set({ logs: [] }),
}));

// Batch high-frequency local events so the UI never re-renders per event.
const logBus = new Subject<LocalEvent>();
logBus.pipe(bufferTime(400)).subscribe((batch) => {
  if (batch.length > 0) useWfStore.getState().pushLogs(batch);
});

function log(tag: string, text: string, level: LogLevel = "info") {
  logBus.next(makeLog(tag, text, level));
}

function signal(agentId: string, status: "PENDING" | "SUCCESS" | "ERROR", detail?: string) {
  logBus.next(makeSignal(agentId, status, detail));
}

function metric(name: string, value: number, unit?: string) {
  logBus.next(makeMetric(name, value, unit));
}

/* ==========================================================================
   Node data + custom cyber-noir node components
   ========================================================================== */

interface WfNodeData {
  label: string;
  model?: string;
  temperature?: number;
  sourceType?: string;
  runtime?: string;
  threshold?: string;
  [key: string]: unknown;
}

type WfNode = Node<WfNodeData>;

function TriggerNode({ data }: NodeProps<WfNodeData>) {
  return (
    <div className="wf-node wf-node-trigger">
      <div className="wf-node-head">
        <span className="wf-node-title"><Zap size={14} /> Trigger Event</span>
        <span className="wf-pulse" />
      </div>
      <div className="wf-node-label">{data.label}</div>
      <div className="wf-node-meta">Source: {String(data.sourceType ?? "Manual")}</div>
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

function AgentNode({ data }: NodeProps<WfNodeData>) {
  return (
    <div className="wf-node wf-node-agent">
      <Handle type="target" position={Position.Left} className="wf-handle" />
      <div className="wf-node-head">
        <span className="wf-node-title"><Cpu size={14} /> Agent Node</span>
        <span className="wf-chip">{String(data.model ?? "local-model")}</span>
      </div>
      <div className="wf-node-label">{data.label}</div>
      <div className="wf-node-meta">Temp: {String(data.temperature ?? 0.2)} · local config</div>
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

function ToolNode({ data }: NodeProps<WfNodeData>) {
  return (
    <div className="wf-node wf-node-tool">
      <Handle type="target" position={Position.Left} className="wf-handle" />
      <div className="wf-node-head">
        <span className="wf-node-title"><Terminal size={14} /> Tool Action</span>
        <span className="wf-dot" />
      </div>
      <div className="wf-node-label">{data.label}</div>
      <div className="wf-node-meta">Runtime: {String(data.runtime ?? "Local process")}</div>
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

function StateNode({ data }: NodeProps<WfNodeData>) {
  return (
    <div className="wf-node wf-node-state">
      <Handle type="target" position={Position.Left} className="wf-handle" />
      <div className="wf-node-head">
        <span className="wf-node-title"><Database size={14} /> Shell Cracked</span>
      </div>
      <div className="wf-node-label">{data.label}</div>
      <div className="wf-node-meta">Vault: local ChromaDB</div>
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

function LogicNode({ data }: NodeProps<WfNodeData>) {
  return (
    <div className="wf-node wf-node-logic">
      <Handle type="target" position={Position.Left} className="wf-handle" />
      <div className="wf-node-head">
        <span className="wf-node-title"><GitBranch size={14} /> Routing Gate</span>
      </div>
      <div className="wf-node-label wf-node-label-center">{data.label}</div>
      <div className="wf-node-meta wf-node-meta-center">Threshold: {String(data.threshold ?? "0.85")}</div>
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

const nodeTypes = {
  trigger: TriggerNode,
  agent: AgentNode,
  tool: ToolNode,
  state: StateNode,
  logic: LogicNode,
};

/* ==========================================================================
   Initial local workflow
   ========================================================================== */

const initialNodes: WfNode[] = [
  { id: "1", type: "trigger", position: { x: 40, y: 160 }, data: { label: "Schedule Tick", sourceType: "Local timer" } },
  { id: "2", type: "agent", position: { x: 330, y: 90 }, data: { label: "Router Agent", model: "local-model", temperature: 0.2 } },
  { id: "3", type: "state", position: { x: 330, y: 330 }, data: { label: "Shell Cracked Vault" } },
  { id: "4", type: "logic", position: { x: 660, y: 160 }, data: { label: "Confidence Gate", threshold: "0.85" } },
  { id: "5", type: "tool", position: { x: 950, y: 90 }, data: { label: "Local Tool Runner", runtime: "Local process" } },
];

const initialEdges: Edge[] = [
  { id: "e1-2", source: "1", target: "2", animated: true, style: { stroke: "#00f3ff", strokeWidth: 2 } },
  { id: "e2-3", source: "2", target: "3", animated: false, style: { stroke: "#10b981", strokeWidth: 2 } },
  { id: "e2-4", source: "2", target: "4", animated: true, style: { stroke: "#FF4500", strokeWidth: 2 } },
  { id: "e4-5", source: "4", target: "5", animated: true, style: { stroke: "#9b51e0", strokeWidth: 2 } },
];

const EDGE_COLORS: Record<string, string> = {
  trigger: "#00f3ff",
  agent: "#FF4500",
  tool: "#9b51e0",
  state: "#10b981",
  logic: "#f59e0b",
};

const PALETTE = [
  { type: "trigger", label: "Trigger", desc: "Timers, webhooks, manual", Icon: Zap, cls: "cyan" },
  { type: "agent", label: "Agent", desc: "Model + temperature config", Icon: Cpu, cls: "orange" },
  { type: "tool", label: "Tool", desc: "Local actions & scripts", Icon: Terminal, cls: "purple" },
  { type: "state", label: "Memory", desc: "Shell Cracked vault", Icon: Database, cls: "green" },
  { type: "logic", label: "Logic", desc: "Branches & thresholds", Icon: GitBranch, cls: "amber" },
] as const;

const STORAGE_KEY = "crabdeck.workflow.v1";

interface LocalStats {
  contacts: number;
  deals: number;
  funnels: number;
  memories: number;
}

/* ==========================================================================
   Workflow Studio view
   ========================================================================== */

export default function WorkflowStudioView() {
  const [nodes, setNodes, onNodesChange] = useNodesState<WfNodeData>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [termOpen, setTermOpen] = useState(true);
  const [stats, setStats] = useState<LocalStats | null>(null);
  const [statsError, setStatsError] = useState(false);
  const idRef = useRef(100);
  const logs = useWfStore((s) => s.logs);
  const clearLogs = useWfStore((s) => s.clearLogs);

  // Mount: honest boot log + real local counts for the stats pill.
  useEffect(() => {
    log("STUDIO", "Workflow Studio initialized — local designer mode.", "ok");
    log("STUDIO", "No remote execution: designs are stored in this browser only.", "info");
    Promise.all([listContacts(), listDeals(), listFunnels(), getMemoryHealth()])
      .then(([contacts, deals, funnels, mem]) => {
        setStats({
          contacts: contacts.length,
          deals: deals.length,
          funnels: funnels.length,
          memories: mem.stored_observations,
        });
      })
      .catch(() => setStatsError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const ch of changes) {
        if (ch.type === "remove") log("CANVAS", `node removed (id ${ch.id})`, "warn");
      }
      onNodesChange(changes);
    },
    [onNodesChange]
  );

  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((eds) => {
        const srcType = nodes.find((n) => n.id === params.source)?.type ?? "agent";
        const color = EDGE_COLORS[srcType] ?? "#FF4500";
        return addEdge({ ...params, animated: true, style: { stroke: color, strokeWidth: 2 } }, eds);
      });
      log("CANVAS", `edge connected: ${params.source} → ${params.target}`, "ok");
    },
    [nodes, setEdges]
  );

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  const updateSelected = useCallback(
    (patch: Partial<WfNodeData>) => {
      if (!selectedId) return;
      setNodes((nds) =>
        nds.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, ...patch } } : n))
      );
    },
    [selectedId, setNodes]
  );

  const addNode = useCallback(
    (type: string, label: string) => {
      const id = `n${idRef.current++}`;
      const idx = nodes.length;
      const defaults: Record<string, WfNodeData> = {
        trigger: { label, sourceType: "Manual" },
        agent: { label, model: "local-model", temperature: 0.2 },
        tool: { label, runtime: "Local process" },
        state: { label },
        logic: { label, threshold: "0.85" },
      };
      const node: WfNode = {
        id,
        type,
        position: { x: 120 + (idx % 6) * 60, y: 120 + (idx % 6) * 60 },
        data: defaults[type] ?? { label },
      };
      setNodes((nds) => [...nds, node]);
      log("CANVAS", `node added: ${type} "${label}" (id ${id})`, "ok");
    },
    [nodes.length, setNodes]
  );

  const removeSelected = useCallback(() => {
    if (!selectedId) return;
    setNodes((nds) => nds.filter((n) => n.id !== selectedId));
    setEdges((eds) => eds.filter((e) => e.source !== selectedId && e.target !== selectedId));
    log("CANVAS", `node removed (id ${selectedId})`, "warn");
    setSelectedId(null);
  }, [selectedId, setNodes, setEdges]);

  const validate = useCallback(() => {
    const problems: { text: string; level: LogLevel }[] = [];
    const touched = new Set<string>();
    edges.forEach((e) => {
      touched.add(e.source);
      touched.add(e.target);
    });
    const triggers = nodes.filter((n) => n.type === "trigger");
    if (triggers.length === 0) {
      problems.push({ text: "no Trigger node — add one to start the flow", level: "error" });
    }
    for (const n of nodes) {
      if (!touched.has(n.id)) {
        problems.push({ text: `isolated node: "${n.data.label}" (${n.type}) has no edges`, level: "warn" });
      }
    }
    for (const t of triggers) {
      if (!edges.some((e) => e.source === t.id)) {
        problems.push({ text: `trigger "${t.data.label}" has no outgoing edge`, level: "warn" });
      }
    }
    for (const n of nodes) {
      if (n.type !== "trigger" && !edges.some((e) => e.target === n.id)) {
        problems.push({ text: `"${n.data.label}" (${n.type}) has no incoming edge`, level: "warn" });
      }
    }
    signal("validator", "PENDING", `checking ${nodes.length} nodes, ${edges.length} edges`);
    log("VALIDATE", `checking ${nodes.length} nodes, ${edges.length} edges…`, "info");
    metric("workflow.nodes", nodes.length, "nodes");
    metric("workflow.edges", edges.length, "edges");
    if (problems.length === 0) {
      log("VALIDATE", "workflow looks good — every node is connected.", "ok");
      signal("validator", "SUCCESS", "no problems found");
    } else {
      problems.forEach((p) => log("VALIDATE", p.text, p.level));
      const hasError = problems.some((p) => p.level === "error");
      signal("validator", hasError ? "ERROR" : "SUCCESS", `${problems.length} issue(s) found`);
    }
  }, [nodes, edges]);

  const save = useCallback(() => {
    signal("persistence", "PENDING", "writing to browser local storage");
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes, edges }));
      log("STUDIO", `workflow saved locally (${nodes.length} nodes, ${edges.length} edges).`, "ok");
      signal("persistence", "SUCCESS", `${nodes.length} nodes, ${edges.length} edges saved`);
    } catch {
      log("STUDIO", "save failed: browser storage unavailable.", "error");
      signal("persistence", "ERROR", "browser storage unavailable");
    }
  }, [nodes, edges]);

  const load = useCallback(() => {
    signal("persistence", "PENDING", "reading from browser local storage");
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        log("STUDIO", "nothing saved yet — use Save first.", "warn");
        signal("persistence", "ERROR", "no saved workflow found");
        return;
      }
      const parsed = JSON.parse(raw) as { nodes: WfNode[]; edges: Edge[] };
      setNodes(parsed.nodes ?? []);
      setEdges(parsed.edges ?? []);
      setSelectedId(null);
      log("STUDIO", `workflow loaded (${parsed.nodes?.length ?? 0} nodes, ${parsed.edges?.length ?? 0} edges).`, "ok");
      signal("persistence", "SUCCESS", "workflow restored from local storage");
    } catch {
      log("STUDIO", "load failed: saved data is corrupted.", "error");
      signal("persistence", "ERROR", "saved data is corrupted");
    }
  }, [setNodes, setEdges]);

  const clear = useCallback(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
    setSelectedId(null);
    log("STUDIO", "canvas reset to the default workflow.", "warn");
  }, [setNodes, setEdges]);

  const nodeColor = useCallback((n: { type?: string }) => EDGE_COLORS[n.type ?? ""] ?? "#00f3ff", []);

  return (
    <div className="wf-wrap">
      {/* Studio header: real local counts, no fake swarm stats */}
      <div className="wf-topbar">
        <div className="wf-brand">
          <span className="wf-brand-mark">🦀</span>
          <span className="wf-brand-name">WORKFLOW STUDIO</span>
          <span className="wf-badge">LOCAL DESIGNER</span>
        </div>
        <div className="wf-stats" title="Live counts from the local backend via the gateway">
          <span className="wf-stats-dot" />
          <span className="wf-stats-label">LOCAL DATA</span>
          {stats && !statsError && (
            <span className="wf-stats-values">
              {stats.contacts} contacts · {stats.deals} deals · {stats.funnels} funnels · {stats.memories} memories
            </span>
          )}
          {statsError && <span className="wf-stats-values wf-dim">backend unreachable</span>}
          {!stats && !statsError && <span className="wf-stats-values wf-dim">loading…</span>}
        </div>
        <div className="wf-actions">
          <button className="wf-btn" onClick={validate} title="Check the workflow for problems">
            <CheckCircle2 size={14} /> Validate
          </button>
          <button className="wf-btn" onClick={save} title="Save to this browser">
            <Save size={14} /> Save
          </button>
          <button className="wf-btn" onClick={load} title="Load from this browser">
            <FolderOpen size={14} /> Load
          </button>
          <button className="wf-btn wf-btn-danger" onClick={clear} title="Reset canvas">
            <Trash2 size={14} /> Clear
          </button>
        </div>
      </div>
      <p className="wf-note">
        Designs only — this canvas never executes anything remotely. Save/Load use this browser's local storage.
      </p>

      <div className="wf-body">
        {/* Node palette */}
        <aside className="wf-palette">
          <div className="wf-palette-head">
            <span>Node Palette</span>
            <Layers size={14} className="wf-cyan" />
          </div>
          <div className="wf-palette-list">
            {PALETTE.map(({ type, label, desc, Icon, cls }) => (
              <button
                key={type}
                className={`wf-pal-btn wf-pal-${cls}`}
                onClick={() => addNode(type, `${label} ${idRef.current}`)}
              >
                <Icon size={16} />
                <span>
                  <span className="wf-pal-label">{label}</span>
                  <span className="wf-pal-desc">{desc}</span>
                </span>
              </button>
            ))}
          </div>

          {/* Selected-node config */}
          <div className="wf-config">
            <div className="wf-palette-head"><span>Inspector</span></div>
            {selected ? (
              <div className="wf-config-form">
                <div className="wf-config-row">
                  <span className="wf-config-type">{selected.type}</span>
                  <button className="wf-mini-btn" onClick={removeSelected} title="Delete node">
                    <X size={12} /> delete
                  </button>
                </div>
                <label>
                  Label
                  <input
                    value={String(selected.data.label ?? "")}
                    onChange={(e) => updateSelected({ label: e.target.value })}
                  />
                </label>
                {selected.type === "agent" && (
                  <>
                    <label>
                      Model
                      <input
                        value={String(selected.data.model ?? "")}
                        onChange={(e) => updateSelected({ model: e.target.value })}
                      />
                    </label>
                    <label>
                      Temperature
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        max="2"
                        value={String(selected.data.temperature ?? 0.2)}
                        onChange={(e) => updateSelected({ temperature: Number(e.target.value) })}
                      />
                    </label>
                    <p className="wf-config-hint">Local workflow metadata — designs only, no remote dispatch.</p>
                  </>
                )}
                {selected.type === "trigger" && (
                  <label>
                    Source type
                    <input
                      value={String(selected.data.sourceType ?? "")}
                      onChange={(e) => updateSelected({ sourceType: e.target.value })}
                    />
                  </label>
                )}
                {selected.type === "tool" && (
                  <label>
                    Runtime
                    <input
                      value={String(selected.data.runtime ?? "")}
                      onChange={(e) => updateSelected({ runtime: e.target.value })}
                    />
                  </label>
                )}
                {selected.type === "logic" && (
                  <label>
                    Threshold
                    <input
                      value={String(selected.data.threshold ?? "")}
                      onChange={(e) => updateSelected({ threshold: e.target.value })}
                    />
                  </label>
                )}
              </div>
            ) : (
              <p className="wf-dim">Click a node on the canvas to edit it.</p>
            )}
          </div>
        </aside>

        {/* Canvas */}
        <main className="wf-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectionChange={(sel) => setSelectedId(sel.nodes[0]?.id ?? null)}
            nodeTypes={nodeTypes}
            fitView
          >
            <Background color="#2a2f3e" gap={24} size={1} />
            <Controls />
            <MiniMap nodeColor={nodeColor} maskColor="rgba(10, 11, 16, 0.7)" />
          </ReactFlow>

          {/* Terminal drawer: real local events only */}
          <div className={`wf-term ${termOpen ? "" : "wf-term-closed"}`}>
            <div className="wf-term-head" onClick={() => setTermOpen((o) => !o)}>
              <span className="wf-term-title">
                <Activity size={14} className="wf-pulse-icon" /> Workflow events · this machine
              </span>
              <span className="wf-term-tools">
                <button
                  className="wf-mini-btn"
                  onClick={(e) => { e.stopPropagation(); clearLogs(); }}
                  title="Clear terminal"
                >
                  clear
                </button>
                {termOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              </span>
            </div>
            {termOpen && (
              <div className="wf-term-body">
                {logs.map((l, i) => (
                  <div key={i} className={`wf-log wf-log-${l.type === "AGENT_LOG" ? l.level : l.type === "AGENT_SIGNAL" ? (l.status === "ERROR" ? "error" : l.status === "SUCCESS" ? "ok" : "info") : "info"}`}>
                    <span className="wf-log-ts">[{new Date(l.ts).toLocaleTimeString()}]</span>
                    {l.type === "AGENT_LOG" && (
                      <>
                        <span className="wf-log-tag">[{l.tag}]</span>
                        <span className="wf-log-text">{l.text}</span>
                      </>
                    )}
                    {l.type === "AGENT_SIGNAL" && (
                      <>
                        <span className="wf-log-tag">[SIGNAL]</span>
                        <span className="wf-log-text">
                          {l.agentId} → {l.status}{l.detail ? ` — ${l.detail}` : ""}
                        </span>
                      </>
                    )}
                    {l.type === "ANALYTICS_METRIC" && (
                      <>
                        <span className="wf-log-tag">[METRIC]</span>
                        <span className="wf-log-text">
                          {l.name} = {l.value}{l.unit ? ` ${l.unit}` : ""}
                        </span>
                      </>
                    )}
                  </div>
                ))}
                {logs.length === 0 && <div className="wf-dim">No events yet.</div>}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
