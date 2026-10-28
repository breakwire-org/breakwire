"""Live smoke test. Read-only except lookups (log_miss=False). Files NO reports.
BREAKWIRE_BASE_URL=https://agent-news.ethan-hawkes.workers.dev python tests/live.py"""
import datetime
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
from breakwire import Breakwire, with_breakwire  # noqa: E402

base = os.environ.get("BREAKWIRE_BASE_URL", "https://agent-news.ethan-hawkes.workers.dev")
bw = Breakwire(base_url=base, timeout=8, user_agent="breakwire-kit-live-test")
LOG = pathlib.Path(__file__).resolve().parents[3] / "test-lookups.txt"
ids = []


def rec(lid):
    if lid:
        ids.append(lid)
        with LOG.open("a") as f:
            f.write(f"{lid}\tpython\t{datetime.datetime.now(datetime.timezone.utc).isoformat()}\n")


print("base", base, "UA", bw.user_agent)
print("  services:", len(bw.services().get("services", [])))
d = bw.deadlines("anthropic-api")
print("  deadlines(anthropic-api):", len(d), d[0]["cid"] if d else None, d[0].get("deadline") if d else None)
c = bw.claim("AN-2026-0076")
print("  claim:", c.get("cid") or c.get("claim", {}).get("cid"))

r = bw.lookup('Error code: 400 - {"type":"error","error":{"type":"invalid_request_error","message":"This model does not support assistant message prefill. The conversation must end with a user message."}} api_key=sk-ant-api03-QQQQQQQQQQQQQQQQQQQQ',
              service="anthropic-api", sdk="anthropic-python", version="0.60.0", log_miss=False)
rec(r["lookup_id"])
print("  lookup:", r["explained"], r["matches"][0]["cid"], r["matches"][0]["confidence"], "| key leaked:", "qqqq" in r["normalized"])
assert r["explained"] and r["matches"][0]["cid"] == "AN-2026-0019" and "qqqq" not in r["normalized"]

r = bw.lookup("frobnicator quux exploded unexpectedly zzqv", log_miss=False)
rec(r["lookup_id"])
assert not r["explained"] and r["unexplained"] is None
print("  miss: explained", r["explained"], "matches", len(r["matches"]), "logged", r["unexplained"])


class APIStatusError(Exception):
    status_code = 403


@with_breakwire(client=bw, service="github-api", log_miss=False, timeout=8)
def push():
    raise APIStatusError("HttpError: Resource not accessible by integration")


try:
    push()
except APIStatusError as e:
    rec(e.breakwire.lookup_id)
    print("  decorator:", e.breakwire.id, e.breakwire.confidence, (e.breakwire.fix or "")[:60])
    assert e.breakwire.id == "AN-2026-0087"
    print("  note:", e.__notes__[0].splitlines()[0] if hasattr(e, "__notes__") else "-")

try:
    with with_breakwire(client=bw, service="resend", log_miss=False, timeout=8):
        raise RuntimeError("validation_error: You can only send testing emails to your own email address (bob@example.com)")
except RuntimeError as e:
    rec(e.breakwire.lookup_id)
    print("  context manager:", e.breakwire.id, e.breakwire.confidence)
    assert e.breakwire.id == "AN-2026-0093"

s = bw.stack(packages=["anthropic==0.60.0", "openai>=1.0", "mcp", "slack_sdk"])
print("  stack:", s["applicable_count"], [x["service"] for x in s["services"]])
assert s["applicable_count"] > 0
print("LIVE OK; lookups made:", len(ids), " ".join(ids))
