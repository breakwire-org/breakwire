"""Offline unit tests: a local stdlib HTTP server stands in for the API. Run: python -m unittest discover -s tests"""
import asyncio
import json
import os
import pathlib
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
from breakwire import SKIP, Breakwire, BreakwireError, DEFAULT_BASE_URL, clear_cache, error_text, explain, redact_secrets, verify_webhook_signature, with_breakwire, __version__  # noqa: E402

CASES = json.loads((pathlib.Path(__file__).resolve().parents[3] / "tests" / "redaction-cases.json").read_text())
LOOKUP = {"lookup_id": "lk_abc123", "explained": True, "coverage": None, "matches": [
    {"cid": "AN-2026-0025", "title": "T", "confidence": "signature", "fix": "Use tool_choice auto", "url": "https://breakwire.org/claim/AN-2026-0025", "deadline": None}]}


class Server:
    def __init__(self):
        self.calls, self.mode = [], "ok"
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _go(self):
                n = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(n)) if n else None
                outer.calls.append({"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body})
                if outer.mode == "slow":
                    time.sleep(1.5)
                if outer.mode == "500":
                    return self._send(500, {"error": "boom"})
                if outer.mode == "nomatch" and self.path == "/api/lookup":
                    return self._send(200, {**LOOKUP, "explained": False, "matches": []})
                if self.path.startswith("/old/"):
                    self.send_response(301)
                    self.send_header("location", self.path[4:])
                    self.end_headers()
                    return
                if self.path.startswith("/api/deadlines"):
                    return self._send(200, {"deadlines": [{"cid": "AN-2026-0001"}]})
                if self.path == "/api/lookup":
                    return self._send(200, LOOKUP)
                return self._send(200, {"ok": True})

            do_GET = do_POST = do_PATCH = do_DELETE = _go

            def _send(self, code, obj):
                data = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_port}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()


S = Server()


def bw(**kw):
    return Breakwire(base_url=S.url, **kw)


class T(unittest.TestCase):
    def setUp(self):
        S.calls.clear()
        S.mode = "ok"
        clear_cache()

    def test_redaction_cases(self):
        for c in CASES:
            out = redact_secrets(c["in"])
            for a in c["absent"]:
                self.assertNotIn(a, out, f"leaked in {out}")
            for p in c["present"]:
                self.assertIn(p, out, f"lost in {out}")

    def test_base_url(self):
        os.environ.pop("BREAKWIRE_BASE_URL", None)
        self.assertEqual(Breakwire().base_url, "https://breakwire.org")
        self.assertEqual(DEFAULT_BASE_URL, "https://breakwire.org")
        os.environ["BREAKWIRE_BASE_URL"] = "https://e.test/"
        self.assertEqual(Breakwire().base_url, "https://e.test")
        del os.environ["BREAKWIRE_BASE_URL"]

    def test_lookup_redacts_and_sets_user_agent(self):
        e = Exception("invalid x-api-key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx")
        e.status_code = 401
        r = bw(user_agent="my-agent/1").lookup(e, service="anthropic-api", sdk="anthropic-python", version="0.60.0", log_miss=False)
        self.assertEqual(r["lookup_id"], "lk_abc123")
        c = S.calls[0]
        self.assertEqual((c["method"], c["path"]), ("POST", "/api/lookup"))
        self.assertTrue(c["headers"]["User-Agent"].startswith("breakwire-python/"))
        self.assertNotIn("Python-urllib", c["headers"]["User-Agent"])
        self.assertNotIn("AbCdEfGh", json.dumps(c["body"]))
        self.assertEqual({k: v for k, v in c["body"].items() if k != "error"},
                         {"service": "anthropic-api", "sdk": "anthropic-python", "sdk_version": "0.60.0", "http_status": 401, "log_miss": False})
        self.assertNotIn("Authorization", c["headers"])

    def test_post_resent_across_301(self):
        b = Breakwire(base_url=S.url + "/old")
        self.assertEqual(b.lookup("some error text")["lookup_id"], "lk_abc123")
        self.assertEqual([(c["method"], c["path"]) for c in S.calls], [("POST", "/old/api/lookup"), ("POST", "/api/lookup")])
        self.assertEqual(S.calls[1]["body"]["error"], "some error text")

    def test_routes(self):
        b = bw()
        self.assertEqual(b.deadlines("stripe-api", limit=5)[0]["cid"], "AN-2026-0001")
        b.deadlines()
        b.claim("AN-2026-0001")
        b.claim("AN-2026-0001", version=2)
        b.stack(packages=["next@15"])
        b.services()
        self.assertEqual([f"{c['method']} {c['path']}" for c in S.calls], [
            "GET /api/deadlines?service=stripe-api&limit=5", "GET /api/deadlines", "GET /api/claims/AN-2026-0001",
            "GET /api/claims/AN-2026-0001/versions/2", "POST /api/stack", "GET /api/services"])
        with self.assertRaises(ValueError):
            b.claim("../x")

    def test_report(self):
        b = bw()
        b.report("lk_abc123", "fixed", {"sdk": "openai", "runtime": "py key=sk-proj-abcdefghijklmnop12"}, cid="AN-2026-0025")
        c = S.calls[0]
        self.assertEqual((c["path"], c["body"]["outcome"], c["body"]["cid"]), ("/api/lookups/lk_abc123/outcome", "fixed", "AN-2026-0025"))
        self.assertNotIn("abcdefghijklmnop12", json.dumps(c["body"]))
        b.report("lk_abc123", "disputed")
        self.assertEqual(S.calls[1]["body"]["outcome"], "not_fixed")
        with self.assertRaises(ValueError):
            b.report("AN-2026-0025", "confirmed")
        k = bw(api_key="k_test")
        with self.assertRaises(ValueError):
            k.report("AN-2026-0025", "not_fixed")
        k.report("AN-2026-0025", "fixed", statement_index=0)
        last = S.calls[-1]
        self.assertEqual((last["path"], last["body"]["outcome"], last["body"]["statement_index"], last["headers"]["Authorization"]),
                         ("/api/claims/AN-2026-0025/reports", "confirmed", 0, "Bearer k_test"))
        for bad in (("bogus", "fixed"), ("lk_x", "maybe")):
            with self.assertRaises(ValueError):
                b.report(*bad)

    def test_http_error(self):
        S.mode = "500"
        with self.assertRaises(BreakwireError) as cm:
            bw().services()
        self.assertEqual(cm.exception.status, 500)

    def test_error_text(self):
        try:
            try:
                raise KeyError("inner")
            except KeyError as k:
                e = RuntimeError("400 bad")
                e.status_code = 400
                e.body = {"error": {"type": "invalid_request_error", "message": "tool_choice not supported"}}
                raise e from k
        except RuntimeError as e:
            t = error_text(e)
        for s in ("RuntimeError: 400 bad", "invalid_request_error", "tool_choice not supported", "cause: KeyError"):
            self.assertIn(s, t)
        self.assertNotIn("Traceback", t)

    def test_decorator_attaches_and_reraises(self):
        orig = ValueError("tool_choice boom")

        @with_breakwire(base_url=S.url, service="anthropic-api")
        def f():
            raise orig
        with self.assertRaises(ValueError) as cm:
            f()
        self.assertIs(cm.exception, orig)
        self.assertEqual((orig.breakwire.id, orig.breakwire.fix, orig.breakwire.confidence, orig.breakwire.lookup_id),
                         ("AN-2026-0025", "Use tool_choice auto", "signature", "lk_abc123"))
        if sys.version_info >= (3, 11):
            self.assertIn("Breakwire AN-2026-0025", "\n".join(orig.__notes__))

    def test_bare_decorator_and_success_no_network(self):
        @with_breakwire
        def add(a, b):
            return a + b
        self.assertEqual(add(2, 3), 5)
        self.assertEqual(S.calls, [])

    def test_context_manager(self):
        orig = RuntimeError("x")
        with self.assertRaises(RuntimeError) as cm:
            with with_breakwire(base_url=S.url, service="openai-api"):
                raise orig
        self.assertIs(cm.exception, orig)
        self.assertEqual(orig.breakwire.id, "AN-2026-0025")
        self.assertEqual(S.calls[0]["body"]["service"], "openai-api")

    def test_breakwire_failure_never_masks(self):
        S.mode = "500"
        orig = RuntimeError("real")
        with self.assertRaises(RuntimeError) as cm:
            with with_breakwire(base_url=S.url):
                raise orig
        self.assertIs(cm.exception, orig)
        self.assertIsNone(orig.breakwire.id)
        self.assertIn("500", orig.breakwire.error)
        # unreachable host
        orig2 = RuntimeError("real2")
        with self.assertRaises(RuntimeError):
            with with_breakwire(base_url="http://127.0.0.1:9", timeout=1):
                raise orig2
        self.assertIsNotNone(orig2.breakwire.error)

    def test_timeout(self):
        S.mode = "slow"
        t0 = time.time()
        info = explain(Exception("x"), client=bw(timeout=5), timeout=0.3)
        self.assertLess(time.time() - t0, 1.0)
        self.assertIn("timed out", info.error)

    def test_should_lookup_and_base_exceptions(self):
        with self.assertRaises(KeyError):
            with with_breakwire(base_url=S.url, should_lookup=lambda e: not isinstance(e, KeyError)):
                raise KeyError("mine")
        with self.assertRaises(KeyboardInterrupt):
            with with_breakwire(base_url=S.url):
                raise KeyboardInterrupt()
        self.assertEqual(S.calls, [])

    def test_auto_report_off_by_default(self):
        @with_breakwire(base_url=S.url, retry=lambda info, exc: "retried")
        def f():
            raise RuntimeError("x")
        self.assertEqual(f(), "retried")
        self.assertEqual([c["path"] for c in S.calls], ["/api/lookup"])

    def test_auto_report_opt_in(self):
        @with_breakwire(base_url=S.url, auto_report=True, report_env={"sdk": "t"}, retry=lambda info, exc: "ok")
        def good():
            raise RuntimeError("x")
        self.assertEqual(good(), "ok")
        self.assertEqual((S.calls[1]["path"], S.calls[1]["body"]["outcome"], S.calls[1]["body"]["cid"]), ("/api/lookups/lk_abc123/outcome", "fixed", "AN-2026-0025"))

        def still_broken(info, exc):
            raise RuntimeError("still")
        orig = RuntimeError("y")

        @with_breakwire(base_url=S.url, auto_report=True, retry=still_broken)
        def bad():
            raise orig
        with self.assertRaises(RuntimeError) as cm:
            bad()
        self.assertIs(cm.exception, orig)
        self.assertEqual(S.calls[-1]["body"]["outcome"], "not_fixed")

    def test_skip_and_no_match_never_report(self):
        @with_breakwire(base_url=S.url, auto_report=True, retry=lambda info, exc: SKIP)
        def f():
            raise RuntimeError("x")
        with self.assertRaises(RuntimeError):
            f()
        S.mode = "nomatch"
        called = []

        @with_breakwire(base_url=S.url, auto_report=True, retry=lambda info, exc: called.append(1))
        def g():
            raise RuntimeError("x")
        with self.assertRaises(RuntimeError):
            g()
        self.assertEqual(called, [])
        self.assertEqual([c["path"] for c in S.calls], ["/api/lookup", "/api/lookup"])

    def test_async_decorator_and_context(self):
        orig = RuntimeError("async boom")

        @with_breakwire(base_url=S.url)
        async def f():
            raise orig

        @with_breakwire
        async def ok():
            return 7

        async def main():
            self.assertEqual(await ok(), 7)
            with self.assertRaises(RuntimeError):
                await f()
            o2 = RuntimeError("ctx")
            with self.assertRaises(RuntimeError):
                async with with_breakwire(base_url=S.url):
                    raise o2
            return o2
        o2 = asyncio.run(main())
        self.assertEqual(orig.breakwire.id, "AN-2026-0025")
        self.assertEqual(o2.breakwire.id, "AN-2026-0025")

    # ---- 0.2.0 ----
    def test_version(self):
        self.assertEqual(__version__, "0.2.0")

    def test_explain_no_log_default_and_cache(self):
        clear_cache()
        a = explain(ValueError("same text 020"), client=bw())
        b = explain(ValueError("same text 020"), client=bw())
        lookups = [c for c in S.calls if c["path"] == "/api/lookup"]
        self.assertEqual(len(lookups), 1)
        self.assertTrue(lookups[0]["body"]["no_log"])
        self.assertTrue(b.cached)
        self.assertFalse(a.cached)
        explain(ValueError("same text 020"), client=bw(), cache=False, no_log=False)
        lookups = [c for c in S.calls if c["path"] == "/api/lookup"]
        self.assertEqual(len(lookups), 2)
        self.assertNotIn("no_log", lookups[1]["body"])

    def test_failure_not_cached(self):
        clear_cache()
        S.mode = "500"
        self.assertIsNotNone(explain(ValueError("flaky 020"), client=bw()).error)
        S.mode = "ok"
        self.assertIsNone(explain(ValueError("flaky 020"), client=bw()).error)

    def test_subscribe_alerts_unsubscribe(self):
        B = bw()
        B.subscribe(files={"requirements.txt": "mcp==1.9.0\n"}, horizon_days=14)
        c = S.calls[-1]
        self.assertEqual((c["method"], c["path"]), ("POST", "/api/subscriptions"))
        self.assertEqual(c["body"], {"files": {"requirements.txt": "mcp==1.9.0\n"}, "horizon_days": 14})
        sid = "sub_" + "a" * 24
        B.alerts(sid)
        self.assertEqual(S.calls[-1]["path"], f"/api/subscriptions/{sid}/feed")
        B.unsubscribe(sid, "bwm_x")
        c = S.calls[-1]
        self.assertEqual(c["method"], "DELETE")
        self.assertEqual(c["headers"].get("authorization") or c["headers"].get("Authorization"), "Bearer bwm_x")
        with self.assertRaises(ValueError):
            B.alerts("nope")

    def test_verify_webhook_signature(self):
        import hashlib, hmac as _h
        t = str(int(time.time())); body = '{"type":"stack.alerts"}'
        sig = _h.new(b"whsec_t", f"{t}.{body}".encode(), hashlib.sha256).hexdigest()
        self.assertTrue(verify_webhook_signature("whsec_t", f"t={t},v1={sig}", body))
        self.assertFalse(verify_webhook_signature("whsec_t", f"t={t},v1={sig}", body + " "))
        self.assertFalse(verify_webhook_signature("other", f"t={t},v1={sig}", body))
        old = str(int(time.time()) - 1000)
        sig2 = _h.new(b"whsec_t", f"{old}.{body}".encode(), hashlib.sha256).hexdigest()
        self.assertFalse(verify_webhook_signature("whsec_t", f"t={old},v1={sig2}", body))
        self.assertFalse(verify_webhook_signature("whsec_t", None, body))

    def test_unknown_option_rejected(self):
        with self.assertRaises(TypeError):
            with_breakwire(servce="typo")


if __name__ == "__main__":
    unittest.main()
