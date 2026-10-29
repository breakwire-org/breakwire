"""Client-side secret stripping. Same rules as the TypeScript client (shared fixtures: tests/redaction-cases.json)."""
from __future__ import annotations

import json
import re
from typing import Any, Iterable, List, Optional, Union

MAX_ERROR_CHARS = 4000

_HTTP_METHOD_BEFORE = re.compile(r"\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+$")
_API_FIRST_SEGMENT = re.compile(r"^(?:v\d+[A-Za-z0-9.]*|api|apis|graphql|\.well-known|oauth2?|openai|rest|rpc|webhooks?|mcp)$", re.I)
_PKG_DIRS = {"node_modules", "site-packages", "dist-packages"}
_HOME_DIRS = {"home", "users"}
_SECRET_KEY = re.compile(r"(?:^|[_.-])(?:secret|token|password|passwd|pwd|passphrase|apikey|api[_-]?key|authorization|auth|credentials?|private[_-]?key|cookie|set[_-]cookie|signature|access[_-]?key|session(?:[_-]?(?:id|token|key))?)$", re.I)
_HEX4 = re.compile(r"^[0-9A-Fa-f]{1,4}$")


def is_secret_key(key: Any) -> bool:
    """True when a structured field name looks like it holds a secret (camelCase is split first)."""
    return bool(_SECRET_KEY.search(re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(key)).lower()))


def _path_replacement(segs: List[str], sep: str) -> str:
    for i, s in enumerate(segs):
        if s.lower() in _PKG_DIRS:
            return "<path>" + sep + sep.join(segs[i:])
    if len(segs) <= 2 and segs[0].lower() in _HOME_DIRS:
        return "<path>"
    return "<path>" + sep + segs[-1]


def _posix_path(m: "re.Match[str]") -> str:
    p = m.group(0)
    segs = [s for s in p.split("/") if s]
    if not segs or _API_FIRST_SEGMENT.match(segs[0]):
        return p
    if _HTTP_METHOD_BEFORE.search(m.string[max(0, m.start() - 12):m.start()]):
        return p
    return _path_replacement(segs, "/")


def _windows_path(m: "re.Match[str]") -> str:
    p = m.group(0)
    body = re.sub(r"^(?:[A-Za-z]:|\\+)", "", p)
    segs = [s for s in re.split(r"[\\/]+", body) if s]
    if not segs:
        return p
    return _path_replacement(segs, "\\")


def _ipv6(m: "re.Match[str]") -> str:
    s0 = m.group(0)
    if not re.search(r"\d", s0) or s0.count(":") < 2:
        return s0
    s, extra = s0, 0
    v4 = re.search(r"(\d{1,3}(?:\.\d{1,3}){3})$", s)
    if v4:
        s = s[: -len(v4.group(1))]
        if not s.endswith(":"):
            return s0
        s = s if s.endswith("::") else s[:-1]
        extra = 2
    dbl = s.split("::")
    if len(dbl) > 2:
        return s0
    groups = [g for part in dbl if part for g in part.split(":")]
    if not all(_HEX4.match(g) for g in groups):
        return s0
    n = len(groups) + extra
    if (n > 7) if len(dbl) == 2 else (n != 8):
        return s0
    return "<ip>"


def _json_field(m: "re.Match[str]") -> str:
    return f'"{m.group(1)}"{m.group(2)}"<secret>"' if is_secret_key(m.group(1)) else m.group(0)


_B = r"A-Za-z0-9+/_-"
RULES = [
    (re.compile(r"-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z0-9 ]*(PRIVATE KEY|CERTIFICATE)-----"), "<secret>"),
    (re.compile(r"\b([a-z][a-z0-9+.-]{1,20}://)[^\s/@?#\"'<>]+@", re.I), r"\1<secret>@"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}"), "<secret>"),
    (re.compile(r"\bsk-ant-[A-Za-z0-9_-]{8,}"), "<secret>"),
    (re.compile(r"\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}"), "<secret>"),
    (re.compile(r"\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}"), "<secret>"),
    (re.compile(r"\bwhsec_[A-Za-z0-9+/=]{8,}"), "<secret>"),
    (re.compile(r"\b(ghp|gho|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{10,}"), "<secret>"),
    (re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{8,}"), "<secret>"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{20,}"), "<secret>"),
    (re.compile(r"\bya29\.[0-9A-Za-z_-]{20,}"), "<secret>"),
    (re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b"), "<secret>"),
    (re.compile(r"\ban_[A-Za-z0-9_-]{16,}"), "<secret>"),
    (re.compile(r"\bnpm_[A-Za-z0-9]{20,}"), "<secret>"),
    (re.compile(r"\bhf_[A-Za-z0-9]{20,}"), "<secret>"),
    (re.compile(r"\bre_[A-Za-z0-9_]{16,}"), "<secret>"),
    (re.compile(r"\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}", re.I), r"\1 <secret>"),
    (re.compile(r'"([^"\\\n]{1,64})"(\s*:\s*)"(?:[^"\\\n]|\\.)*"'), _json_field),
    (re.compile(r"\b((?:x-)?(?:request|trace|correlation|span|amzn-request|amz-request)[ _-]?id|x-amzn-trace-id|cf-ray|traceparent)([\"']?\s*[:=]\s*[\"']?)[^\s\"',;&}]{4,}", re.I), r"\1\2<id>"),
    (re.compile(r"\b00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}\b"), "<id>"),
    (re.compile(r"\breq_[A-Za-z0-9]{8,}"), "<id>"),
    (re.compile(r"((?:x-)?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|token|secret|password|passwd|pwd|authorization|cookie|set-cookie|session[_-]?id))([\"']?\s*[:=]\s*[\"']?)[^\s\"',;&}]{4,}", re.I), r"\1\2<secret>"),
    (re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+"), "<email>"),
    (re.compile(r"(\b[a-z][a-z0-9+.-]{1,20}://[^\s?#\"'<>]+)[?#][^\s\"'<>]*", re.I), r"\1"),
    (re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"), "<uuid>"),
    (re.compile(r"(?<![0-9A-Za-z_:.])[0-9A-Fa-f:]{2,39}(?:\d{1,3}(?:\.\d{1,3}){3})?(?![0-9A-Za-z_:]|\.\d)"), _ipv6),
    (re.compile(r"\b\d{1,3}(\.\d{1,3}){3}\b"), "<ip>"),
    (re.compile(r"(?<![A-Za-z0-9_\\])\\{2,4}[A-Za-z0-9._$-]+(?:\\{1,2}[^\\\s\"'<>:|?*]+)+"), _windows_path),
    (re.compile(r"(?<![A-Za-z0-9_])[A-Za-z]:(?:\\{1,2}|/)[^\\/\s\"'<>:|?*]+(?:(?:\\{1,2}|/)[^\\/\s\"'<>:|?*]+)*"), _windows_path),
    (re.compile(r"(?<![A-Za-z0-9_.:/~@\]>-])/(?:[^\s/\\\"'<>:;,()\[\]{}|*?]+/)+[^\s/\\\"'<>:;,()\[\]{}|*?]*"), _posix_path),
    (re.compile(r"\b[0-9a-fA-F]{32,}\b"), "<secret>"),
    (re.compile(r"(?<![" + _B + r"])(?=[" + _B + r"]*\d)(?=[" + _B + r"]*[A-Z])(?=[" + _B + r"]*[a-z])[" + _B + r"]{40,}={0,2}"), "<secret>"),
]


def redact_structure(v: Any, depth: int = 0) -> Any:
    """Deep copy of a dict/list with the values of secret-looking keys replaced by "<secret>"."""
    if depth > 20:
        return "<truncated>"
    if isinstance(v, (list, tuple)):
        return [redact_structure(x, depth + 1) for x in v]
    if isinstance(v, dict):
        return {k: ("<secret>" if is_secret_key(k) and not isinstance(x, (dict, list, tuple)) else redact_structure(x, depth + 1))
                for k, x in v.items()}
    return v


def redact_secrets(text: object, extra: Optional[Iterable[Union[str, "re.Pattern[str]"]]] = None) -> str:
    """Remove secrets, credentials, emails, IPs, ids, query strings and filesystem paths from text (or a dict/list)."""
    if isinstance(text, (dict, list, tuple)):
        try:
            s = json.dumps(redact_structure(text), separators=(",", ":"), default=str)
        except Exception:
            s = str(text)
    else:
        s = "" if text is None else str(text)
    for e in extra or ():
        if not e:
            continue
        s = s.replace(e, "<secret>") if isinstance(e, str) else e.sub("<secret>", s)
    for rx, rep in RULES:
        s = rx.sub(rep, s)
    return s[:MAX_ERROR_CHARS]
