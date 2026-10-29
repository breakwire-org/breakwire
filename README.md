# Breakwire clients, MCP config and CI check

<!-- versions:begin (generated from versions.json by scripts/versions.mjs; do not edit) -->
**Current release:** clients **0.6.0** (npm `breakwire`, PyPI `breakwire`, PyPI `langchain-breakwire`) · server **0.9.0** · GitHub Action `breakwire-check` **1.2.0** · [CHANGELOG](https://github.com/breakwire-org/breakwire/blob/main/CHANGELOG.md)
<!-- versions:end -->

[Breakwire](https://breakwire.org) is a source-linked registry of changes that break AI agents: model retirements, API
deprecations, SDK breaking releases, MCP spec changes and security advisories. Send it an error, get back the claim
that explains it (e.g. `AN-2026-0025`) with the vendor's documented error string, affected versions, deadline, fix and
primary source.

This repo holds everything that talks to it:

| | Path | Install |
|---|---|---|
| TypeScript/JS client (zero deps, Node 18+, Workers) + Vercel AI SDK tools | [packages/js](packages/js) | `npm i breakwire` |
| Python client (stdlib only, 3.9+) | [packages/python](packages/python) | `pip install breakwire` |
| LangChain tools + callback handler | [packages/langchain-breakwire](packages/langchain-breakwire) | `pip install langchain-breakwire` |
| MCP server config for Claude, Cursor, VS Code, Cline, Codex, Windsurf, Gemini CLI | [mcp/CLIENTS.md](mcp/CLIENTS.md) | `https://breakwire.org/mcp` |
| GitHub Action: fail CI on near deadlines / advisories | [action](action) (published as `breakwire-org/breakwire-check`) | `uses: breakwire-org/breakwire-check@v1` |
| Framework snippets: Vercel AI SDK, OpenAI Agents, Anthropic SDK, LangChain, MCP TS client | [snippets](snippets) | |
| Trigger packages: Claude Code plugin (skill + MCP), Cursor rule, AGENTS.md block | [triggers](triggers) | `/plugin marketplace add breakwire-org/breakwire` |
| Gemini CLI extension (remote MCP + GEMINI.md context) | [gemini-extension.json](gemini-extension.json) | `gemini extensions install https://github.com/breakwire-org/breakwire` |

## 30 seconds

```bash
curl -s https://breakwire.org/api/lookup -H 'content-type: application/json' \
  -d '{"error":"tool_choice: type \"tool\" and \"any\" are not supported for this model.","service":"anthropic-api"}'
```

```ts
import { withBreakwire } from 'breakwire';
const create = withBreakwire((p) => anthropic.messages.create(p), { service: 'anthropic-api' });
try { await create(params) } catch (e) { console.log(e.breakwire?.id, e.breakwire?.fix); throw e }
```

```python
from breakwire import with_breakwire
with with_breakwire(service="openai-api"):
    client.responses.create(...)   # exception gets .breakwire (id, fix, url) and a traceback note
```

## When to call it (the three triggers)

1. An error you do not recognise. 2. Code that names a model id or SDK version. 3. A deploy or upgrade.
Step one each time: `GET https://breakwire.org/api/changes?from=<your training cutoff>` (changes, new model launches,
revisions). Fail open: if Breakwire is slow or down, carry on. Details: [triggers/TRIGGERS.md](triggers/TRIGGERS.md).

## What's new in 0.6.0 (clients)

Security and correctness release; see [CHANGELOG.md](CHANGELOG.md) and [SECURITY.md](SECURITY.md).

- **Redirects never carry credentials or bodies to another origin.** Clients follow redirects only to
  `https://breakwire.org`, the base URL's origin and any `trustedOrigins` / `trusted_origins` you pin.
- **Stack files are parsed in your process.** `stack()` / `subscribe()` send only dependency and runtime facts;
  `previewStack()` / `preview_stack()` show the exact body; raw files need `rawFiles: true` / `raw_files=True`.
- **Retry works in the default no-log mode**, and the local cache keys on every lookup option.
- **Broader local redaction** (IPv6, UUIDs, request/trace ids, filesystem and UNC paths, credentials in any URI scheme,
  secret-named JSON fields) with `previewRedaction()` / `preview_redaction()`.
- Python `with_breakwire` accepts every `lookup()` option (`compact`, `min_score`, `max_matches`, `since`, `reflex`).

## Principles

- **Opt-in and harmless.** Lookups happen only on errors, are time-boxed, and never throw or replace your error.
- **Secrets stay home.** Keys, tokens, emails, IPv4/IPv6 addresses, UUIDs and request ids, query strings, credentials
  in URLs and filesystem paths are stripped in your process before sending ([shared test cases](tests/redaction-cases.json);
  `previewRedaction()` / `preview_redaction()` show exactly what would leave); the server redacts again. Stack files are
  parsed locally and only dependency facts are sent. Redirects never carry credentials or bodies to another origin.
- **No silent reporting.** Outcome reports ("did the fix work") are sent only with `autoReport`/`auto_report` on, and
  only after your retry actually ran.
- **Honest data.** `signature` vs `related` confidence, explicit "not covered" for services without claims, and
  community verification that has just started: most claims have no outcome reports yet, and each claim says so.

## Development

```bash
cd packages/js && npm ci && npm test              # offline unit tests (+ npm run test:live)
cd packages/python && python -m unittest discover -s tests
cd packages/langchain-breakwire && python -m unittest discover -s tests
cd action && npm test
cd snippets && npm ci && npm test                  # real SDKs against a mock vendor + live Breakwire
node scripts/versions.mjs --check                  # fails on stale versions (edit versions.json, run without --check)
```

Versions live in one place, [versions.json](versions.json). `node scripts/versions.mjs` writes them into the package
manifests, source constants and the README banners; CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the
check plus every suite. Shared cross-language fixtures: [tests/](tests) (redaction, redirect policy, stack parsing,
lookup option contract).

Live tests use `log_miss: false` and never send outcome reports. Set `BREAKWIRE_BASE_URL` to point at another deployment.

API: https://breakwire.org/llms.txt · OpenAPI: https://breakwire.org/openapi.json · Data: CC BY 4.0 · Code: [MIT](LICENSE)
