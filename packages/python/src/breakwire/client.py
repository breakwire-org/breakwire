"""Breakwire client (stdlib only)."""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, List, Optional, Union

from ._redact import redact_secrets

__version__ = "0.1.0"
DEFAULT_BASE_URL = "https://breakwire.org"
_CID = re.compile(r"^AN-\d{4}-\d{4,}$")


class BreakwireError(Exception):
    """An HTTP error returned by the Breakwire API."""

    def __init__(self, message: str, status: int, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # urllib turns a redirected POST into a GET without a body; we re-send ourselves instead.
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def error_text(err: Any) -> str:
    """One line of error text: type, message, status, code, nested API message, cause. Never a traceback."""
    if err is None:
        return ""
    if isinstance(err, str):
        return err
    parts: List[str] = []
    name = type(err).__name__ if isinstance(err, BaseException) else ""
    msg = str(err) if isinstance(err, BaseException) else ""
    if not isinstance(err, BaseException):
        try:
            return json.dumps(err, default=str)[:2000]
        except Exception:
            return str(err)
    parts.append(f"{name}: {msg}" if msg else name)
    status = getattr(err, "status_code", None) or getattr(err, "status", None) or getattr(getattr(err, "response", None), "status_code", None)
    if isinstance(status, int) and str(status) not in msg:
        parts.append(f"status {status}")
    code = getattr(err, "code", None)
    if code and isinstance(code, (str, int)) and str(code) not in msg:
        parts.append(f"code {code}")
    body = getattr(err, "body", None)
    if isinstance(body, dict):
        inner = body.get("error", body)
        if isinstance(inner, dict):
            for k in ("type", "code", "message"):
                v = inner.get(k)
                if isinstance(v, str) and v not in msg:
                    parts.append(v)
    cause = err.__cause__ or (None if err.__suppress_context__ else err.__context__)
    if cause is not None and cause is not err:
        c = error_text(cause)
        if c and c not in msg:
            parts.append(f"cause: {c}")
    return " | ".join(p for p in parts if p)


def _http_status(err: Any) -> Optional[int]:
    for s in (getattr(err, "status_code", None), getattr(err, "status", None), getattr(getattr(err, "response", None), "status_code", None)):
        if isinstance(s, int) and 100 <= s < 600:
            return s
    return None


class Breakwire:
    """Client for the Breakwire API.

    base_url defaults to $BREAKWIRE_BASE_URL, then https://breakwire.org. Reads and lookups need no key.
    """

    def __init__(self, base_url: Optional[str] = None, timeout: float = 3.0, api_key: Optional[str] = None,
                 user_agent: Optional[str] = None, secrets: Optional[Iterable[Union[str, "re.Pattern[str]"]]] = None):
        self.base_url = (base_url or os.environ.get("BREAKWIRE_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout
        self.api_key = api_key or os.environ.get("BREAKWIRE_API_KEY")
        # Explicit UA: Cloudflare's edge answers 403 to Python-urllib's default User-Agent.
        self.user_agent = f"breakwire-python/{__version__}" + (f" {user_agent}" if user_agent else "")
        self.secrets = list(secrets or [])

    def redact(self, text: Any) -> str:
        return redact_secrets(text, self.secrets)

    def request(self, method: str, path: str, body: Any = None, auth: bool = False) -> Any:
        url = self.base_url + path
        data = None if body is None else json.dumps(body).encode()
        headers = {"accept": "application/json", "user-agent": self.user_agent}
        if data is not None:
            headers["content-type"] = "application/json"
        if auth and self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        for _ in range(3):
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            try:
                with _opener.open(req, timeout=self.timeout) as resp:
                    return self._decode(resp.read())
            except urllib.error.HTTPError as e:
                loc = e.headers.get("location") if e.headers else None
                if e.code in (301, 302, 303, 307, 308) and loc:
                    url = urllib.parse.urljoin(url, loc)  # re-send same method + body to the new host
                    continue
                payload = self._decode(e.read())
                detail = f": {payload.get('error')}" if isinstance(payload, dict) and payload.get("error") else ""
                raise BreakwireError(f"Breakwire {method} {path} -> {e.code}{detail}", e.code, payload) from None
        raise BreakwireError(f"Breakwire {method} {path}: too many redirects", 310)

    @staticmethod
    def _decode(raw: bytes) -> Any:
        text = raw.decode("utf-8", "replace")
        try:
            return json.loads(text) if text else None
        except ValueError:
            return text

    def lookup(self, error: Any, service: Optional[str] = None, sdk: Optional[str] = None, version: Optional[str] = None,
               model: Optional[str] = None, http_status: Optional[int] = None, context: Optional[str] = None,
               cross_service: bool = False, log_miss: bool = True) -> Dict[str, Any]:
        """Match an error (exception or text) against documented signatures and claims. Redacted before sending."""
        body: Dict[str, Any] = {"error": self.redact(error_text(error))}
        if service:
            body["service"] = service
        if sdk:
            body["sdk"] = sdk
        if version:
            body["sdk_version"] = version
        if model:
            body["model"] = model
        st = http_status or _http_status(error)
        if st:
            body["http_status"] = st
        if context:
            body["context"] = self.redact(context)[:1000]
        if cross_service:
            body["cross_service"] = True
        if log_miss is False:
            body["log_miss"] = False
        return self.request("POST", "/api/lookup", body)

    def deadlines(self, service: Optional[str] = None, kind: Optional[str] = None, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """Upcoming act-by dates, soonest first."""
        q = {k: v for k, v in (("service", service), ("kind", kind), ("limit", limit)) if v}
        r = self.request("GET", "/api/deadlines" + ("?" + urllib.parse.urlencode(q) if q else ""))
        return r.get("deadlines") or r.get("claims") or []

    def claim(self, cid: str, version: Optional[int] = None) -> Dict[str, Any]:
        """Full claim record, e.g. claim("AN-2026-0001"). Pass version for an immutable snapshot."""
        if not _CID.match(cid or ""):
            raise ValueError(f"not a claim id: {cid!r}")
        return self.request("GET", f"/api/claims/{cid}" + (f"/versions/{int(version)}" if version else ""))

    def report(self, target: str, outcome: str, env: Optional[Dict[str, str]] = None, cid: Optional[str] = None,
               note: Optional[str] = None, statement_index: Optional[int] = None) -> Dict[str, Any]:
        """Say whether a fix worked. Only after you applied it and saw the result.

        target "lk_..." closes a lookup (anonymous unless api_key is set; cid picks the match).
        target "AN-YYYY-NNNN" files an outcome report on a claim (needs api_key).
        outcome: fixed | not_fixed | confirmed | disputed.
        """
        if outcome not in ("fixed", "not_fixed", "confirmed", "disputed"):
            raise ValueError("outcome must be fixed|not_fixed|confirmed|disputed")
        positive = outcome in ("fixed", "confirmed")
        clean_env = {k: self.redact(v)[:200] for k, v in (env or {}).items() if v is not None}
        clean_note = self.redact(note)[:2000] if note else None
        if target.startswith("lk_"):
            body = {"outcome": "fixed" if positive else "not_fixed", "env": clean_env}
            if cid:
                body["cid"] = cid
            if clean_note:
                body["note"] = clean_note
            return self.request("POST", f"/api/lookups/{urllib.parse.quote(target)}/outcome", body, auth=True)
        if _CID.match(target):
            if not self.api_key:
                raise ValueError("reporting on a claim needs api_key (or report on the lookup id instead)")
            if not positive and not clean_note:
                raise ValueError("a disputed report needs note")
            body = {"outcome": "confirmed" if positive else "disputed", "env": clean_env}
            if clean_note:
                body["note"] = clean_note
            if statement_index is not None:
                body["statement_index"] = statement_index
            return self.request("POST", f"/api/claims/{target}/reports", body, auth=True)
        raise ValueError(f"report target must be a lookup id (lk_...) or claim id (AN-...): {target!r}")

    def stack(self, dependencies: Optional[Dict[str, str]] = None, dev_dependencies: Optional[Dict[str, str]] = None,
              engines: Optional[Dict[str, str]] = None, packages: Optional[List[str]] = None) -> Dict[str, Any]:
        """package.json fields or ["name@version", ...] -> applicable deadlines, advisories and breaking changes."""
        body: Dict[str, Any] = {}
        if dependencies:
            body["dependencies"] = dependencies
        if dev_dependencies:
            body["devDependencies"] = dev_dependencies
        if engines:
            body["engines"] = engines
        if packages:
            body["packages"] = packages
        return self.request("POST", "/api/stack", body)

    def services(self) -> Dict[str, Any]:
        return self.request("GET", "/api/services")
