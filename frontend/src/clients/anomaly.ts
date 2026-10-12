// Standalone typed client for funnel anomaly detection.
// Same request/error style as ../api. Single-machine only: every request
// goes to the local gateway, which proxies /api/anomaly/* to the FastAPI backend.
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

/* ---------- Anomaly detection ---------- */

export interface AnomalyDailyPoint {
  date: string;
  stage: string;
  conversion: number;
}

export interface DetectedAnomaly {
  date: string;
  stage: string;
  observed: number;
  expected: number;
  z_score: number;
  severity: string; // "critical" | "warning"
  method: string; // "zscore" | "cusum"
}

export interface AnomalyResponse {
  funnel_id: string;
  name: string;
  window_days: number;
  z_threshold: number;
  daily_series: AnomalyDailyPoint[];
  anomalies: DetectedAnomaly[];
}

export const getAnomalies = (
  funnelId: string,
  windowDays = 7,
  zThreshold = 3.0
): Promise<AnomalyResponse> =>
  get<AnomalyResponse>(
    `/api/anomaly/${encodeURIComponent(funnelId)}?window_days=${windowDays}&z_threshold=${zThreshold}`
  );
