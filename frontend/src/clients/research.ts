// Typed client for the Crabdeck deep-research pipeline.
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

export interface ResearchSource {
  type: "url" | "file";
  ref: string;
}

export interface SurveyCategory {
  name: string;
  summary: string;
  sources: string[];
  doc_count: number;
  top_terms: string[];
  term_momentum: number;
  momentum_note: string;
}

export interface GraphNode {
  id: number;
  label: string;
  size: number;
}

export interface GraphEdge {
  from: number;
  to: number;
  similarity: number;
}

export interface ResearchRunResponse {
  topic: string;
  extractor: "llm" | "heuristic";
  model: string | null;
  backend: string | null;
  documents: { source: string; chars: number; perspectives: string[] }[];
  survey: {
    topic: string;
    categories: SurveyCategory[];
    graph: { nodes: GraphNode[]; edges: GraphEdge[] };
    extractor: "llm" | "heuristic" | null;
    note: string;
  };
}

export interface TrendsResponse {
  topic: string;
  bucket_by: string;
  buckets: { bucket: string; clusters: Record<string, number> }[];
}

export interface RetrieveResult {
  id: string;
  source: string | null;
  perspective: string | null;
  topic: string | null;
  text: string;
  score: number;
}

export const runResearch = (topic: string, sources: ResearchSource[], perspectives?: string[]) =>
  post<ResearchRunResponse>("/api/research/run", { topic, sources, perspectives });

export const getTrends = (topic: string) =>
  get<TrendsResponse>(`/api/research/trends?topic=${encodeURIComponent(topic)}`);

export const getGraph = (topic: string) =>
  get<{ topic: string; nodes: GraphNode[]; edges: GraphEdge[] }>(
    `/api/research/graph?topic=${encodeURIComponent(topic)}`
  );

export const retrieveProjections = (query: string, n_results = 5, topic?: string) =>
  post<{ query: string; results: RetrieveResult[] }>("/api/research/retrieve", {
    query,
    n_results,
    topic,
  });
