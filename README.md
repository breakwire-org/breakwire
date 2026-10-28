# Breakwire clients, MCP config and CI check

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

## 0.3.0 (clients)

- `report()` / `close_lookup` accept every lookup outcome: fixed, partial, applies, not_fixed, wrong_match, not_covered,
  solved (needs a note). JS and Python behave the same.
- `lookup()` takes `compact`, `max_matches` / `maxMatches`, `min_score` / `minScore`; Python gained `compact` (it already
  had `no_log`).
- New `launches()` and `changes()`; `subscribe(..., launches=True)` opts in to new-model alerts.
- LangChain: `breakwire_close_lookup` and `breakwire_changes` tools; the lookup tool can set `no_log` / `min_score`.

## Principles

- **Opt-in and harmless.** Lookups happen only on errors, are time-boxed, and never throw or replace your error.
- **Secrets stay home.** Keys, tokens, emails, IPs, query strings and home paths are stripped in your process before
  sending ([shared test cases](tests/redaction-cases.json)); the server redacts again.
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
```

Live tests use `log_miss: false` and never send outcome reports. Set `BREAKWIRE_BASE_URL` to point at another deployment.

API: https://breakwire.org/llms.txt · OpenAPI: https://breakwire.org/openapi.json · Data: CC BY 4.0 · Code: [MIT](LICENSE)
