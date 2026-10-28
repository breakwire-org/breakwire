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

__version__ = "0.3.0"
LOOKUP_OUTCOMES = ("fixed", "partial", "applies", "not_fixed", "wrong_match", "not_covered", "solved")
DEFAULT_BASE_URL = "https://breakwire.org"
_CID = re.compile(r"^AN-\d{4}-\d{4,}$")
_SUB = re.compile(r"^sub_[A-Za-z0-9_-]{20,40}$")


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

    def request(self, method: str, path: str, body: Any = None, auth: bool = False, bearer: Optional[str] = None) -> Any:
        url = self.base_url + path
        data = None if body is None else json.dumps(body).encode()
        headers = {"accept": "application/json", "user-agent": self.user_agent}
        if data is not None:
            headers["content-type"] = "application/json"
        if auth and self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        if bearer:
            headers["authorization"] = f"Bearer {bearer}"
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
               cross_service: bool = False, log_miss: bool = True, no_log: bool = False, compact: bool = False,
               max_matches: Optional[int] = None, min_score: Optional[float] = None) -> Dict[str, Any]:
        """Match an error (exception or text) against documented signatures and claims. Redacted before sending.

        no_log=True: the server answers but stores nothing about this lookup (the error-path helpers default to it).
        compact=True: short, token-cheap answer. max_matches (1-10) and min_score (0-1) trim the matches server-side.
        Fail open: if Breakwire is slow or down this raises BreakwireError; the error-path helpers never raise.
        """
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
        if no_log:
            body["no_log"] = True
        if compact:
            body["compact"] = True
        if max_matches:
            body["max_matches"] = max(1, min(10, int(max_matches)))
        if min_score is not None:
            body["min_score"] = max(0.0, min(1.0, float(min_score)))
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

        target "lk_..." closes a lookup (anonymous unless api_key is set; cid picks the match). Outcomes:
        fixed | partial | applies | not_fixed | wrong_match | not_covered | solved (solved needs note).
        confirmed/disputed are accepted as aliases of fixed/not_fixed.
        target "AN-YYYY-NNNN" files an outcome report on a claim (needs api_key): fixed | not_fixed | confirmed | disputed.
        """
        clean_env = {k: self.redact(v)[:200] for k, v in (env or {}).items() if v is not None}
        clean_note = self.redact(note)[:2000] if note else None
        if target.startswith("lk_"):
            o = {"confirmed": "fixed", "disputed": "not_fixed"}.get(outcome, outcome)
            if o not in LOOKUP_OUTCOMES:
                raise ValueError("lookup outcome must be " + "|".join(LOOKUP_OUTCOMES))
            if o == "solved" and not clean_note:
                raise ValueError('outcome "solved" needs note (what fixed it)')
            body: Dict[str, Any] = {"outcome": o, "env": clean_env}
            if cid and o not in ("not_covered", "solved"):
                body["cid"] = cid
            if clean_note:
                body["note"] = clean_note
            return self.request("POST", f"/api/lookups/{urllib.parse.quote(target)}/outcome", body, auth=True)
        if _CID.match(target):
            if outcome not in ("fixed", "not_fixed", "confirmed", "disputed"):
                raise ValueError("a claim report outcome must be fixed|not_fixed|confirmed|disputed")
            positive = outcome in ("fixed", "confirmed")
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

    def launches(self, since: Optional[str] = None, services: Optional[List[str]] = None) -> Dict[str, Any]:
        """New model launches (official vendor sources only), newest first. since: YYYY-MM-DD or "30d"."""
        q = {k: v for k, v in (("since", since), ("services", ",".join(services) if services else None)) if v}
        return self.request("GET", "/api/launches" + ("?" + urllib.parse.urlencode(q) if q else ""))

    def changes(self, from_date: str, to: Optional[str] = None, service: Optional[str] = None, kind: Optional[str] = None) -> Dict[str, Any]:
        """What changed since a date (claims, model launches, revisions). Call with your training cutoff after deploys/upgrades."""
        q = {k: v for k, v in (("from", from_date), ("to", to), ("service", service), ("kind", kind)) if v}
        return self.request("GET", "/api/changes?" + urllib.parse.urlencode(q))

    def stack(self, dependencies: Optional[Dict[str, str]] = None, dev_dependencies: Optional[Dict[str, str]] = None,
              engines: Optional[Dict[str, str]] = None, packages: Optional[List[str]] = None,
              files: Optional[Union[Dict[str, str], List[Dict[str, str]]]] = None, **extra: Any) -> Dict[str, Any]:
        """package.json fields, ["name@version", ...] or raw files -> applicable deadlines, advisories and breaking changes.

        files: {"requirements.txt": text, "pyproject.toml": text, "package.json": text, ".github/workflows/ci.yml": yml}.
        An empty stack returns 200 with {"empty": True, "hint": ...}.
        """
        return self.request("POST", "/api/stack", _stack_body(dependencies, dev_dependencies, engines, packages, files, extra))

    @staticmethod
    def files_from(*paths: str) -> Dict[str, str]:
        """Read dependency files from disk into the files= mapping (missing files are skipped; 200 KB cap each)."""
        out: Dict[str, str] = {}
        for p in paths:
            try:
                with open(p, "r", encoding="utf-8", errors="replace") as fh:
                    out[p] = fh.read(200_000)
            except OSError:
                continue
        return out

    def subscribe(self, horizon_days: Optional[int] = None, webhook_url: Optional[str] = None,
                  launches: Optional[Union[bool, List[str]]] = None, **stack: Any) -> Dict[str, Any]:
        """Register a stack once; get alerts when a deadline or breaking change that affects it comes up.

        Same stack arguments as stack(). Returns id, manage_token (shown once: store it), feed {json, atom, rss},
        webhook (if webhook_url: status + secret), now, remember. No email or personal data is asked for.
        """
        files = stack.pop("files", None)
        body = _stack_body(stack.pop("dependencies", None), stack.pop("dev_dependencies", None), stack.pop("engines", None),
                           stack.pop("packages", None), files, stack)
        if horizon_days:
            body["horizon_days"] = int(horizon_days)
        if webhook_url:
            body["webhook_url"] = webhook_url
        if launches:
            body["launches"] = launches
        return self.request("POST", "/api/subscriptions", body)

    def alerts(self, subscription_id: str) -> Dict[str, Any]:
        """Pull a subscription's feed (JSON): alerts first, then everything that applies. Poll before deploys or weekly."""
        if not _SUB.match(subscription_id or ""):
            raise ValueError(f"not a subscription id: {subscription_id!r}")
        return self.request("GET", f"/api/subscriptions/{subscription_id}/feed")

    def update_subscription(self, subscription_id: str, manage_token: str, **patch: Any) -> Dict[str, Any]:
        """Change stack / horizon_days / webhook_url (None removes the webhook). Needs the manage_token."""
        return self.request("PATCH", f"/api/subscriptions/{subscription_id}", patch, bearer=manage_token)

    def unsubscribe(self, subscription_id: str, manage_token: str) -> Dict[str, Any]:
        """Delete a subscription (clears the stored stack and webhook URL)."""
        return self.request("DELETE", f"/api/subscriptions/{subscription_id}", bearer=manage_token)

    def services(self) -> Dict[str, Any]:
        return self.request("GET", "/api/services")


def _stack_body(dependencies, dev_dependencies, engines, packages, files, extra) -> Dict[str, Any]:
    body: Dict[str, Any] = {k: v for k, v in (extra or {}).items() if v is not None}
    if dependencies:
        body["dependencies"] = dependencies
    if dev_dependencies:
        body["devDependencies"] = dev_dependencies
    if engines:
        body["engines"] = engines
    if packages:
        body["packages"] = packages
    if files:
        body["files"] = files
    return body


def verify_webhook_signature(secret: str, signature_header: Optional[str], raw_body: Union[str, bytes], tolerance_sec: int = 300) -> bool:
    """Verify X-Breakwire-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + raw_body)>. Constant-time compare."""
    import hashlib
    import hmac
    import time
    m = re.search(r"t=(\d+),v1=([0-9a-f]{64})", signature_header or "")
    if not m:
        return False
    if abs(time.time() - int(m.group(1))) > tolerance_sec:
        return False
    body = raw_body.encode() if isinstance(raw_body, str) else raw_body
    mac = hmac.new(secret.encode(), m.group(1).encode() + b"." + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, m.group(2))
