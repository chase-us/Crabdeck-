"""Local ReAct agent loop — single-machine tool use only.

POST /agent/run takes a natural-language goal and runs a ReAct loop:
plan with the pluggable LLM (backend/llm.py: Ollama at 127.0.0.1:11434 or an
OpenAI-compatible endpoint), parse a strict-JSON tool call, execute it
LOCALLY against the tool registry below, append the observation, repeat
until the model returns a final answer or max_steps / the 120 s cap is hit.

The registry contains EXISTING local capabilities only — CRM, funnels, ML,
memory vault, RAG. Nothing outside this machine is ever executed. If no LLM
backend is configured, the run endpoint returns HTTP 503 with setup
instructions (never a fake transcript).
"""

import json
import logging
import re
import time
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import llm
from llm import LLMUnavailable
from routers import crm, funnels, ml, shell_cracked
from routers.rag import QueryIn as RagQueryIn
from routers.rag import query_documents as rag_query_documents

router = APIRouter(prefix="/agent", tags=["agent"])
logger = logging.getLogger("crabdeck.agent")

MAX_RUN_SECONDS = 120
MAX_STEPS_HARD_CAP = 20
OBSERVATION_TRUNCATE = 2000


def _summarize(value: Any, limit: int = OBSERVATION_TRUNCATE) -> str:
    try:
        text = json.dumps(value, default=str)
    except Exception:
        text = str(value)
    if len(text) > limit:
        return text[:limit] + f"... [truncated, {len(text)} chars total]"
    return text


# ---------------------------------------------------------------------------
# Tool registry — local capabilities only
# ---------------------------------------------------------------------------


def _t_crm_list_contacts(args: Dict[str, Any]) -> Any:
    return crm.list_contacts()


def _t_crm_create_contact(args: Dict[str, Any]) -> Any:
    return crm.create_contact(crm.ContactIn(
        name=str(args["name"]),
        email=str(args["email"]),
        company=args.get("company"),
        notes=args.get("notes"),
    ))


def _t_crm_list_deals(args: Dict[str, Any]) -> Any:
    return crm.list_deals()


def _t_crm_create_deal(args: Dict[str, Any]) -> Any:
    return crm.create_deal(crm.DealIn(
        title=str(args["title"]),
        value=float(args["value"]),
        stage=str(args["stage"]),
    ))


def _t_funnels_list(args: Dict[str, Any]) -> Any:
    return funnels.list_funnels()


def _t_funnels_record_event(args: Dict[str, Any]) -> Any:
    return funnels.record_event(
        str(args["funnel_id"]),
        funnels.EventIn(visitor_id=str(args["visitor_id"]), stage=str(args["stage"])),
    )


def _t_funnels_stats(args: Dict[str, Any]) -> Any:
    return funnels.funnel_stats(str(args["funnel_id"]))


def _t_ml_kmeans(args: Dict[str, Any]) -> Any:
    return ml.kmeans(ml.KMeansIn(points=args["points"], k=int(args["k"])))


def _t_ml_regression(args: Dict[str, Any]) -> Any:
    return ml.regression(ml.RegressionIn(x=args["x"], y=args["y"]))


def _t_memory_store(args: Dict[str, Any]) -> Any:
    return shell_cracked.store_observation(shell_cracked.StoreIn(
        agent_id=str(args.get("agent_id", "agent-loop")),
        observation=str(args["observation"]),
        metadata=args.get("metadata") or {},
    ))


def _t_memory_recall(args: Dict[str, Any]) -> Any:
    return shell_cracked.recall_observations(
        query=str(args["query"]), n_results=int(args.get("n_results", 3))
    )


def _t_rag_query(args: Dict[str, Any]) -> Any:
    return rag_query_documents(RagQueryIn(
        query=str(args["query"]), n_results=int(args.get("n_results", 5))
    ))


_TOOL_DEFS: List[Dict[str, Any]] = [
    {
        "name": "crm_list_contacts",
        "description": "List all CRM contacts.",
        "schema": {"type": "object", "properties": {}, "additionalProperties": False},
        "fn": _t_crm_list_contacts,
    },
    {
        "name": "crm_create_contact",
        "description": "Create a CRM contact.",
        "schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "email": {"type": "string"},
                "company": {"type": "string"},
                "notes": {"type": "string"},
            },
            "required": ["name", "email"],
            "additionalProperties": False,
        },
        "fn": _t_crm_create_contact,
    },
    {
        "name": "crm_list_deals",
        "description": "List all CRM deals.",
        "schema": {"type": "object", "properties": {}, "additionalProperties": False},
        "fn": _t_crm_list_deals,
    },
    {
        "name": "crm_create_deal",
        "description": "Create a CRM deal. Stage must be one of: lead, qualified, proposal, won, lost.",
        "schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "value": {"type": "number"},
                "stage": {"type": "string"},
            },
            "required": ["title", "value", "stage"],
            "additionalProperties": False,
        },
        "fn": _t_crm_create_deal,
    },
    {
        "name": "funnels_list",
        "description": "List all funnels (id, name, stages).",
        "schema": {"type": "object", "properties": {}, "additionalProperties": False},
        "fn": _t_funnels_list,
    },
    {
        "name": "funnels_record_event",
        "description": "Record a visitor event on a funnel stage.",
        "schema": {
            "type": "object",
            "properties": {
                "funnel_id": {"type": "string"},
                "visitor_id": {"type": "string"},
                "stage": {"type": "string"},
            },
            "required": ["funnel_id", "visitor_id", "stage"],
            "additionalProperties": False,
        },
        "fn": _t_funnels_record_event,
    },
    {
        "name": "funnels_stats",
        "description": "Per-stage unique-visitor counts and conversion rates for a funnel.",
        "schema": {
            "type": "object",
            "properties": {"funnel_id": {"type": "string"}},
            "required": ["funnel_id"],
            "additionalProperties": False,
        },
        "fn": _t_funnels_stats,
    },
    {
        "name": "ml_kmeans",
        "description": "K-means clustering over 2D points. Returns assignments and centroids.",
        "schema": {
            "type": "object",
            "properties": {
                "points": {"type": "array", "items": {"type": "array", "items": {"type": "number"}}},
                "k": {"type": "integer"},
            },
            "required": ["points", "k"],
            "additionalProperties": False,
        },
        "fn": _t_ml_kmeans,
    },
    {
        "name": "ml_regression",
        "description": "Ordinary least-squares linear regression over x/y series.",
        "schema": {
            "type": "object",
            "properties": {
                "x": {"type": "array", "items": {"type": "number"}},
                "y": {"type": "array", "items": {"type": "number"}},
            },
            "required": ["x", "y"],
            "additionalProperties": False,
        },
        "fn": _t_ml_regression,
    },
    {
        "name": "memory_store",
        "description": "Store an observation in the local Shell Cracked memory vault.",
        "schema": {
            "type": "object",
            "properties": {
                "agent_id": {"type": "string"},
                "observation": {"type": "string"},
                "metadata": {"type": "object"},
            },
            "required": ["observation"],
            "additionalProperties": False,
        },
        "fn": _t_memory_store,
    },
    {
        "name": "memory_recall",
        "description": "Semantic recall from the local memory vault.",
        "schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "n_results": {"type": "integer"},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
        "fn": _t_memory_recall,
    },
    {
        "name": "rag_query",
        "description": "Extractive semantic search over the indexed project documents. No generative model; returns cited chunks.",
        "schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "n_results": {"type": "integer"},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
        "fn": _t_rag_query,
    },
]

_TOOLS: Dict[str, Dict[str, Any]] = {t["name"]: t for t in _TOOL_DEFS}


def _tool_catalog_text() -> str:
    lines = []
    for t in _TOOL_DEFS:
        lines.append(f"- {t['name']}: {t['description']} args={json.dumps(t['schema'])}")
    return "\n".join(lines)


_SYSTEM_PROMPT = (
    "You are a ReAct agent running on a single local machine. You achieve the user's goal "
    "by calling the registered local tools below — you have no other capabilities.\n\n"
    "TOOLS:\n{tools}\n\n"
    "PROTOCOL: on every turn respond with EXACTLY ONE JSON object, no markdown fences, "
    "no extra text. Either a tool call:\n"
    '{"thought": "<your reasoning>", "tool": "<tool name>", "args": {{{<arg values>}}}}\n'
    "or, when the goal is achieved (or unachievable), a final answer:\n"
    '{"thought": "<your reasoning>", "final_answer": "<answer for the user>"}\n'
    "Rules: call at most one tool per turn; only use tools from the list with args "
    "matching their schemas; never invent tool names; keep thoughts concise; when data "
    "is missing, say so instead of fabricating it."
)


def _extract_json(text: str) -> Optional[dict]:
    """Pull the first {...} JSON object out of model output."""
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        parsed = json.loads(text[start:end + 1])
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


class RunIn(BaseModel):
    goal: str = Field(min_length=1)
    max_steps: int = Field(default=8, ge=1, le=MAX_STEPS_HARD_CAP)


@router.get("/tools")
def list_tools():
    """List the registered local tools (name, description, JSON schema)."""
    return [
        {"name": t["name"], "description": t["description"], "schema": t["schema"]}
        for t in _TOOL_DEFS
    ]


@router.post("/run")
def run_agent(payload: RunIn):
    """Run the ReAct loop for a goal. 503 when no LLM backend is configured."""
    system_prompt = _SYSTEM_PROMPT.replace("{tools}", _tool_catalog_text())
    transcript: List[str] = []
    steps: List[Dict[str, Any]] = []
    model = backend_name = None
    started = time.monotonic()

    for step_no in range(1, payload.max_steps + 1):
        if time.monotonic() - started > MAX_RUN_SECONDS:
            steps.append({
                "thought": f"Run exceeded the {MAX_RUN_SECONDS}s cap.",
                "tool": None, "args": None,
                "observation": "Stopped: time budget exhausted.",
            })
            break

        history = "\n".join(transcript[-12:])  # keep recent context only
        prompt = (
            f"GOAL: {payload.goal}\n\n"
            + (f"TRANSCRIPT SO FAR:\n{history}\n\n" if history else "")
            + "Respond with exactly one JSON object (tool call or final_answer)."
        )
        try:
            result = llm.complete(prompt, system_prompt=system_prompt, timeout_s=60)
        except LLMUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc))
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"LLM call failed: {exc}")
        model = result.get("model")
        backend_name = result.get("backend")

        parsed = _extract_json(result.get("text", ""))
        if parsed is None:
            observation = (
                "Your reply was not a single JSON object. Retry with exactly one "
                "JSON object: {\"thought\": ..., \"tool\": ..., \"args\": {...}} "
                "or {\"thought\": ..., \"final_answer\": ...}."
            )
            steps.append({"thought": "(unparseable model output)", "tool": None,
                          "args": None, "observation": observation})
            transcript.append(f"step {step_no}: model output unparseable; asked to retry as strict JSON.")
            logger.warning("agent: unparseable model output on step %d", step_no)
            continue

        thought = str(parsed.get("thought", ""))[:1000]

        if "final_answer" in parsed and parsed["final_answer"]:
            final_answer = str(parsed["final_answer"])
            steps.append({"thought": thought, "tool": None, "args": None,
                          "observation": "Goal concluded by the model."})
            transcript.append(f"step {step_no}: final answer given.")
            return {
                "goal": payload.goal,
                "steps": steps,
                "final_answer": final_answer,
                "model": model,
                "backend": backend_name,
                "steps_taken": step_no,
            }

        tool_name = parsed.get("tool")
        args = parsed.get("args") or {}
        if not isinstance(tool_name, str) or tool_name not in _TOOLS:
            observation = (
                f"Unknown tool {tool_name!r}. Available tools: "
                + ", ".join(sorted(_TOOLS))
            )
            steps.append({"thought": thought, "tool": tool_name if isinstance(tool_name, str) else None,
                          "args": None, "observation": observation})
            transcript.append(f"step {step_no}: unknown tool {tool_name!r}; listed available tools.")
            continue
        if not isinstance(args, dict):
            args = {}

        entry: Callable[[Dict[str, Any]], Any] = _TOOLS[tool_name]["fn"]
        try:
            value = entry(args)
            observation = _summarize(value)
        except HTTPException as exc:
            observation = f"Tool {tool_name} returned HTTP {exc.status_code}: {exc.detail}"
        except Exception as exc:  # noqa: BLE001 — tool errors become observations
            observation = f"Tool {tool_name} raised {type(exc).__name__}: {exc}"
        logger.info("agent: step %d called %s -> %s", step_no, tool_name, observation[:200])
        steps.append({"thought": thought, "tool": tool_name, "args": args,
                      "observation": observation})
        transcript.append(
            f"step {step_no}: called {tool_name}({json.dumps(args, default=str)[:300]}) -> {observation[:500]}"
        )

    # max_steps exhausted without a final answer
    last_obs = steps[-1]["observation"] if steps else "no steps executed"
    return {
        "goal": payload.goal,
        "steps": steps,
        "final_answer": (
            f"Stopped after {len(steps)} step(s) without a final answer from the model. "
            f"Last observation: {last_obs[:500]}"
        ),
        "model": model,
        "backend": backend_name,
        "steps_taken": len(steps),
    }
