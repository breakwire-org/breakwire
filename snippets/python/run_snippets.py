"""Runs the Python snippets against a local mock vendor API (no keys) and the LIVE Breakwire API. Files no reports."""
import datetime
import json
import os
import pathlib
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = pathlib.Path(__file__).resolve().parent
KIT = HERE.parents[1]
sys.path[:0] = [str(HERE), str(KIT / "packages/python/src"), str(KIT / "packages/langchain-breakwire/src")]

ANTHROPIC_400 = {"type": "error", "error": {"type": "invalid_request_error", "message": 'tool_choice: type "tool" and "any" are not supported for this model.'}}
OPENAI_429 = {"error": {"message": "Your organization has reached its spend limit for this billing period.", "type": "insufficient_quota", "param": None, "code": "organization_spend_limit_exceeded"}}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length") or 0))
        code, body = (400, ANTHROPIC_400) if self.path.startswith("/anthropic/") else (429, OPENAI_429) if self.path.startswith("/openai/") else (404, {"error": "mock"})
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
mock = f"http://127.0.0.1:{srv.server_port}"
os.environ.update(ANTHROPIC_BASE_URL=mock + "/anthropic", ANTHROPIC_API_KEY="test-key-not-real",
                  OPENAI_BASE_URL=mock + "/openai/v1", OPENAI_API_KEY="test-key-not-real")
os.environ.setdefault("BREAKWIRE_BASE_URL", "https://breakwire.org")
log = (KIT / "test-lookups.txt").open("a")
failed = 0


def rec(lid, tag):
    if lid:
        log.write(f"{lid}\tsnippet-py:{tag}\t{datetime.datetime.now(datetime.timezone.utc).isoformat()}\n")


def check(name, fn):
    global failed
    try:
        fn()
        print("ok  ", name)
    except Exception as e:  # noqa: BLE001
        failed += 1
        import traceback
        traceback.print_exc()
        print("FAIL", name, e)


def t_anthropic():
    import anthropic_sdk
    info = anthropic_sdk.main()
    rec(info.lookup_id, "anthropic")
    assert info.id == "AN-2026-0025", info


def t_agents():
    import openai_agents
    info = openai_agents.main()
    rec(info.lookup_id, "openai-agents")
    assert info.id == "AN-2026-0044", info


def t_langchain():
    import langchain_example
    info, out = langchain_example.main()
    rec(info.lookup_id, "langchain-cb")
    rec(out["lookup_id"], "langchain-tool")
    assert info.id == "AN-2026-0087" and out["matches"][0]["id"] == "AN-2026-0076"


check("anthropic-sdk (python)", t_anthropic)
check("openai-agents (python)", t_agents)
check("langchain (python)", t_langchain)
log.close()
print(f"{failed} FAILED" if failed else "ALL PYTHON SNIPPETS OK")
sys.exit(1 if failed else 0)
