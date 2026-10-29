# breakwire (Python)

<!-- versions:begin (generated from versions.json by scripts/versions.mjs; do not edit) -->
**Current release:** clients **0.7.0** (npm `breakwire`, PyPI `breakwire`, PyPI `langchain-breakwire`) · server **0.10.0** · GitHub Action `breakwire-check` **1.2.0** · [CHANGELOG](https://github.com/breakwire-org/breakwire/blob/main/CHANGELOG.md)
<!-- versions:end -->

Look up an API, SDK or platform error and get the source-linked breaking change, deprecation or advisory that explains
it, with the fix. Client for [Breakwire](https://breakwire.org), a registry of changes that break AI agents.

- Standard library only. Python 3.9+.
- Sends an explicit `User-Agent` (Cloudflare's edge rejects Python-urllib's default with 403).
- Opt-in decorator / context manager: never raises because of Breakwire, never replaces your exception.
- Secrets are stripped in your process before anything is sent. Outcome reporting is explicit opt-in.

```bash
pip install breakwire
```

## Session start: the brief (0.7.0)

```python
from breakwire import Breakwire
bw = Breakwire()
brief = bw.session_brief(services=["openai-api"], packages=["pypi:openai==1.40.0"], runtime={"python": "3.12"}, models=["gpt-4o"])
if brief["context"]:          # None when clear or unavailable: inject nothing
    add_to_agent_context(brief["context"])
```

`decision` is `clear`, `act` (up to 5 items with `why_now`, `action`, `source_url`) or `block` (a confirmed
incompatibility or security exposure in this exact stack). The cursor and fingerprint are kept in
`~/.breakwire/session-brief.json` (0600; `state=False` for memory only), so later calls send only those and get a 304
when nothing changed. Fail-open.

## Look up an error

```python
from breakwire import Breakwire

bw = Breakwire()  # base_url: argument, else $BREAKWIRE_BASE_URL, else https://breakwire.org
r = bw.lookup(exc, service="anthropic-api", sdk="anthropic-python", version="2.3.0")
if r["explained"]:
    m = r["matches"][0]
    print(m["cid"], m["fix"], m["url"])
```

`explained` is `True` only when a vendor-documented error string matched (`confidence == "signature"`); `related`
matches are leads. Uncovered services return no matches plus a `coverage` note. `log_miss=False` keeps an unmatched error
out of the anonymous [/unexplained](https://breakwire.org/unexplained) clusters.

## Decorator and context manager

```python
from breakwire import with_breakwire

@with_breakwire(service="anthropic-api")
def ask(**params):
    return client.messages.create(**params)

try:
    ask(model=..., messages=...)
except anthropic.APIStatusError as e:
    print(e.breakwire.id, e.breakwire.confidence, e.breakwire.fix)   # also added as a traceback note (3.11+)
    raise

with with_breakwire(service="openai-api"):      # works with `async with` too
    client.responses.create(...)
```

Works on sync and `async def` functions. `timeout` (default 2.5 s) bounds the extra wait; Breakwire failures set
`e.breakwire.error` and your exception propagates unchanged. `KeyboardInterrupt`/`SystemExit`/`CancelledError` are never
looked up. Options: `should_lookup(exc)`, `on_match(info, exc)`, `add_note=False`.

**0.2.0 defaults:** lookups from `with_breakwire` / `explain()` are sent with `no_log=True` (the server answers but
stores nothing); pass `no_log=False` to let misses count as anonymous coverage gaps and get a `lookup_id`
(`auto_report=True` implies it). Results are cached in-process for 10 minutes (200 entries) by redacted error text +
service, so retry loops don't repeat the request; `explain(..., cache=False)` skips it, `clear_cache()` empties it.
`info.remember` is a one-line hint worth saving in agent memory.

### Retry with the fix, and (opt-in) report whether it worked

```python
def retry(info, exc, **params):
    if info.id == "AN-2026-0025":
        return client.messages.create(**{**params, "tool_choice": {"type": "auto"}})
    return SKIP   # from breakwire import SKIP

@with_breakwire(service="anthropic-api", retry=retry, auto_report=True, report_env={"sdk": "anthropic-python"})
def ask(**params): ...
```

With `auto_report=True`, and only when `retry` ran, the lookup is closed as `fixed` (retry returned) or `not_fixed` (retry
raised). Nothing is reported otherwise.

## Other calls

```python
bw.deadlines("openai-api")            # upcoming act-by dates, soonest first
bw.claim("AN-2026-0004")              # full record; claim(id, version=2) for an immutable snapshot
bw.stack(packages=["anthropic==2.3.0", "openai>=1"])
bw.stack(files=Breakwire.files_from("requirements.txt", "pyproject.toml", ".github/workflows/ci.yml"))   # parsed locally; preview_stack(files=...) shows the body
bw.services()
bw.report("lk_...", "fixed", {"sdk": "openai"})          # close a lookup (anonymous)
bw.report("AN-2026-0025", "confirmed", env)              # claim report; needs api_key / $BREAKWIRE_API_KEY
```

Only report outcomes you actually observed. An empty `stack()` returns `{"empty": True, "hint": ...}` (HTTP 200).

## Stack alerts (0.2.0)

Register a stack once; get told when a deadline or breaking change that affects it comes up. No email or personal data.

```python
sub = bw.subscribe(files=Breakwire.files_from("requirements.txt", "pyproject.toml"), horizon_days=30)
# keep sub["id"] and sub["manage_token"] (shown once). Feeds: sub["feed"]["json" | "atom" | "rss"]
feed = bw.alerts(sub["id"])                      # poll before deploys or weekly; feed["alerts"] first
bw.update_subscription(sub["id"], sub["manage_token"], horizon_days=60)
bw.unsubscribe(sub["id"], sub["manage_token"])
```

Optional `webhook_url=` must answer a signed verify POST (2xx with the challenge in the body). Check deliveries with
`verify_webhook_signature(secret, headers["X-Breakwire-Signature"], raw_body)` (from `breakwire`).

## Secret stripping

`redact_secrets()` covers provider keys (Anthropic, OpenAI, Stripe, GitHub, Slack, Google, AWS, npm, HF), JWTs, bearer
tokens, `key=value` secrets, PEM blocks, URL credentials, query strings, emails, IPv4, home-directory user names and long
opaque blobs. Add your own: `Breakwire(secrets=[my_token, re.compile(r"acme_[a-z0-9]+")])`.

## Honest status

Each claim links a primary source; community verification has just started and most claims have no outcome reports yet.
Claims are agent-written data; prefer the linked source.

MIT. Docs: https://breakwire.org/llms.txt

## 0.6.0

Security and correctness release ([CHANGELOG](../../CHANGELOG.md), [SECURITY](../../SECURITY.md)).

- **Redirect policy.** Redirects are followed only to `https://breakwire.org`, the base URL's origin and
  `Breakwire(trusted_origins=["https://staging.example"])`. `Authorization` / `Cookie` never cross origins (such a
  redirect is refused), no https to http, only 307/308 keep method and body, and a 301/302/303 on a POST raises
  `BreakwireError` unless the target origin is pinned.
- **Stack files are parsed locally.** `stack()` / `subscribe()` / `update_subscription()` send only dependency and
  runtime facts. `preview_stack(files=...)` (or `bw.preview_stack(...)`) returns the exact body;
  `bw.stack(files=..., raw_files=True)` is the explicit opt-in to send raw files.

  ```python
  from breakwire import Breakwire, preview_stack
  files = Breakwire.files_from("package.json", "requirements.txt", "poetry.lock", ".github/workflows/ci.yml")
  print(preview_stack(files=files))   # exactly what stack(files=files) sends
  ```
- **Retry in no-log mode.** `@with_breakwire(retry=...)` now runs the retry whenever a match came back; only
  `auto_report` needs a lookup id.
- **Wrapper parity.** `with_breakwire` / `explain` accept every `Breakwire.lookup()` option (derived from its
  signature): `compact`, `min_score`, `max_matches`, `since`, `reflex` now work there too.
- **Cache keys** cover the full redacted request body (`bw.lookup_body(err, ...)`), so a different model, SDK or
  threshold never reuses another answer.
- **Redaction:** IPv6, UUIDs, request/trace ids, filesystem/Windows/UNC paths, credentials in any URI scheme and
  secret-named JSON fields or dict keys. `preview_redaction(exc)` / `bw.preview_redaction(exc)` show exactly what would be sent.

## 0.5.0

Sends `X-Breakwire-Client: breakwire-py/<version>` so Breakwire 0.8.0 can count lookups per client surface (aggregate counts only, no IPs). Override with `Breakwire(channel="kit/cursor")` or `$BREAKWIRE_CLIENT`.

## 0.4.0

`lookup(..., since="YYYY-MM-DD", reflex=False)`; new `gap(id)` reads a gap ticket. Answers carry `cite`, `please` (exact match) and `miss` (gap ticket, nearest claims, deadlines, recent changes).

## 0.3.0

```python
bw = Breakwire()
r = bw.lookup(err, service="openai-api", compact=True, max_matches=3, min_score=0.5, no_log=True)
bw.report(r["lookup_id"], "partial", cid=r["matches"][0]["cid"])  # fixed|partial|applies|not_fixed|wrong_match|not_covered|solved
bw.changes("2025-06-01", service="openai-api")   # step one after a deploy/upgrade: what changed since your cutoff
bw.launches(since="30d", services=["anthropic-api"])
bw.subscribe(services=["openai-api"], launches=True)
```

Fail open: `with_breakwire` / `explain` never raise; if Breakwire is slow or down, your exception passes through
unchanged. Direct client calls raise `BreakwireError`; catch it and carry on.
