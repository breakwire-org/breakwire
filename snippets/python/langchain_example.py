"""LangChain: give the agent Breakwire tools, and look up any error raised in a chain/LLM/tool via a callback."""
from langchain_breakwire import BreakwireCallbackHandler, BreakwireDeadlinesTool, BreakwireLookupTool
from langchain_core.runnables import RunnableLambda

# --- the drop-in part -----------------------------------------------------------
tools = [BreakwireLookupTool(), BreakwireDeadlinesTool()]           # e.g. create_agent(model, tools=tools)
handler = BreakwireCallbackHandler(service="github-api", log_miss=False)
# chain.invoke(inputs, config={"callbacks": [handler]})  -> on error, err.breakwire has id / fix / confidence
# ---------------------------------------------------------------------------------


def push_release(_):
    raise RuntimeError("HttpError: 403 Resource not accessible by integration")  # what a GitHub tool step might raise


def main():
    chain = RunnableLambda(lambda x: x) | RunnableLambda(push_release)
    try:
        chain.invoke({"tag": "v1"}, config={"callbacks": [handler]})
    except RuntimeError as e:
        print(e.breakwire.id, e.breakwire.confidence, "->", e.breakwire.fix)
    out = tools[0].invoke({"error": "No signatures found matching the expected signature for payload", "service": "stripe"})
    print("tool:", out["matches"][0]["id"], out["matches"][0]["confidence"])
    return handler.results[0], out


if __name__ == "__main__":
    main()
