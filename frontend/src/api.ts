// Typed client for the Crabdeck Omni-Layer gateway.
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
      detail =
        (body && (body.detail || body.message || body.error)) ||
        JSON.stringify(body);
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
const put = <T,>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: "PUT", body: JSON.stringify(body) });

/* ---------- Health ---------- */

export interface HealthResponse {
  gateway: string; // "ok" when healthy
  backend: string; // "ok" when healthy
  version?: string;
  [key: string]: unknown;
}

export const getHealth = () => get<HealthResponse>("/api/health");

/* ---------- CRM ---------- */

export interface Contact {
  id: number;
  name: string;
  email: string;
  company?: string | null;
  notes?: string | null;
}

export interface NewContact {
  name: string;
  email: string;
  company?: string;
  notes?: string;
}

export interface Deal {
  id: number;
  title: string;
  value: number;
  stage: string;
  contact_id?: number | null;
}

export interface NewDeal {
  title: string;
  value: number;
  stage: string;
}

export interface PipelineStageTotal {
  stage: string;
  count: number;
  total_value: number;
}

export interface PipelineResponse {
  stages: PipelineStageTotal[];
}

export const listContacts = () => get<Contact[]>("/crm/contacts");
export const createContact = (c: NewContact) => post<Contact>("/crm/contacts", c);
export const listDeals = () => get<Deal[]>("/crm/deals");
export const createDeal = (d: NewDeal) => post<Deal>("/crm/deals", d);
export const updateDealStage = (id: number, stage: string) =>
  put<Deal>(`/crm/deals/${id}`, { stage });
export const getPipeline = () => get<PipelineResponse>("/crm/pipeline");

/* ---------- Funnels ---------- */

export interface Funnel {
  id: number;
  name: string;
  stages: string[];
}

export interface NewFunnel {
  name: string;
  stages: string[];
}

export interface FunnelStat {
  stage: string;
  unique_visitors: number;
  conversion_from_previous: number | null;
  conversion_from_first: number;
}

export interface FunnelStatsResponse {
  funnel_id: number;
  stats: FunnelStat[];
}

export const listFunnels = () => get<Funnel[]>("/funnels");
export const createFunnel = (f: NewFunnel) => post<Funnel>("/funnels", f);
export const recordEvent = (funnelId: number, event: { visitor_id: string; stage: string }) =>
  post<{ ok: boolean }>(`/funnels/${funnelId}/events`, event);
export const getFunnelStats = (funnelId: number) =>
  get<FunnelStatsResponse>(`/funnels/${funnelId}/stats`);

/* ---------- ML ---------- */

export interface KmeansResponse {
  assignments: number[];
  centroids: [number, number][];
  k: number;
  iterations?: number;
}

export interface RegressionResponse {
  slope: number;
  intercept: number;
  r_squared: number;
  n: number;
}

export const kmeans = (points: [number, number][], k: number) =>
  post<KmeansResponse>("/ml/kmeans", { points, k });
export const regression = (x: number[], y: number[]) =>
  post<RegressionResponse>("/ml/regression", { x, y });

/* ---------- Quantum (classical simulation only) ---------- */

export interface QuantumInfo {
  note: string;
  [key: string]: unknown;
}

export interface AnnealResponse {
  objective: string;
  best_value: number;
  best_solution: number[];
  iterations?: number;
}

export interface GroverResponse {
  target: string;
  search_space: number;
  optimal_iterations: number;
  success_probability: number;
}

export const quantumInfo = () => get<QuantumInfo>("/quantum/info");
export const quantumAnneal = (req: { objective: "rastrigin" | "sphere"; dims: number; iterations: number }) =>
  post<AnnealResponse>("/quantum/anneal", req);
export const quantumGrover = (req: { n_qubits: number; target: string }) =>
  post<GroverResponse>("/quantum/grover", req);

/* ---------- Memory vault (Shell Cracked, local) ---------- */

export interface MemoryHealth {
  status: string;
  stored_observations: number;
  redis: string;
  [key: string]: unknown;
}

export const getMemoryHealth = () => get<MemoryHealth>("/memory/health");
