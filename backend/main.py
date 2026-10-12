from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import agent, anomaly, crm, funnels, ml, quantum, rag, research, shell_cracked

app = FastAPI(title="Crabdeck Omni-Layer Backend", version="0.2.0")

# Single-machine service: only loopback origins are allowed through CORS.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:8000",
        "http://127.0.0.1",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(crm.router)
app.include_router(funnels.router)
app.include_router(ml.router)
app.include_router(quantum.router)
app.include_router(shell_cracked.router)
app.include_router(rag.router)
app.include_router(anomaly.router)
app.include_router(agent.router)
app.include_router(research.router)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "crabdeck-omnilayer-backend",
        "version": "0.2.0",
    }
