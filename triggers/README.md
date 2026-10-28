# Trigger packages

Same three triggers in three formats (the text lives in [TRIGGERS.md](TRIGGERS.md)):

| Tool | File | Install |
|---|---|---|
| Claude Code | [`plugins/claude-code/breakwire`](../plugins/claude-code/breakwire) (plugin: skill + remote MCP) | `/plugin marketplace add breakwire-org/breakwire` then `/plugin install breakwire@breakwire` |
| Cursor | [`cursor/.cursor/rules/breakwire.mdc`](cursor/.cursor/rules/breakwire.mdc) | copy into your repo's `.cursor/rules/` |
| Any agent reading AGENTS.md | [`AGENTS.md`](AGENTS.md) | paste the block into your `AGENTS.md` |

Triggers: (1) an error you do not recognise, (2) code that names a model id or SDK version, (3) a deploy or upgrade.
Step one in every case: `GET https://breakwire.org/api/changes?from=<your training cutoff>`. Fail open.
