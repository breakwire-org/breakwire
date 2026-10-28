# Framework snippets: error → Breakwire lookup in a few lines

Each file is a drop-in pattern (the part between the `---` comments) plus a tiny `main()` so it can be run.
`npm test` / `python python/run_snippets.py` run all of them against a local mock of the vendor API (returns the
vendor's documented error body, so no API keys are needed) and the live Breakwire API. Last run 2026-10-28: all pass.

| Framework | File | Pattern | Result in test |
|---|---|---|---|
| Vercel AI SDK (`ai@7`, `@ai-sdk/anthropic`) | [vercel-ai-sdk.mjs](vercel-ai-sdk.mjs) | `withBreakwire(generateText)` + optional `breakwireTools()` | 400 → AN-2026-0025 (signature) |
| OpenAI Agents SDK (JS 0.21) | [openai-agents.mjs](openai-agents.mjs) | `withBreakwire(run)` + a `tool()` the agent can call | 429 → AN-2026-0044 |
| OpenAI Agents SDK (Python 0.24) | [python/openai_agents.py](python/openai_agents.py) | `with with_breakwire(...)` around `Runner.run_sync` + `@function_tool` | 429 → AN-2026-0044 |
| Anthropic SDK (TS 1.3) | [anthropic-sdk.mjs](anthropic-sdk.mjs) | `withBreakwire((p) => anthropic.messages.create(p))` | 400 → AN-2026-0025 |
| Anthropic SDK (Python 2.3) | [python/anthropic_sdk.py](python/anthropic_sdk.py) | `@with_breakwire` | 400 → AN-2026-0025 |
| LangChain (Python, langchain-core 1.7) | [python/langchain_example.py](python/langchain_example.py) | `BreakwireCallbackHandler` + `BreakwireLookupTool` | 403 → AN-2026-0087 |
| MCP TypeScript SDK client (1.32) | [mcp-ts-client.mjs](mcp-ts-client.mjs) | `withBreakwire((r) => client.callTool(r))`, or call Breakwire's `lookup_error` over MCP | MCP -32602 → no match (honest miss); lookup_error → AN-2026-0082 |

The shortest version of all of them:

```ts
const call = withBreakwire(yourApiCall, { service: 'anthropic-api' });
try { await call(args) } catch (e) { console.log(e.breakwire?.id, e.breakwire?.fix); throw e }
```
