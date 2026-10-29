# Trigger packages

Same triggers in three formats (the text lives in [TRIGGERS.md](TRIGGERS.md)):

| Tool | File | Install |
|---|---|---|
| Claude Code | [`plugins/claude-code/breakwire`](../plugins/claude-code/breakwire) (plugin: skill + remote MCP) | `/plugin marketplace add breakwire-org/breakwire` then `/plugin install breakwire@breakwire` |
| Cursor | [`cursor/.cursor/rules/breakwire.mdc`](cursor/.cursor/rules/breakwire.mdc) | copy into your repo's `.cursor/rules/` |
| Any agent reading AGENTS.md | [`AGENTS.md`](AGENTS.md) | paste the block into your `AGENTS.md` |

Triggers: (0) session start: `POST https://breakwire.org/api/session-brief` (MCP `session_brief`), silent when clear;
(1) an error you do not recognise, (2) code that names a model id or SDK version, (3) a deploy or upgrade.
For 1-3, step one is `GET https://breakwire.org/api/changes?from=<your training cutoff>`. Fail open.
