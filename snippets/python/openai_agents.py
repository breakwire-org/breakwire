"""OpenAI Agents SDK (Python): a Breakwire tool for the agent, and error-to-lookup around Runner.run."""
import os

from agents import Agent, Runner, function_tool, set_default_openai_client, set_tracing_disabled
from breakwire import Breakwire, with_breakwire
from openai import AsyncOpenAI

if os.environ.get("OPENAI_BASE_URL"):
    set_default_openai_client(AsyncOpenAI(base_url=os.environ["OPENAI_BASE_URL"], max_retries=0))
    set_tracing_disabled(True)

# --- the drop-in part -----------------------------------------------------------
bw = Breakwire()


@function_tool
def breakwire_lookup_error(error: str, service: str | None = None) -> list[dict]:
    """Look up an API/SDK error in Breakwire (source-linked breaking changes, deprecations, advisories) and get the fix."""
    r = bw.lookup(error, service=service, log_miss=False)
    return [{"id": m["cid"], "confidence": m["confidence"], "fix": m["fix"], "url": m["url"]} for m in r["matches"][:3]]


agent = Agent(name="Assistant", instructions="Be brief.", tools=[breakwire_lookup_error])
# ---------------------------------------------------------------------------------


def main():
    try:
        with with_breakwire(client=bw, service="openai-api", sdk="openai-agents-python"):
            Runner.run_sync(agent, "Say hi")
    except Exception as e:
        print(type(e).__name__, e.breakwire.id, e.breakwire.confidence, "->", e.breakwire.fix)
        return e.breakwire


if __name__ == "__main__":
    main()
