/**
 * Crabdeck Omni-Layer v0.2.0 — API Gateway
 *
 * Single-machine gateway. Binds to 127.0.0.1 ONLY.
 * Reverse-proxies /api/crm, /api/funnels, /api/ml, /api/quantum,
 * /api/memory, /api/rag, /api/anomaly, /api/agent, /api/research to the
 * FastAPI backend at http://127.0.0.1:8000 (stripping the /api prefix),
 * aggregates health at GET /api/health, and serves the frontend SPA
 * statically from ../frontend/dist when it exists.
 */

import express, { Request, Response } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import path from "path";
import fs from "fs";

const HOST = "127.0.0.1";
const PORT = 3001;
const BACKEND = "http://127.0.0.1:8000";
const HEALTH_TIMEOUT_MS = 5000;
const GATEWAY_VERSION = "0.2.0";
const GATEWAY_SERVICE = "crabdeck-omnilayer-gateway";

const app = express();

// ---------------------------------------------------------------------------
// GET /api/health — gateway health + backend health with graceful degradation
// ---------------------------------------------------------------------------
app.get("/api/health", async (_req: Request, res: Response) => {
  let backend: unknown;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    let resp: globalThis.Response;
    try {
      resp = await fetch(`${BACKEND}/health`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const text = await resp.text();
    try {
      backend = JSON.parse(text);
    } catch {
      backend = { status: "unreachable", detail: `non-JSON response from backend: ${text.slice(0, 200)}` };
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    backend = { status: "unreachable", detail: reason };
  }

  res.status(200).json({
    status: "ok",
    gateway: { status: "ok", service: GATEWAY_SERVICE, version: GATEWAY_VERSION },
    backend,
  });
});

// ---------------------------------------------------------------------------
// Reverse proxies to the FastAPI backend.
// Mounted BEFORE any body parsing so request bodies stream through untouched.
// Strips the /api prefix: /api/ml/kmeans -> http://127.0.0.1:8000/ml/kmeans
// NOTE: Express strips the mount prefix from req.url before the proxy sees
// it, so the rewrite prepends the backend path segment (e.g. /ml) to the
// remainder (e.g. /kmeans).
// ---------------------------------------------------------------------------
for (const prefix of ["/api/crm", "/api/funnels", "/api/ml", "/api/quantum", "/api/memory", "/api/rag", "/api/anomaly", "/api/agent", "/api/research"]) {
  const backendPrefix = prefix.replace("/api", ""); // e.g. /api/ml -> /ml
  app.use(
    prefix,
    createProxyMiddleware({
      target: BACKEND,
      changeOrigin: true,
      pathRewrite: { "^/": `${backendPrefix}/` },
      on: {
        error: (err, req, res) => {
          console.error(`[gateway] proxy error for ${prefix} ${req.method} ${req.url}: ${err.message}`);
          if ("headersSent" in res && !res.headersSent && "writeHead" in res) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "error", detail: `backend unreachable: ${err.message}` }));
          } else if ("destroy" in res) {
            res.destroy();
          }
        },
      },
    })
  );
}

// ---------------------------------------------------------------------------
// Static frontend (sibling frontend/dist). SPA fallback for non-API GETs.
// If the directory does not exist, warn at startup and continue — the API
// routes must work regardless.
// ---------------------------------------------------------------------------
const frontendDist = path.resolve(__dirname, "..", "..", "frontend", "dist");
if (fs.existsSync(frontendDist) && fs.existsSync(path.join(frontendDist, "index.html"))) {
  console.log(`[gateway] serving frontend from ${frontendDist}`);
  app.use(express.static(frontendDist));
  // SPA fallback: any non-/api GET that isn't a file serves index.html
  app.get("*", (_req: Request, res: Response) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
} else {
  console.warn(`[gateway] WARNING: frontend dist not found at ${frontendDist}; static serving disabled, API routes remain active`);
}

app.listen(PORT, HOST, () => {
  console.log(`[gateway] ${GATEWAY_SERVICE} v${GATEWAY_VERSION} listening on http://${HOST}:${PORT}`);
  console.log(`[gateway] proxying to backend ${BACKEND}`);
});
