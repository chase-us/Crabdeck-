// Typed client for the Crabdeck Omni-Layer RAG-over-docs service.
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

/* ---------- RAG over docs (local, extractive) ---------- */

export type RagFileStatus = "indexed" | "skipped_unchanged" | "skipped";

export interface RagFileResult {
  path: string;
  chunks: number;
  status: RagFileStatus;
}

export interface RagIngestResponse {
  files_indexed: number;
  chunks_added: number;
  files_skipped: number;
  files: RagFileResult[];
}

export interface RagChunk {
  file: string;
  chunk_index: number;
  text: string;
  score: number;
}

export interface RagCitation {
  file: string;
  chunk_index: number;
  sentence: string;
}

export interface RagQueryResponse {
  query: string;
  answer: string;
  citations: RagCitation[];
  chunks: RagChunk[];
  answer_type: string;
  note: string;
}

export interface RagHealth {
  status: string;
  service: string;
  indexed_files: number;
  total_chunks: number;
}

export const getRagHealth = () => get<RagHealth>("/api/rag/health");

export const ingestDocs = (paths?: string[]) =>
  post<RagIngestResponse>("/api/rag/ingest", { paths });

export const queryDocs = (query: string, n_results = 5) =>
  post<RagQueryResponse>("/api/rag/query", { query, n_results });
