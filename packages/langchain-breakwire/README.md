# langchain-breakwire

<!-- versions:begin (generated from versions.json by scripts/versions.mjs; do not edit) -->
**Current release:** clients **0.7.0** (npm `breakwire`, PyPI `breakwire`, PyPI `langchain-breakwire`) · server **0.10.0** · GitHub Action `breakwire-check` **1.2.0** · [CHANGELOG](https://github.com/breakwire-org/breakwire/blob/main/CHANGELOG.md)
<!-- versions:end -->

LangChain integration for [Breakwire](https://breakwire.org): tools an agent can call to look up an API/SDK error or
check upcoming deadlines, and a callback handler that looks up errors raised in your chains, LLM calls and tools.

```bash
pip install langchain-breakwire
```

```python
from langchain_breakwire import breakwire_tools, BreakwireCallbackHandler

tools = breakwire_tools()      # lookup_error, deadlines, check_stack (one shared client); give them to your agent

handler = BreakwireCallbackHandler(service="openai-api")
try:
    chain.invoke(inputs, config={"callbacks": [handler]})
except Exception as e:
    print(e.breakwire.id, e.breakwire.fix)    # same exception, explanation attached
    raise
```

- `BreakwireLookupTool` (`breakwire_lookup_error`): error text (+ optional service, sdk, sdk_version, model) → compact
  matches with id, confidence, fix, source URL. Unmatched errors are not logged unless `log_miss=True`.
- `BreakwireDeadlinesTool` (`breakwire_deadlines`): upcoming act-by dates for a service.
- `BreakwireStackTool` (`breakwire_check_stack`, 0.2.0): a package list or package.json / lockfiles / requirements.txt /
  pyproject.toml / workflow files (parsed locally since 0.6.0) → the deadlines, breaking changes and advisories that
  apply, soonest first.
- `BreakwireCallbackHandler`: `on_llm_error` / `on_tool_error` / `on_chain_error`; each exception is looked up once even
  though LangChain reports it at every nesting level. Never raises, never changes the error. `on_match(info, error)` hook.
  0.2.0: sends `no_log=True` by default (nothing stored server-side); `no_log=False` to contribute misses as gaps.
- Tool results include `remember`: one short line the agent can save to memory (when to consult Breakwire again).

Built on the stdlib-only [`breakwire`](https://pypi.org/project/breakwire/) client, which strips secrets before sending.
Breakwire's community verification has just started; claims link primary sources, prefer those.

MIT.

## 0.6.0

Requires `breakwire>=0.6.0`: the stack tool's files are parsed locally (only dependency and runtime facts are sent),
redirects never carry credentials to another origin, and the callback handler forwards every lookup option
(`compact`, `min_score`, `max_matches`, `since`, `reflex`, ...).

## 0.5.0

The default client sends `X-Breakwire-Client: langchain-breakwire/<version>` (aggregate per-channel counts on Breakwire 0.8.0). Requires `breakwire>=0.5.0`.

## 0.4.0

The lookup tool's compact result now includes `cite`, `please` and `miss` (gap id, coverage note, nearest claims). Requires `breakwire>=0.4.0`.

## 0.3.0

`breakwire_tools()` now returns five tools: `breakwire_lookup_error`, `breakwire_close_lookup` (every outcome),
`breakwire_changes` (what changed since a date, with new model launches), `breakwire_deadlines`, `breakwire_check_stack`.
All tools fail open: if Breakwire is unavailable they return `{"error": ...}` instead of raising.
