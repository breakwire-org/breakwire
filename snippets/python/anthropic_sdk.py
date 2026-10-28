"""Anthropic Python SDK: on an API error, look it up and attach the explanation."""
import anthropic
from breakwire import with_breakwire

client = anthropic.Anthropic(max_retries=0)  # base_url from ANTHROPIC_BASE_URL if set


# --- the drop-in part -----------------------------------------------------------
@with_breakwire(service="anthropic-api", sdk="anthropic-python", version=anthropic.__version__)
def create_message(**params):
    return client.messages.create(**params)
# ---------------------------------------------------------------------------------


def main():
    try:
        create_message(model="claude-opus-5-5", max_tokens=256, tool_choice={"type": "any"},
                       tools=[{"name": "get_weather", "description": "Weather", "input_schema": {"type": "object", "properties": {}}}],
                       messages=[{"role": "user", "content": "Weather in Paris?"}])
    except anthropic.APIStatusError as e:
        print(e.status_code, e.breakwire.id, e.breakwire.confidence, "->", e.breakwire.fix)  # also printed as a traceback note
        return e.breakwire


if __name__ == "__main__":
    main()
