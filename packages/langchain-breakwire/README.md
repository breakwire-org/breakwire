# langchain-breakwire

LangChain integration for [Breakwire](https://breakwire.org): tools an agent can call to look up an API/SDK error or
check upcoming deadlines, and a callback handler that looks up errors raised in your chains, LLM calls and tools.

```bash
pip install langchain-breakwire
```

```python
from langchain_breakwire import BreakwireLookupTool, BreakwireDeadlinesTool, BreakwireCallbackHandler

tools = [BreakwireLookupTool(), BreakwireDeadlinesTool()]      # give them to your agent

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
- `BreakwireCallbackHandler`: `on_llm_error` / `on_tool_error` / `on_chain_error`; each exception is looked up once even
  though LangChain reports it at every nesting level. Never raises, never changes the error. `on_match(info, error)` hook.

Built on the stdlib-only [`breakwire`](https://pypi.org/project/breakwire/) client, which strips secrets before sending.
Breakwire's community verification has just started; claims link primary sources, prefer those.

MIT.
