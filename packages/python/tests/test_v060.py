"""0.6.0 security and correctness tests (offline). Shared fixtures in ../../tests/ are run by the JS client too.
Run: python -m unittest discover -s tests"""
import asyncio
import email.message
import inspect
import io
import json
import pathlib
import sys
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
import breakwire.client as bwc  # noqa: E402
from breakwire import (SKIP, Breakwire, BreakwireError, clear_cache, explain, normalize_stack, preview_redaction,  # noqa: E402
                       preview_stack, redact_secrets, with_breakwire)
from breakwire.wrap import _LOOKUP_KEYS  # noqa: E402

FIX = pathlib.Path(__file__).resolve().parents[3] / "tests"
REDIRECTS = json.loads((FIX / "redirect-cases.json").read_text())
STACK = json.loads((FIX / "stack-cases.json").read_text())
CONTRACT = json.loads((FIX / "lookup-contract.json").read_text())
MATCH = {"cid": "AN-2026-0025", "title": "T", "confidence": "signature", "fix": "F", "url": "U", "deadline": None}
NOLOG = {"lookup_id": None, "explained": True, "coverage": None, "matches": [MATCH]}
LOGGED = {**NOLOG, "lookup_id": "lk_abc123"}


class _Resp:
    def __init__(self, obj):
        self._b = json.dumps(obj).encode()

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeOpener:
    """Stands in for urllib's opener: records each request; handler(call, n) -> (status, headers, body)."""

    def __init__(self, handler):
        self.calls, self.handler = [], handler

    def open(self, req, timeout=None):
        headers = {k.lower(): v for k, v in req.header_items()}
        call = {"url": req.full_url, "method": req.get_method(), "headers": headers,
                "raw": req.data, "body": json.loads(req.data) if req.data else None}
        self.calls.append(call)
        status, hdrs, body = self.handler(call, len(self.calls))
        if status >= 300:
            m = email.message.Message()
            for k, v in (hdrs or {}).items():
                m[k] = v
            raise urllib.error.HTTPError(req.full_url, status, "x", m, io.BytesIO(json.dumps(body or {}).encode()))
        return _Resp(body)


def _origin(u):
    return bwc._origin(u)


class Redirects(unittest.TestCase):
    def test_shared_redirect_cases(self):
        for c in REDIRECTS["cases"]:
            with self.subTest(c["name"]):
                op = FakeOpener(lambda call, n, c=c: (c["redirect"]["status"], {"location": c["redirect"]["location"]}, None) if n == 1 else (200, {}, {"ok": True}))
                with mock.patch.object(bwc, "_opener", op):
                    b = Breakwire(base_url=c["base_url"], api_key=REDIRECTS["api_key"], trusted_origins=c.get("trusted_origins"))
                    rq = c["request"]
                    call = lambda: b.request(rq["method"], rq["path"], rq["body"], auth=rq["auth"] == "api_key",  # noqa: E731
                                             bearer=REDIRECTS["bearer"] if rq["auth"] == "bearer" else None)
                    if not c["expect"]["follow"]:
                        with self.assertRaises(BreakwireError) as cm:
                            call()
                        self.assertIn("refused", str(cm.exception))
                        self.assertEqual(len(op.calls), 1, "nothing is re-sent")
                    else:
                        self.assertEqual(call(), {"ok": True})
                        self.assertEqual(len(op.calls), 2)
                        second = op.calls[1]
                        self.assertEqual(second["url"], c["expect"]["url"])
                        self.assertEqual(second["method"], c["expect"]["method"])
                        self.assertEqual(second["body"] is not None, c["expect"]["body_kept"])
                        self.assertEqual("authorization" in second["headers"], c["expect"]["auth_kept"])
                base = _origin(c["base_url"])
                for x in op.calls:
                    if _origin(x["url"]) == base:
                        continue
                    dump = json.dumps({**x, "raw": (x["raw"] or b"").decode()})
                    self.assertNotIn(REDIRECTS["api_key"], dump, f"credential crossed to {x['url']}")
                    self.assertNotIn(REDIRECTS["bearer"], dump)
                    self.assertNotIn("authorization", x["headers"])
                    self.assertNotIn("cookie", x["headers"])

    def test_explain_fails_open_on_attacker_redirect(self):
        op = FakeOpener(lambda call, n: (307, {"location": "https://attacker.example/x"}, None) if n == 1 else (200, {}, LOGGED))
        with mock.patch.object(bwc, "_opener", op):
            info = explain(ValueError("boom"), client=Breakwire(), cache=False)
        self.assertIn("refused 307 redirect to https://attacker.example", info.error)
        self.assertEqual(len(op.calls), 1)

    def test_too_many_hops(self):
        op = FakeOpener(lambda call, n: (307, {"location": f"/hop{n}"}, None))
        with mock.patch.object(bwc, "_opener", op):
            with self.assertRaises(BreakwireError) as cm:
                Breakwire().request("GET", "/api/services")
        self.assertIn("too many redirects", str(cm.exception))
        self.assertEqual(len(op.calls), 4)

    def test_trusted_origins_default(self):
        self.assertEqual(Breakwire(base_url="https://x.test/sub").trusted_origins, frozenset({"https://breakwire.org", "https://x.test"}))


class NoLogRetry(unittest.TestCase):
    def setUp(self):
        clear_cache()

    def _op(self, lookup):
        return FakeOpener(lambda call, n: (200, {}, lookup if call["url"].endswith("/api/lookup") else {"ok": True}))

    def test_sync_retry_runs_without_lookup_id(self):
        op, seen = self._op(NOLOG), []
        with mock.patch.object(bwc, "_opener", op):
            @with_breakwire(retry=lambda info, exc, *a, **k: seen.append(info) or "retried", add_note=False)
            def f():
                raise ValueError("tool_choice any not supported")
            self.assertEqual(f(), "retried")
        self.assertEqual(len(seen), 1)
        self.assertIsNone(seen[0].lookup_id)
        self.assertEqual(seen[0].id, "AN-2026-0025")
        self.assertEqual(len(op.calls), 1)
        self.assertTrue(op.calls[0]["body"]["no_log"])

    def test_async_retry_runs_without_lookup_id(self):
        op = self._op(NOLOG)

        async def retry(info, exc, *a, **k):
            return "async-retried"

        with mock.patch.object(bwc, "_opener", op):
            @with_breakwire(retry=retry, add_note=False)
            async def f():
                raise ValueError("x async")
            self.assertEqual(asyncio.run(f()), "async-retried")
        self.assertEqual(len(op.calls), 1)

    def test_failing_retry_reraises_original_and_no_report_without_lookup_id(self):
        op = self._op(NOLOG)
        orig = ValueError("original")

        def retry(info, exc, *a, **k):
            raise RuntimeError("still failing")

        with mock.patch.object(bwc, "_opener", op):
            @with_breakwire(retry=retry, auto_report=True, no_log=True, add_note=False)
            def f():
                raise orig
            with self.assertRaises(ValueError) as cm:
                f()
        self.assertIs(cm.exception, orig)
        self.assertEqual(len(op.calls), 1, "only the lookup, no outcome report")

    def test_logged_auto_report_still_reports(self):
        op = self._op(LOGGED)
        with mock.patch.object(bwc, "_opener", op):
            @with_breakwire(retry=lambda *a, **k: "ok", auto_report=True, add_note=False)
            def f():
                raise ValueError("x logged")
            self.assertEqual(f(), "ok")
        self.assertTrue(op.calls[1]["url"].endswith("/api/lookups/lk_abc123/outcome"))
        self.assertEqual(op.calls[1]["body"]["outcome"], "fixed")

    def test_skip_and_no_match(self):
        op = self._op({**NOLOG, "matches": []})
        ran = []
        with mock.patch.object(bwc, "_opener", op):
            @with_breakwire(retry=lambda *a, **k: ran.append(1), add_note=False)
            def f():
                raise ValueError("x nomatch")
            with self.assertRaises(ValueError):
                f()
        self.assertEqual(ran, [])
        op2 = self._op(NOLOG)
        with mock.patch.object(bwc, "_opener", op2):
            @with_breakwire(retry=lambda *a, **k: SKIP, add_note=False)
            def g():
                raise ValueError("x skip")
            with self.assertRaises(ValueError):
                g()


ISO = [
    ("cross-model", {"model": "model-a"}, {"model": "model-b"}),
    ("cross-sdk", {"sdk": "openai-python"}, {"sdk": "anthropic-python"}),
    ("sdk version", {"version": "1.0.0"}, {"version": "2.0.0"}),
    ("min_score threshold", {"min_score": 0.2}, {"min_score": 0.9}),
    ("max_matches", {"max_matches": 1}, {"max_matches": 5}),
    ("compact", {}, {"compact": True}),
    ("http status", {"http_status": 400}, {"http_status": 429}),
    ("cross_service", {}, {"cross_service": True}),
    ("context", {"context": "a"}, {"context": "b"}),
    ("since", {"since": "2026-01-01"}, {"since": "2026-06-01"}),
    ("service", {"service": "openai-api"}, {"service": "anthropic-api"}),
]


class CacheIsolation(unittest.TestCase):
    def test_isolation(self):
        for name, a, b in ISO:
            with self.subTest(name):
                clear_cache()
                op = FakeOpener(lambda call, n: (200, {}, {**NOLOG, "matches": [{**MATCH, "title": json.dumps(call["body"], sort_keys=True)}]}))
                with mock.patch.object(bwc, "_opener", op):
                    c = Breakwire()
                    r1 = explain(ValueError("same text"), client=c, **a)
                    r2 = explain(ValueError("same text"), client=c, **b)
                    self.assertEqual(len(op.calls), 2, "different options must not share a cached answer")
                    self.assertNotEqual(r1.title, r2.title)
                    self.assertFalse(r2.cached)
                    r3 = explain(ValueError("same text"), client=c, **a)
                    self.assertEqual(len(op.calls), 2)
                    self.assertTrue(r3.cached)
                    self.assertEqual(r3.title, r1.title)

    def test_wrapper_isolation_cross_model(self):
        clear_cache()
        op = FakeOpener(lambda call, n: (200, {}, {**NOLOG, "matches": [{**MATCH, "title": call["body"].get("model")}]}))
        got = []
        with mock.patch.object(bwc, "_opener", op):
            for model in ("model-a", "model-b"):
                @with_breakwire(model=model, on_match=lambda info, exc: got.append(info.title), add_note=False)
                def f():
                    raise ValueError("identical error")
                with self.assertRaises(ValueError):
                    f()
        self.assertEqual(got, ["model-a", "model-b"])


class Stack(unittest.TestCase):
    def test_shared_stack_cases(self):
        for c in STACK:
            with self.subTest(c["name"]):
                r = normalize_stack(c["input"])
                self.assertEqual(r["body"], c["expect"])
                s = json.dumps(r["body"])
                for a in c.get("absent", []):
                    self.assertNotIn(a, s)
                if "ignored" in c:
                    self.assertEqual(r["ignored"], c["ignored"])

    def test_stack_sends_parsed_facts_raw_is_opt_in_preview_matches(self):
        op = FakeOpener(lambda call, n: (200, {}, {"ok": True}))
        files = STACK[0]["input"]["files"]
        with mock.patch.object(bwc, "_opener", op):
            b = Breakwire()
            b.stack(files=files)
            self.assertEqual(op.calls[0]["body"], preview_stack(files=files))
            self.assertEqual(op.calls[0]["body"], b.preview_stack(files=files))
            self.assertNotIn("files", op.calls[0]["body"])
            self.assertNotIn(b"scripts", op.calls[0]["raw"])
            b.stack(files=files, raw_files=True)
            self.assertEqual(op.calls[1]["body"], {"files": files})
            self.assertEqual(preview_stack(files=files, raw_files=True), {"files": files})
            b.stack(dependencies={"next": "16.0.1", "x": "file:../x"}, packages=["pypi:mcp==1.9.0"], services=["stripe-api"])
            self.assertEqual(op.calls[2]["body"], {"dependencies": {"next": "16.0.1"}, "packages": ["pypi:mcp==1.9.0"], "services": ["stripe-api"]})

    def test_subscribe_and_update_parse_locally(self):
        op = FakeOpener(lambda call, n: (200, {}, {"id": "sub_" + "a" * 24}))
        with mock.patch.object(bwc, "_opener", op):
            b = Breakwire()
            b.subscribe(files={"requirements.txt": "mcp==1.9.0\n--index-url https://u:p@x.internal/simple\n"}, horizon_days=14, launches=True)
            self.assertEqual(op.calls[0]["body"], {"requirements": "mcp==1.9.0", "horizon_days": 14, "launches": True})
            b.update_subscription("sub_" + "a" * 24, "bwm_x", files={".nvmrc": "22"}, webhook_url=None, horizon_days=7)
            self.assertEqual(op.calls[1]["body"], {"runtime": {"node": "22"}, "webhook_url": None, "horizon_days": 7})


class Redaction(unittest.TestCase):
    def test_preview_matches_what_lookup_sends(self):
        op = FakeOpener(lambda call, n: (200, {}, NOLOG))
        e = ValueError("ENOENT open /srv/acme/x/y.json from 2001:db8::1 token my-own-literal req_011CPXa9bTzR8vQ2")
        with mock.patch.object(bwc, "_opener", op):
            b = Breakwire(secrets=["my-own-literal"])
            b.lookup(e)
        self.assertEqual(op.calls[0]["body"]["error"], b.preview_redaction(e))
        self.assertNotIn("my-own-literal", b.preview_redaction(e))
        self.assertEqual(preview_redaction("plain sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx"), "plain <secret>")
        self.assertEqual(preview_redaction({"apiKey": "v", "ok": 1}), '{"apiKey":"<secret>","ok":1}')
        self.assertEqual(redact_secrets({"apiKey": "v"}), '{"apiKey":"<secret>"}')


class Contract(unittest.TestCase):
    def test_wrapper_options_derive_from_client_signature(self):
        params = [n for n in inspect.signature(Breakwire.lookup).parameters if n not in ("self", "error")]
        self.assertEqual(list(_LOOKUP_KEYS), params)
        for k in ("compact", "min_score", "max_matches", "since", "reflex"):
            self.assertIn(k, _LOOKUP_KEYS)
        with self.assertRaises(TypeError):
            with_breakwire(servce="typo")

    def test_contract_covers_every_python_lookup_option(self):
        covered = {k for c in CONTRACT for k in c["py"]}
        self.assertEqual(covered, set(_LOOKUP_KEYS))

    def test_every_option_reaches_the_wire(self):
        for c in CONTRACT:
            with self.subTest(list(c["py"])[0]):
                op = FakeOpener(lambda call, n: (200, {}, NOLOG))
                with mock.patch.object(bwc, "_opener", op):
                    @with_breakwire(add_note=False, **c["py"])
                    def f():
                        raise ValueError("contract")
                    with self.assertRaises(ValueError):
                        f()
                    with with_breakwire(add_note=False, **c["py"]):
                        try:
                            raise ValueError("contract cm")
                        except ValueError:
                            pass
                    explain(ValueError("contract"), client=Breakwire(), cache=False, **c["py"])
                    Breakwire().lookup("contract", **c["py"])
                for call in op.calls:
                    for k, v in c["wire"].items():
                        self.assertEqual(call["body"].get(k), v, f"{k} missing in {call['body']}")


if __name__ == "__main__":
    unittest.main()
