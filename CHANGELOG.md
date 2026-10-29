# Changelog

Client packages: npm `breakwire`, PyPI `breakwire`, PyPI `langchain-breakwire` (released together). Versions are
managed in [versions.json](versions.json).

## 1.2.0 (Action `breakwire-check`) and server 0.9.0, 2026-10-29

### Action 1.2.0

- **Security: redirects.** Before 1.2.0 the Action re-sent its stack POST body to any redirect `Location`. It now
  follows only https redirects to the base URL's origin or breakwire.org (http only for a same-origin localhost base
  URL), at most 3 hops, and keeps method and body only on 307/308. Tests: `action/test/redirect.test.js`.
- **Fewer false blocks.** A deadline matched only by service name is a warning by default; failing needs a
  package/version, runtime or model match (`deadline-policy: specific`, `any` restores the old behavior).
  New `models` input: multi-model lifecycle claims use the named model's own date and state.

### Server 0.9.0 (breakwire.org; contract additions the clients may want to expose)

- `POST /api/stack`: `installed` ({pkg: version}), `models`, `strict`, `compact`, `include_related`; items carry
  `match.applicability` (affected / not_affected / possibly_affected / unknown), `bucket` (exactly_applies / may_apply /
  context_only), `resources`; top-level `buckets`, `needs_installed_versions`.
- `POST /api/lookup`: `lifecycle_context`, `not_applicable`, `diagnostic_fork`, `persistence`, per-match `citation`
  (immutable /claim/X/v/N), `equivalent`; compact output omits reflex/remember unless asked; no gap URL on a no_log miss.
- Outcome reports: `evidence_type`, `intervention`, `verification`; only remedy_tested / production_recovered count as
  fix evidence. Claims: `dates` and per-resource `resources`. `GET /lookup?error=` in HTML no longer runs a lookup.
- MCP Registry entry `org.breakwire/breakwire` 0.9.0.

## 0.6.0 (clients), 2026-10-28

Security and correctness release from an outside review. Behavior changes, hence a minor bump.

### Security

- **P0: cross-origin redirects.** Before 0.6.0, the JS and Python clients re-sent the same headers and body on any
  301-308 to any `Location`, including `Authorization` (API key or subscription manage token) and POST bodies
  (outcome notes, stack payloads). Now redirects are followed only to trusted origins (`https://breakwire.org`, the
  base URL's origin, and `trustedOrigins` / `trusted_origins`). Credentials (`Authorization`, `Cookie`) never cross
  origins: an authenticated request redirected to another origin is refused. No https to http downgrade. 307/308
  keep the method and body; 301/302/303 turn GET/HEAD into GET and are an error for requests with a body unless the
  target origin is pinned (breakwire.org or `trustedOrigins`). At most 3 hops. Browser `opaqueredirect` responses
  are no longer re-fetched with `redirect: 'follow'`. See [SECURITY.md](SECURITY.md).
  Tests: `tests/redirect-cases.json` (13 shared cases) run by both clients, plus hop-limit, fail-open and opaque cases.
- **Stack files are parsed locally (P1).** `stack()`, `subscribe()` and `updateSubscription()` /
  `update_subscription()` parse `package.json`, `package-lock.json` / `npm-shrinkwrap.json`, `yarn.lock`,
  `requirements*.txt`, `pyproject.toml` (PEP 621 + Poetry), `poetry.lock`, `uv.lock`, `Pipfile.lock`, `.nvmrc`,
  `.node-version`, `.python-version`, `runtime.txt`, `vercel.json`, `netlify.toml` and workflow YAML in your process
  and send only `dependencies` / `devDependencies` / `peerDependencies` / `engines`, `packages` (exact lockfile
  versions), normalized `requirements` lines, `runtime` and `uses:` action refs (the fields `/api/stack` accepts).
  Scripts, names, repository URLs, index URLs, git/file/workspace dependencies, comments and unknown files stay home.
  `previewStack(input)` / `preview_stack(...)` return the exact body; `{ rawFiles: true }` / `raw_files=True` is the
  explicit opt-in to send raw files. Tests: `tests/stack-cases.json` (11 shared cases).
- **Broader client-side redaction (P2):** IPv6, UUIDs, request/trace ids (`req_…`, `x-request-id`, `cf-ray`,
  `traceparent`), absolute POSIX paths (API routes like `/v1/messages` are kept), Windows drive and UNC paths
  (the file name or `node_modules/…` / `site-packages/…` tail is kept), credentials in any URI scheme
  (`scheme://token@`, `scheme://user:pass@`) and query strings on any scheme, and secret-named fields in JSON text or
  plain objects/dicts (`client_secret`, `accessToken`, `x-api-key`, `password`, …). New `previewRedaction()` /
  `preview_redaction()` (module and client method) show exactly what would be sent. Shared fixtures:
  `tests/redaction-cases.json` (35 cases; both clients produce identical output).

### Fixed

- **Retry in no-log mode (P1).** `withBreakwire({ retry })` / `with_breakwire(retry=...)` required a lookup id, which
  the default `noLog` / `no_log` never returns, so the retry never ran. It now runs whenever a match came back; the
  lookup id is needed only for `autoReport` / `auto_report` (which skips reporting when there is none).
- **Cache keys (P1).** The local lookup cache now keys on the base URL plus the complete redacted request body
  (model, sdk, sdk version, http status, cross_service, context, min_score, max_matches, compact, since, reflex,
  no_log, service, error), so a different model, SDK or threshold never reuses another answer. JS exposes
  `client.lookupBody()`, Python `client.lookup_body()`.
- **Python wrapper parity (P2).** `with_breakwire` / `explain` derive their accepted options from
  `Breakwire.lookup()`'s signature, so `compact`, `min_score`, `max_matches`, `since` and `reflex` now work there.
  Cross-language contract: `tests/lookup-contract.json`.
- **Docs drift (P2).** One manifest (`versions.json`) drives package versions, source constants and README banners
  (`node scripts/versions.mjs`); CI fails on stale versions (`--check`). Release history moved here from the README.

### Changed

- POST 301/302/303 redirects on an unpinned origin now raise `BreakwireError` instead of silently re-sending
  (pin the new origin with `trustedOrigins` or update the base URL).
- `stack()` / `subscribe()` with files no longer upload the files (see above).
- `langchain-breakwire` requires `breakwire>=0.6.0`; its stack tool inherits local parsing.

### Known issues

- JS `verifyWebhookSignature` needs a global WebCrypto (`globalThis.crypto.subtle`): Node 19+, Workers, Deno, Bun.
  On Node 18 (EOL) it returns `false`; this predates 0.6.0. CI tests Node 20/22/24.

## 0.5.0 (clients)

- Channel tag `X-Breakwire-Client` (`breakwire-js/<version>`, `breakwire-py/<version>`, `langchain-breakwire/<version>`)
  so the server (0.8.0) can count lookups per client surface (aggregate counts only); kit MCP configs tag
  `kit/<client>`.

## 0.4.0 (clients; server 0.7.0)

- Every lookup answer carries `cite` (a ready-to-paste citation with the claim URL), an optional one-line `reflex`
  snippet (`reflex: false` drops it) and, on an exact vendor-signature match, `please`: the one call that reports
  whether the fix worked.
- A miss is no longer empty: `miss` has a gap ticket (`UX-…`, status at `GET /api/gaps/{id}`), a one-line coverage
  note, the service's nearest claims, upcoming deadlines and changes since a date (`since`, default 30 days).
  `explained` stays false.
- JS `lookup(err, { since, reflex })` and `gap(id)`; Python `lookup(..., since=, reflex=)` and `gap(id)`; LangChain's
  lookup tool passes `cite`, `please` and `miss` through.
- Agent files on the server: `/llms.txt` (short, lookup first), `/llms-full.txt`, `/.well-known/mcp/server.json`,
  `/.well-known/agent-card.json` (A2A), `/skill.md`, `/sitemap.xml`. All MCP tools have titles and annotations.

## 0.3.0 (clients)

- `report()` / `close_lookup` accept every lookup outcome: fixed, partial, applies, not_fixed, wrong_match, not_covered,
  solved (needs a note). JS and Python behave the same.
- `lookup()` takes `compact`, `max_matches` / `maxMatches`, `min_score` / `minScore`; Python gained `compact` (it already
  had `no_log`).
- New `launches()` and `changes()`; `subscribe(..., launches=True)` opts in to new-model alerts.
- LangChain: `breakwire_close_lookup` and `breakwire_changes` tools; the lookup tool can set `no_log` / `min_score`.
