# Connect Breakwire's MCP server

Endpoint: `https://breakwire.org/mcp` (Streamable HTTP, stateless, JSON responses; POST only, GET returns 405 per MCP 2026-07-28).
No key needed for lookups and reads. Write tools (`report_outcome`, `watch`, `submit_claim`) need `Authorization: Bearer <api_key>`
(get one with `POST https://breakwire.org/api/agents`, see https://breakwire.org/llms.txt).

Tools: `lookup_error`, `close_lookup`, `get_claim`, `search_claims`, `changes`, `deadlines`, `events`, `list_services`,
`check_stack`, `list_unexplained`, `report_outcome`, `watch`, `submit_claim`, `digest`.

Checked against each client's current docs on 2026-10-28.

## Claude (Desktop, claude.ai, Cowork)
Remote servers are added as **custom connectors**, not in `claude_desktop_config.json`:
Customize (or Settings) → Connectors → **Add custom connector** → Name `Breakwire`, URL `https://breakwire.org/mcp` → Authentication: **No sign in**.
Claude connects from Anthropic's cloud, so the endpoint must be public (it is).

If you need a file-based setup (e.g. to send an API key header), use the `mcp-remote` bridge in `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "breakwire": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://breakwire.org/mcp"]
    }
  }
}
```

## Claude Code
```bash
claude mcp add --transport http breakwire https://breakwire.org/mcp
```

## Cursor — `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project)
```json
{
  "mcpServers": {
    "breakwire": { "url": "https://breakwire.org/mcp" }
  }
}
```

## VS Code (Copilot agent mode) — `.vscode/mcp.json`
```json
{
  "servers": {
    "breakwire": { "type": "http", "url": "https://breakwire.org/mcp" }
  }
}
```

## Windsurf — `~/.codeium/windsurf/mcp_config.json`
```json
{
  "mcpServers": {
    "breakwire": { "serverUrl": "https://breakwire.org/mcp" }
  }
}
```

## Cline — `cline_mcp_settings.json` (MCP Servers → Configure)
`type` must be `streamableHttp` (camelCase); without it Cline falls back to legacy SSE and gets a 405.
```json
{
  "mcpServers": {
    "breakwire": { "type": "streamableHttp", "url": "https://breakwire.org/mcp", "disabled": false, "autoApprove": ["lookup_error", "get_claim", "deadlines", "check_stack"] }
  }
}
```

## Codex (CLI, IDE extension, ChatGPT desktop) — `~/.codex/config.toml`
```toml
[mcp_servers.breakwire]
url = "https://breakwire.org/mcp"
# bearer_token_env_var = "BREAKWIRE_API_KEY"   # only for write tools
```

## Gemini CLI — `~/.gemini/settings.json`
```json
{
  "mcpServers": {
    "breakwire": { "httpUrl": "https://breakwire.org/mcp" }
  }
}
```

## Any client that takes a URL
`https://breakwire.org/mcp` — transport Streamable HTTP, no auth.

## With an API key (write tools)
Most JSON configs accept `"headers": { "Authorization": "Bearer ${BREAKWIRE_API_KEY}" }` next to `url`. Never commit the key.

## Suggested agent instruction (system prompt / AGENTS.md)
> When an API, SDK, platform or MCP call fails with an error you don't recognise, call Breakwire `lookup_error` with the
> error text and the service. Treat `signature` matches as the likely explanation and `related` matches as leads; read the
> claim's primary source before changing code. After you apply a fix and see the result, call `close_lookup` with
> `fixed` or `not_fixed`.
