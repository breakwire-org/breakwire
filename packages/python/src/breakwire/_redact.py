"""Client-side secret stripping. Same rules as the TypeScript client (tests/redaction-cases.json)."""
import re
from typing import Iterable, Optional, Union

MAX_ERROR_CHARS = 4000

_B = r"A-Za-z0-9+/_-"
RULES = [
    (re.compile(r"-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z0-9 ]*(PRIVATE KEY|CERTIFICATE)-----"), "<secret>"),
    (re.compile(r"\b([a-z][a-z0-9+.-]{1,20}://)[^\s:@/]+:[^\s@/]+@", re.I), r"\1<secret>@"),
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
    (re.compile(r"((?:x-)?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|token|secret|password|passwd|pwd|authorization|cookie|set-cookie|session[_-]?id))([\"']?\s*[:=]\s*[\"']?)[^\s\"',;&}]{4,}", re.I), r"\1\2<secret>"),
    (re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+"), "<email>"),
    (re.compile(r"(https?://[^\s?#\"'<>]+)[?#][^\s\"'<>]*"), r"\1"),
    (re.compile(r"\b\d{1,3}(\.\d{1,3}){3}\b"), "<ip>"),
    (re.compile(r"(/home/|/Users/|[A-Za-z]:\\Users\\)[^/\\\s\"']+"), r"\1<user>"),
    (re.compile(r"\b[0-9a-fA-F]{32,}\b"), "<secret>"),
    (re.compile(r"(?<![" + _B + r"])(?=[" + _B + r"]*\d)(?=[" + _B + r"]*[A-Z])(?=[" + _B + r"]*[a-z])[" + _B + r"]{40,}={0,2}"), "<secret>"),
]


def redact_secrets(text: object, extra: Optional[Iterable[Union[str, "re.Pattern[str]"]]] = None) -> str:
    """Remove secrets, credentials, emails, IPs, query strings and user names from text."""
    s = "" if text is None else str(text)
    for e in extra or ():
        if not e:
            continue
        s = s.replace(e, "<secret>") if isinstance(e, str) else e.sub("<secret>", s)
    for rx, rep in RULES:
        s = rx.sub(rep, s)
    return s[:MAX_ERROR_CHARS]
