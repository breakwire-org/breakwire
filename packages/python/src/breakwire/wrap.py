"""Opt-in error-to-lookup helpers: decorator, context manager, explain(). Breakwire never masks your error."""
from __future__ import annotations

import asyncio
import concurrent.futures
import functools
import inspect
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from .client import Breakwire

SKIP = object()  # return this from retry() to skip retrying (the original exception is re-raised, nothing reported)
_pool = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="breakwire")


@dataclass
class BreakwireInfo:
    """Attached to an exception as ``exc.breakwire``."""
    lookup_id: Optional[str] = None
    explained: bool = False  # True only when a vendor-documented error signature matched
    id: Optional[str] = None
    title: Optional[str] = None
    fix: Optional[str] = None
    confidence: Optional[str] = None
    url: Optional[str] = None
    deadline: Optional[str] = None
    matches: List[Dict[str, Any]] = field(default_factory=list)
    coverage: Optional[Dict[str, Any]] = None
    error: Optional[str] = None  # set when Breakwire itself failed

    @classmethod
    def from_result(cls, r: Optional[Dict[str, Any]], error: Optional[str] = None) -> "BreakwireInfo":
        r = r or {}
        m = (r.get("matches") or [{}])[0] if r.get("matches") else {}
        return cls(lookup_id=r.get("lookup_id"), explained=bool(r.get("explained")), id=m.get("cid"), title=m.get("title"),
                   fix=m.get("fix"), confidence=m.get("confidence"), url=m.get("url"), deadline=m.get("deadline"),
                   matches=r.get("matches") or [], coverage=r.get("coverage"), error=error)

    def note(self) -> Optional[str]:
        if not self.id:
            return None
        return f"Breakwire {self.id} ({self.confidence}): {self.title}\n  fix: {self.fix}\n  {self.url}"


_LOOKUP_KEYS = ("service", "sdk", "version", "model", "http_status", "context", "cross_service", "log_miss")


def explain(err: Any, client: Optional[Breakwire] = None, timeout: float = 2.5, **lookup: Any) -> BreakwireInfo:
    """Look up an error. Never raises; returns at most ``timeout`` seconds later."""
    try:
        c = client or Breakwire(timeout=timeout)
        fut = _pool.submit(c.lookup, err, **{k: v for k, v in lookup.items() if k in _LOOKUP_KEYS})
        return BreakwireInfo.from_result(fut.result(timeout=timeout))
    except concurrent.futures.TimeoutError:
        return BreakwireInfo(error=f"breakwire lookup timed out after {timeout} s")
    except Exception as e:  # noqa: BLE001 - Breakwire must never raise into the caller
        return BreakwireInfo(error=str(e) or type(e).__name__)


def _attach(exc: BaseException, info: BreakwireInfo, add_note: bool) -> None:
    try:
        exc.breakwire = info  # type: ignore[attr-defined]
    except Exception:
        pass
    n = info.note() if add_note else None
    if n and hasattr(exc, "add_note"):
        try:
            exc.add_note(n)  # shows in the traceback (Python 3.11+)
        except Exception:
            pass


def _safe_report(client: Breakwire, info: BreakwireInfo, outcome: str, env: Optional[Dict[str, str]], retry_err: Any = None) -> None:
    try:
        note = f"retry with suggested fix still failed: {client.redact(retry_err)[:300]}" if retry_err is not None else None
        client.report(info.lookup_id or "", outcome, env or {}, cid=info.id, note=note)
    except Exception:
        pass


class with_breakwire:
    """Decorator and context manager.

    @with_breakwire(service="anthropic-api")
    def call(): ...

    with with_breakwire(service="openai-api"):
        client.responses.create(...)

    On an exception: looks it up, sets ``exc.breakwire`` (and a traceback note), then re-raises the ORIGINAL exception.
    Options: should_lookup(exc) -> bool; on_match(info, exc); retry(info, exc, *args, **kwargs) -> result or SKIP (decorator only);
    auto_report=True (explicit opt-in) reports the retry's outcome on the lookup; report_env={...}.
    """

    def __init__(self, func: Optional[Callable] = None, *, client: Optional[Breakwire] = None, timeout: float = 2.5,
                 should_lookup: Optional[Callable[[BaseException], bool]] = None,
                 on_match: Optional[Callable[[BreakwireInfo, BaseException], None]] = None,
                 retry: Optional[Callable[..., Any]] = None, auto_report: bool = False,
                 report_env: Optional[Dict[str, str]] = None, add_note: bool = True,
                 base_url: Optional[str] = None, **lookup: Any):
        unknown = set(lookup) - set(_LOOKUP_KEYS)
        if unknown:
            raise TypeError(f"unknown with_breakwire options: {sorted(unknown)}")
        self._client = client
        self._base_url = base_url
        self.timeout = timeout
        self.should_lookup = should_lookup
        self.on_match = on_match
        self.retry = retry
        self.auto_report = auto_report
        self.report_env = report_env
        self.add_note = add_note
        self.lookup = lookup
        self._func = func
        if func is not None:
            functools.update_wrapper(self, func)

    @property
    def client(self) -> Breakwire:
        if self._client is None:
            self._client = Breakwire(base_url=self._base_url, timeout=self.timeout)
        return self._client

    def _handle(self, exc: BaseException) -> Optional[BreakwireInfo]:
        if not isinstance(exc, Exception):  # KeyboardInterrupt, SystemExit, CancelledError: leave alone
            return None
        try:
            if self.should_lookup and not self.should_lookup(exc):
                return None
        except Exception:
            return None
        try:
            client = self.client
        except Exception:
            return None
        info = explain(exc, client=client, timeout=self.timeout, **self.lookup)
        _attach(exc, info, self.add_note)
        if self.on_match:
            try:
                self.on_match(info, exc)
            except Exception:
                pass
        return info

    # context manager
    def __enter__(self) -> "with_breakwire":
        return self

    def __exit__(self, et, exc, tb) -> bool:
        if exc is not None:
            self._handle(exc)
        return False  # never swallow

    async def __aenter__(self) -> "with_breakwire":
        return self

    async def __aexit__(self, et, exc, tb) -> bool:
        if exc is not None:
            await asyncio.get_running_loop().run_in_executor(None, self._handle, exc)
        return False

    # decorator
    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        if self._func is None:  # used as @with_breakwire(...)
            fn = args[0]
            clone = with_breakwire(fn, client=self._client, timeout=self.timeout, should_lookup=self.should_lookup,
                                   on_match=self.on_match, retry=self.retry, auto_report=self.auto_report,
                                   report_env=self.report_env, add_note=self.add_note, base_url=self._base_url, **self.lookup)
            if inspect.iscoroutinefunction(fn):
                @functools.wraps(fn)
                async def aw(*a: Any, **k: Any) -> Any:
                    return await clone._acall(*a, **k)
                return aw
            return clone
        if inspect.iscoroutinefunction(self._func):
            return self._acall(*args, **kwargs)
        return self._call(*args, **kwargs)

    def _call(self, *args: Any, **kwargs: Any) -> Any:
        try:
            return self._func(*args, **kwargs)  # type: ignore[misc]
        except Exception as exc:
            info = self._handle(exc)
            if self.retry and info and info.lookup_id and info.id:
                try:
                    value = self.retry(info, exc, *args, **kwargs)
                except Exception as retry_exc:
                    if self.auto_report:
                        _safe_report(self.client, info, "not_fixed", self.report_env, retry_exc)
                    raise exc
                if value is SKIP:
                    raise
                if self.auto_report:
                    _safe_report(self.client, info, "fixed", self.report_env)
                return value
            raise

    async def _acall(self, *args: Any, **kwargs: Any) -> Any:
        try:
            return await self._func(*args, **kwargs)  # type: ignore[misc]
        except Exception as exc:
            loop = asyncio.get_running_loop()
            info = await loop.run_in_executor(None, self._handle, exc)
            if self.retry and info and info.lookup_id and info.id:
                try:
                    value = self.retry(info, exc, *args, **kwargs)
                    if inspect.isawaitable(value):
                        value = await value
                except Exception as retry_exc:
                    if self.auto_report:
                        await loop.run_in_executor(None, _safe_report, self.client, info, "not_fixed", self.report_env, retry_exc)
                    raise exc
                if value is SKIP:
                    raise
                if self.auto_report:
                    await loop.run_in_executor(None, _safe_report, self.client, info, "fixed", self.report_env)
                return value
            raise
