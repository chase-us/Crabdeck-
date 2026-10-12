"""Pluggable LLM interface for Crabdeck Omni-Layer v0.2.0.

Single-machine, local-first. Two adapters, tried in order:

1. OpenAI-compatible HTTP endpoint — used when BOTH ``OPENAI_BASE_URL`` and
   ``OPENAI_API_KEY`` are set (explicit configuration wins). Model from
   ``OPENAI_MODEL`` (default ``"gpt-4o-mini"``). Any ``/chat/completions``
   compatible server works, including a local one on 127.0.0.1.
2. Ollama — ``OLLAMA_HOST`` (default ``http://127.0.0.1:11434``),
   ``/api/generate`` with ``stream: false``. Model from ``OLLAMA_MODEL``
   (default ``"llama3.1"``).

If neither is configured/reachable, :func:`complete` raises
:class:`LLMUnavailable`; routers surface that as HTTP 503 with setup
instructions. No API keys in code or files — environment variables only.
Standard library only (urllib); no new dependencies.
"""

import json
import logging
import os
import urllib.error
import urllib.request

logger = logging.getLogger("crabdeck.llm")

OLLAMA_DEFAULT_MODEL = "llama3.1"
OPENAI_DEFAULT_MODEL = "gpt-4o-mini"
PROBE_TIMEOUT_S = 5
GENERATE_TIMEOUT_S = 90

SETUP_INSTRUCTIONS = (
    "No language-model backend is configured or reachable. "
    "To enable LLM features, do ONE of the following on this machine:\n"
    "  1. Run Ollama locally (https://ollama.com), pull a model "
    "(e.g. `ollama pull llama3.1`), and ensure it listens at "
    "http://127.0.0.1:11434 (override with the OLLAMA_HOST env var, "
    "model with OLLAMA_MODEL).\n"
    "  2. Set the OPENAI_BASE_URL and OPENAI_API_KEY environment variables "
    "(and optionally OPENAI_MODEL) to point at any OpenAI-compatible "
    "chat-completions endpoint.\n"
    "Keys are read from environment variables only — never from files."
)


class LLMUnavailable(Exception):
    """Raised when no LLM backend can serve a completion."""


def _post_json(url: str, payload: dict, headers: dict | None = None,
               timeout: int = PROBE_TIMEOUT_S) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"HTTP {exc.code} from {url}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach {url}: {exc.reason}") from exc


def _get_json(url: str, headers: dict | None = None,
              timeout: int = PROBE_TIMEOUT_S) -> dict:
    req = urllib.request.Request(url, headers=headers or {}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"HTTP {exc.code} from {url}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach {url}: {exc.reason}") from exc


def _ollama_complete(prompt: str, system_prompt: str, timeout_s: int) -> dict:
    host = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
    model = os.environ.get("OLLAMA_MODEL", OLLAMA_DEFAULT_MODEL)
    full_prompt = prompt
    if system_prompt and system_prompt.strip():
        full_prompt = system_prompt.strip() + "\n\n" + prompt.strip()
    body = _post_json(
        f"{host}/api/generate",
        {"model": model, "prompt": full_prompt, "stream": False},
        timeout=timeout_s,
    )
    text = (body.get("response") or "").strip()
    if not text:
        raise RuntimeError(f"Ollama returned an empty response (model={model})")
    return {"text": text, "model": body.get("model", model), "backend": "ollama"}


def _openai_complete(prompt: str, system_prompt: str, timeout_s: int) -> dict:
    base = os.environ.get("OPENAI_BASE_URL", "").rstrip("/")
    key = os.environ.get("OPENAI_API_KEY", "")
    model = os.environ.get("OPENAI_MODEL", OPENAI_DEFAULT_MODEL)
    messages = []
    if system_prompt and system_prompt.strip():
        messages.append({"role": "system", "content": system_prompt.strip()})
    messages.append({"role": "user", "content": prompt})
    body = _post_json(
        f"{base}/chat/completions",
        {"model": model, "messages": messages, "temperature": 0.2},
        headers={"Authorization": f"Bearer {key}"},
        timeout=timeout_s,
    )
    try:
        text = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(
            f"Unexpected chat-completions response shape: {str(body)[:300]}"
        ) from exc
    text = (text or "").strip()
    if not text:
        raise RuntimeError("OpenAI-compatible endpoint returned empty content")
    return {"text": text, "model": model, "backend": "openai_compatible"}


def complete(prompt: str, system_prompt: str = "",
             timeout_s: int = GENERATE_TIMEOUT_S) -> dict:
    """Run one completion.

    Returns ``{"text", "model", "backend"}``. Raises :class:`LLMUnavailable`
    when no backend is configured or reachable.
    """
    errors: list[str] = []
    if os.environ.get("OPENAI_BASE_URL") and os.environ.get("OPENAI_API_KEY"):
        try:
            return _openai_complete(prompt, system_prompt, timeout_s)
        except Exception as exc:  # noqa: BLE001 — collected, then raised as 503
            errors.append(f"openai_compatible: {exc}")
            logger.warning("LLM openai_compatible backend failed: %s", exc)
    try:
        return _ollama_complete(prompt, system_prompt, timeout_s)
    except Exception as exc:  # noqa: BLE001 — collected, then raised as 503
        errors.append(f"ollama: {exc}")
        logger.warning("LLM ollama backend failed: %s", exc)
    detail = SETUP_INSTRUCTIONS
    if errors:
        detail += "\nAttempts: " + "; ".join(errors)
    raise LLMUnavailable(detail)


def status() -> dict:
    """Best-effort availability report. Never raises."""
    report: dict = {
        "openai_compatible_configured": bool(
            os.environ.get("OPENAI_BASE_URL") and os.environ.get("OPENAI_API_KEY")
        ),
        "openai_compatible_reachable": False,
        "ollama_reachable": False,
        "ollama_host": os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"),
        "ollama_model": os.environ.get("OLLAMA_MODEL", OLLAMA_DEFAULT_MODEL),
    }
    if report["openai_compatible_configured"]:
        try:
            base = os.environ.get("OPENAI_BASE_URL", "").rstrip("/")
            key = os.environ.get("OPENAI_API_KEY", "")
            _get_json(f"{base}/models", headers={"Authorization": f"Bearer {key}"})
            report["openai_compatible_reachable"] = True
        except Exception as exc:  # noqa: BLE001 — reachability is best-effort
            report["openai_compatible_error"] = str(exc)[:200]
    try:
        host = report["ollama_host"].rstrip("/")
        _get_json(f"{host}/api/tags")
        report["ollama_reachable"] = True
    except Exception as exc:  # noqa: BLE001 — reachability is best-effort
        report["ollama_error"] = str(exc)[:200]
    report["available"] = bool(
        report["openai_compatible_reachable"] or report["ollama_reachable"]
    )
    if not report["available"]:
        report["setup"] = SETUP_INSTRUCTIONS
    return report
