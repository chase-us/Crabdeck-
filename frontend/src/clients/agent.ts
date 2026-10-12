// Typed client for the Crabdeck local agent loop.
// Single-machine only: every request goes to the local gateway.
const API_BASE = "http://127.0.0.1:3001";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch (err) {
    throw new Error(
      `Could not reach the gateway at ${API_BASE}${path}. Is it running? (${err instanceof Error ? err.message : String(err)})`
    );
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = (body && (body.detail || body.message || body.error)) || JSON.stringify(body);
    } catch {
      try {
        detail = await res.text();
      } catch {
        detail = "";
      }
    }
    throw new Error(
      `Request failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""} (${init?.method ?? "GET"} ${path})`
    );
  }
  return (await res.json()) as T;
}

const get = <T,>(path: string): Promise<T> => request<T>(path);
const post = <T,>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });

export interface AgentToolDef {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface AgentStep {
  thought: string;
  tool: string | null;
  args: Record<string, unknown> | null;
  observation: string;
}

export interface AgentRunResponse {
  goal: string;
  steps: AgentStep[];
  final_answer: string;
  model: string | null;
  backend: string | null;
  steps_taken: number;
}

export const listAgentTools = () => get<AgentToolDef[]>("/api/agent/tools");

export const runAgent = (goal: string, max_steps = 8) =>
  post<AgentRunResponse>("/api/agent/run", { goal, max_steps });
