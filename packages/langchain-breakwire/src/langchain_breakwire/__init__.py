"""LangChain integration for Breakwire: tools the agent can call, and a callback handler that looks up
errors raised inside chains, LLM calls and tools.

    from langchain_breakwire import breakwire_tools, BreakwireCallbackHandler
    tools = breakwire_tools()   # lookup_error, deadlines, check_stack
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Type
from uuid import UUID

from breakwire import Breakwire, explain
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.tools import BaseTool
from pydantic import BaseModel, ConfigDict, Field

__version__ = "0.2.0"
__all__ = ["BreakwireLookupTool", "BreakwireDeadlinesTool", "BreakwireStackTool", "BreakwireCallbackHandler",
           "breakwire_tools", "__version__"]


def _compact(r: Dict[str, Any], max_matches: int = 3) -> Dict[str, Any]:
    cov = r.get("coverage") or {}
    return {
        "lookup_id": r.get("lookup_id"),
        "explained": r.get("explained"),
        "coverage_note": cov.get("note") if cov and not cov.get("covered", True) else None,
        "matches": [
            {"id": m.get("cid"), "title": m.get("title"), "confidence": m.get("confidence"), "fix": m.get("fix"),
             "deadline": m.get("deadline"), "url": m.get("url"), "source_url": m.get("source_url")}
            for m in (r.get("matches") or [])[:max_matches]
        ],
        "note": 'Community data: "signature" = vendor-documented error text matched; "related" = a lead only. Prefer source_url.',
        "remember": r.get("remember"),
    }


class _LookupInput(BaseModel):
    error: str = Field(description="The error message text. Secrets are stripped before sending.")
    service: Optional[str] = Field(default=None, description="Service slug, e.g. anthropic-api, openai-api, stripe, github-api, mcp")
    sdk: Optional[str] = Field(default=None)
    sdk_version: Optional[str] = Field(default=None)
    model: Optional[str] = Field(default=None)


class BreakwireLookupTool(BaseTool):
    """Look up an API/SDK/platform error in Breakwire and get the claim that explains it, with the fix."""

    model_config = ConfigDict(arbitrary_types_allowed=True)
    name: str = "breakwire_lookup_error"
    description: str = (
        "Look up an API/SDK/platform error message in Breakwire, a source-linked registry of breaking changes, "
        "deprecations and advisories. Returns the matching claim and its fix. Use when a call fails with an error you do not recognise."
    )
    args_schema: Type[BaseModel] = _LookupInput
    client: Breakwire = Field(default_factory=Breakwire)
    log_miss: bool = False
    max_matches: int = 3

    def _run(self, error: str, service: Optional[str] = None, sdk: Optional[str] = None,
             sdk_version: Optional[str] = None, model: Optional[str] = None, run_manager: Any = None) -> Dict[str, Any]:
        try:
            r = self.client.lookup(error, service=service, sdk=sdk, version=sdk_version, model=model, log_miss=self.log_miss)
            return _compact(r, self.max_matches)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Breakwire unavailable: {e}"}


class _DeadlinesInput(BaseModel):
    service: Optional[str] = Field(default=None, description="Service slug; omit for all services")


class BreakwireDeadlinesTool(BaseTool):
    """Upcoming act-by dates (model retirements, API shutdowns, required migrations), soonest first."""

    model_config = ConfigDict(arbitrary_types_allowed=True)
    name: str = "breakwire_deadlines"
    description: str = "Upcoming act-by dates (model retirements, API shutdowns, required migrations) for a service, soonest first."
    args_schema: Type[BaseModel] = _DeadlinesInput
    client: Breakwire = Field(default_factory=Breakwire)

    def _run(self, service: Optional[str] = None, run_manager: Any = None) -> Any:
        try:
            return [{"id": c.get("cid"), "title": c.get("title"), "deadline": c.get("deadline"), "fix": c.get("fix"), "url": c.get("url")}
                    for c in self.client.deadlines(service, limit=10)]
        except Exception as e:  # noqa: BLE001
            return {"error": f"Breakwire unavailable: {e}"}


class _StackInput(BaseModel):
    packages: Optional[List[str]] = Field(default=None, description='Dependencies as "name@version" or "pypi:name==version", e.g. ["next@16.0.0", "pypi:mcp==1.9.0"]')
    files: Optional[Dict[str, str]] = Field(default=None, description="Raw dependency files by path: package.json, requirements.txt, pyproject.toml, .nvmrc, .github/workflows/*.yml")
    services: Optional[List[str]] = Field(default=None, description="Service slugs you call, e.g. anthropic-api, stripe, cloudflare-workers")


class BreakwireStackTool(BaseTool):
    """Check a dependency list or files for deadlines, breaking changes and advisories that apply to it."""

    model_config = ConfigDict(arbitrary_types_allowed=True)
    name: str = "breakwire_check_stack"
    description: str = (
        "Check a project's dependencies (package list or raw package.json / requirements.txt / pyproject.toml / workflow files) "
        "against Breakwire: returns deadlines, breaking changes and advisories that apply, soonest first. Use before deploys or upgrades."
    )
    args_schema: Type[BaseModel] = _StackInput
    client: Breakwire = Field(default_factory=Breakwire)
    max_items: int = 8

    def _run(self, packages: Optional[List[str]] = None, files: Optional[Dict[str, str]] = None,
             services: Optional[List[str]] = None, run_manager: Any = None) -> Any:
        try:
            r = self.client.stack(packages=packages, files=files, services=services)
            if r.get("empty"):
                return {"empty": True, "hint": r.get("hint")}
            items = r.get("items") or r.get("applicable") or []
            return {
                "applicable": [{"id": i.get("cid"), "title": i.get("title"), "deadline": i.get("deadline"), "days_left": i.get("days_left"),
                                "fix": i.get("fix"), "url": i.get("url")} for i in items[: self.max_items]],
                "total": len(items), "subscribe": (r.get("subscribe") or {}).get("how"), "remember": r.get("remember"),
            }
        except Exception as e:  # noqa: BLE001
            return {"error": f"Breakwire unavailable: {e}"}


def breakwire_tools(client: Optional[Breakwire] = None) -> List[BaseTool]:
    """The three Breakwire tools sharing one client: lookup_error, deadlines, check_stack."""
    c = client or Breakwire()
    return [BreakwireLookupTool(client=c), BreakwireDeadlinesTool(client=c), BreakwireStackTool(client=c)]


class BreakwireCallbackHandler(BaseCallbackHandler):
    """Looks up errors raised in LLM calls, tools and chains; sets ``error.breakwire`` and calls ``on_match``.

    Each exception is looked up once even though LangChain reports it at every level of nesting.
    Never raises (``raise_error`` is False), never changes the error. Privacy: no_log=True by default (0.2.0), so the
    server stores nothing; pass no_log=False to let misses count as anonymous coverage gaps.
    """

    raise_error: bool = False

    def __init__(self, service: Optional[str] = None, client: Optional[Breakwire] = None, timeout: float = 2.5,
                 log_miss: bool = True, on_match: Optional[Any] = None, no_log: bool = True, **lookup: Any):
        self.client = client or Breakwire(timeout=timeout)
        self.timeout = timeout
        self.lookup = {"service": service, "log_miss": log_miss, "no_log": no_log, **lookup}
        self.on_match = on_match
        self.results: List[Any] = []

    def _handle(self, error: BaseException) -> None:
        if not isinstance(error, Exception) or getattr(error, "breakwire", None) is not None:
            return
        info = explain(error, client=self.client, timeout=self.timeout, **{k: v for k, v in self.lookup.items() if v is not None})
        try:
            error.breakwire = info  # type: ignore[attr-defined]
        except Exception:
            pass
        self.results.append(info)
        if self.on_match:
            try:
                self.on_match(info, error)
            except Exception:
                pass

    def on_llm_error(self, error: BaseException, *, run_id: UUID, parent_run_id: Optional[UUID] = None, **kwargs: Any) -> None:
        self._handle(error)

    def on_tool_error(self, error: BaseException, *, run_id: UUID, parent_run_id: Optional[UUID] = None, **kwargs: Any) -> None:
        self._handle(error)

    def on_chain_error(self, error: BaseException, *, run_id: UUID, parent_run_id: Optional[UUID] = None, **kwargs: Any) -> None:
        self._handle(error)
