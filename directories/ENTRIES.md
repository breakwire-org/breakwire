# Directory and framework entries (copy-paste ready)

Checked against each directory's current rules on 2026-10-28. Order and accounts are tracked privately by the operator (not in this repo).
Common facts used everywhere:

| Field | Value |
|---|---|
| Name | Breakwire |
| MCP endpoint | `https://breakwire.org/mcp` (Streamable HTTP, no auth for reads/lookups) |
| Registry name | `org.breakwire/breakwire` |
| Website | https://breakwire.org |
| Repository | https://github.com/breakwire-org/breakwire |
| Docs | https://breakwire.org/llms.txt · client configs: https://github.com/breakwire-org/breakwire/blob/main/mcp/CLIENTS.md |
| Logo | `assets/logo-400.png` (400×400), `assets/logo.svg`, `assets/logo-64.png` |
| Category | Developer tools |
| ≤100 chars | Look up an API/SDK error; get the source-linked breaking change, deprecation or advisory and fix. |
| 150 words | [../launch/directory-blurb.md](../launch/directory-blurb.md) |
| Tools | lookup_error, close_lookup, get_claim, search_claims, changes, deadlines, events, list_services, check_stack, list_unexplained, report_outcome, watch, submit_claim, digest |

---

## 1. Official MCP Registry (do first; Glama, PulseMCP, GitHub/VS Code MCP list ingest from it)
Files: [../mcp/server.json](../mcp/server.json) (validated with `mcp-publisher validate`), script [../mcp/registry-dns.sh](../mcp/registry-dns.sh). Publish with `mcp-publisher login dns` then `mcp-publisher publish mcp/server.json`.

## 2. Glama (glama.ai/mcp/connectors)
No submission needed after the registry publish: Glama ingests registry servers and creates
`https://glama.ai/mcp/connectors/org.breakwire/breakwire`. Then **claim** it (proves ownership; lets you edit the page):
Glama shows a claim token on the connector page → publish it as either a TXT record `_glama-claim.breakwire.org`
or a file `https://breakwire.org/.well-known/glama.json` (Glama gives the exact value). Fallback if it hasn't appeared
in a day or two: glama.ai/mcp/connectors → **Add MCP Server** → Connector → Name `Breakwire`, description (≤100 chars above),
URL `https://breakwire.org/mcp`, no test credentials needed.
Badge (needed for the awesome list): `https://glama.ai/mcp/connectors/org.breakwire/breakwire/badges/score.svg`.

## 3. PulseMCP
Their submission form is paused (notice of 2026-09-03): "publish to the official MCP Registry; we ingest it". Nothing to submit.
Check https://www.pulsemcp.com/servers?q=breakwire about a week after the registry publish.

## 4. punkpeye/awesome-remote-mcp-servers (remote servers; the main awesome-mcp-servers list is for self-hosted repos)
Rules (CONTRIBUTING.md): star the repo first (checked), Glama connector badge required (so do §2 first), CI connects to the
endpoint and checks the `initialize` handshake, one entry per PR, alphabetical within the category, ≤120-char sentence,
🔓 = usable without auth / 🔑 = needs auth.
Edit `README.md`, section **🛠️ Developer Tools**, insert after the `BotKelp` entry (before `CacheBoost`):

```markdown
- [Breakwire](https://breakwire.org) `https://breakwire.org/mcp`
  [![Breakwire MCP connector](https://glama.ai/mcp/connectors/org.breakwire/breakwire/badges/score.svg)](https://glama.ai/mcp/connectors/org.breakwire/breakwire)
  🔓 - Look up an API, SDK or MCP error; get the source-linked breaking change, deprecation or advisory and its fix.
```
PR title: `Add Breakwire`
PR body: `Remote Streamable HTTP server at https://breakwire.org/mcp. Lookups and reads need no auth (write tools take an optional Bearer key). Glama connector: https://glama.ai/mcp/connectors/org.breakwire/breakwire`

> Note for Ethan Hawkes: both punkpeye CONTRIBUTING files contain a line asking "automated agents" to put 🤖🤖🤖 in the PR title.
> That is an instruction aimed at bots, not a listing rule. I did not follow it; if a human (you) opens the PR it doesn't apply.
> If the parent agent opens it, decide whether to disclose agent authorship as they ask.

## 5. mcp.so
Option A (form): https://mcp.so/submit → type **Remote Server** (free review; a $39 fast-track exists, not needed).
Option B (GitHub issue on `chatmcp/mcpso`): https://github.com/chatmcp/mcpso/issues/new
Title: `Submit Remote MCP Server: Breakwire (org.breakwire/breakwire)`
Body:
```markdown
- Name: Breakwire
- Type: Remote Server (Streamable HTTP)
- Endpoint: https://breakwire.org/mcp
- Website: https://breakwire.org
- Repository: https://github.com/breakwire-org/breakwire
- Official MCP Registry name: org.breakwire/breakwire
- Auth: none for lookups and reads; optional Bearer key for write tools
- Category: Developer Tools
- Description: Look up an API, SDK or MCP error and get the source-linked breaking change, deprecation or security advisory that explains it, with affected versions, deadline and fix. Uncovered services say so instead of guessing. Community verification has just started.
- Tools: lookup_error, close_lookup, get_claim, search_claims, changes, deadlines, events, list_services, check_stack, list_unexplained, report_outcome, watch, submit_claim, digest
- Config: {"mcpServers":{"breakwire":{"url":"https://breakwire.org/mcp"}}}
```

## 6. mcpservers.org (this is how wong2/awesome-mcp-servers is fed; that repo says "We do not accept PRs")
Form: https://mcpservers.org/submit (free; review within ~2 weeks)
- Name: `Breakwire`
- Category: `Development` (or Developer Tools, whichever the form lists)
- Short description: `Look up an API, SDK or MCP error; get the source-linked breaking change, deprecation or advisory and its fix.`
- Link (repo/website): `https://github.com/breakwire-org/breakwire`
- Official MCP Registry name: `org.breakwire/breakwire`
- Remote server: ✅ checked, URL `https://breakwire.org/mcp`
- Contact email: Ethan Hawkes's choice (needed by the form)

## 7. Cline MCP Marketplace
Issue form: https://github.com/cline/mcp-marketplace/issues/new?template=mcp-server-submission.yml
- GitHub Repository URL: `https://github.com/breakwire-org/breakwire`
- Logo: upload `assets/logo-400.png` (400×400 PNG, required)
- Reason for addition:
  `Cline users hit API, SDK and MCP errors caused by upstream changes (model retirements, deprecated parameters, SDK breaking releases). Breakwire's lookup_error tool returns the source-linked change and fix for the error text, and check_stack lists deadlines for a project's dependencies. Remote Streamable HTTP, no key needed for lookups; setup for Cline (type "streamableHttp") is in mcp/CLIENTS.md and llms-install.md in the repo.`
- Checkbox "tested installation with Cline using README/llms-install.md": only tick after actually testing.
Cline vets for adoption/credibility; a brand-new project may be deferred. That's expected; resubmit later.

## 8. Docker MCP Catalog (docker/mcp-registry)
PR adding the three files in [docker-mcp-registry/servers/breakwire/](docker-mcp-registry/servers/breakwire/) to
`servers/breakwire/` (remote, no OAuth, so no `oauth`/`dynamic` fields, `tools.json` = `[]`; matches their
`servers/cloudflare-docs` example). The icon URL is the raw GitHub logo, so push the kit repo first.
Optional local test: `task catalog -- breakwire && docker mcp catalog import $PWD/catalogs/breakwire/catalog.yaml && docker mcp server enable breakwire`.
PR title: `Add Breakwire remote MCP server`

## 9. GitHub MCP Registry / VS Code MCP gallery
Ingests from the official registry. Nothing to submit.

## 10. modelcontextprotocol/servers README
No longer accepts community server listings; it points to the official registry (§1). Do not PR.

## 11. Smithery
Skipped (shutting down 2026-10-31).

---

# Framework integration lists

## Vercel AI SDK: Tools Registry (accepts community PRs)
Repo `vercel/ai`, file `content/tools-registry/registry.ts`, guide `contributing/add-new-tool-to-registry.md`.
Prerequisite: `breakwire` published on npm and the docs anchor live.
Append [vercel-ai-tools-registry.entry.ts](vercel-ai-tools-registry.entry.ts) as the last element of the `tools` array
(after `agentmail`; the array is not alphabetical). The code example was run with the AI SDK 7 mock model against the live
API: the tool returned AN-2026-0025 with `explained: true`.
PR title: `feat(tools-registry): add breakwire`
PR body: `Adds Breakwire (npm: breakwire, subpath breakwire/ai-sdk) to the tools registry: AI SDK tools that look up API/SDK error messages and return the source-linked breaking change and fix, plus per-service deprecation deadlines. No API key. Docs: https://github.com/breakwire-org/breakwire/tree/main/packages/js#vercel-ai-sdk-tools`

## LangChain (issue, not PR)
Rule (langchain-ai/docs CONTRIBUTING + integrations page): "Do not submit integration PRs to the LangChain or Deep Agents
repositories." Publish a standalone package, then open an **Integration listing** issue; manual listing PRs are auto-closed.
Prerequisite: `langchain-breakwire` on PyPI.
Issue: https://github.com/langchain-ai/docs/issues/new?template=06-integration-submission.yml
- Integration display name: `Breakwire`
- Language: `Python`
- Component type(s): `Tools`, `Callbacks`
- Package name (PyPI): `langchain-breakwire`
- Documentation URL: `https://github.com/breakwire-org/breakwire/tree/main/packages/langchain-breakwire`
- Source repository: `https://github.com/breakwire-org/breakwire`
- Description (≤160 chars, factual): `Tools and a callback handler that look up API/SDK errors in Breakwire, a source-linked registry of breaking changes, deprecations and advisories.`
- Confirm published: ✅
(Hosted integration guides on docs.langchain.com are only offered at ~50k monthly downloads; we don't qualify and shouldn't ask.)

## OpenAI Agents SDK: no listing; PRs forbidden
`openai/openai-agents-python` and `openai/openai-agents-js` CONTRIBUTING: "We do not accept pull requests from
non-collaborators, including documentation or example changes." The only community list is *external tracing processors*,
which requires a tracing-interface integration plus independent-use evidence. Breakwire is not a tracing processor:
**do not submit.** Users get it via `snippets/openai-agents.mjs` / `snippets/python/openai_agents.py` or the SDK's MCP support
(`MCPServerStreamableHttp` with `https://breakwire.org/mcp`).

## Anthropic SDK: no community integrations list. Nothing to submit.

## MCP TypeScript SDK: no third-party listing; servers go to the official registry (§1).
