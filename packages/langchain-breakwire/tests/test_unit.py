"""Offline tests with a fake Breakwire client. Run: python -m unittest discover -s tests"""
import pathlib
import sys
import unittest
from uuid import UUID

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT.parent / "python" / "src"))

from langchain_core.runnables import RunnableLambda  # noqa: E402
from breakwire import Breakwire  # noqa: E402
from langchain_breakwire import BreakwireCallbackHandler, BreakwireDeadlinesTool, BreakwireLookupTool, BreakwireStackTool, breakwire_tools, __version__  # noqa: E402

LOOKUP = {"lookup_id": "lk_x", "explained": True, "coverage": None,
          "matches": [{"cid": "AN-2026-0025", "title": "T", "confidence": "signature", "fix": "F", "url": "U", "source_url": "S", "deadline": None}]}


class Fake(Breakwire):
    def __init__(self, fail=False):
        super().__init__(base_url="http://fake.invalid")
        self.calls, self.fail = [], fail

    def lookup(self, error, **kw):
        self.calls.append(("lookup", str(error), kw))
        if self.fail:
            raise RuntimeError("down")
        return LOOKUP

    def stack(self, **kw):
        self.calls.append(("stack", None, kw))
        if not any(kw.values()):
            return {"empty": True, "hint": "send packages or files"}
        return {"applicable": [{"cid": "AN-2026-0080", "title": "Node 20 EOL", "deadline": "2026-04-30", "days_left": -181, "fix": "F", "url": "U"}],
                "subscribe": {"how": "POST /api/subscriptions"}, "remember": "R"}

    def deadlines(self, service=None, **kw):
        self.calls.append(("deadlines", service, kw))
        return [{"cid": "AN-2026-0004", "title": "D", "deadline": "2026-11-30", "fix": "F", "url": "U"}]


class T(unittest.TestCase):
    def test_session_brief_tool_clear_is_empty_and_act_has_items(self):
        from langchain_breakwire import BreakwireSessionBriefTool

        class B(Fake):
            def session_brief(self, **kw):
                self.calls.append(("brief", None, kw))
                if kw.get("services") == ["clear"]:
                    return {"decision": "clear", "next_cursor": 5, "context": None}
                return {"decision": "act", "items": [{"cid": "AN-2026-0080", "action": "A", "source_url": "U"}], "context": "x"}
        f = B()
        self.assertEqual(BreakwireSessionBriefTool(client=f).invoke({"services": ["clear"]}), {"decision": "clear"})
        out = BreakwireSessionBriefTool(client=f).invoke({"services": ["x"], "models": ["gpt-4o"]})
        self.assertEqual(out["items"][0]["cid"], "AN-2026-0080")
        self.assertEqual(f.calls[1][2]["models"], ["gpt-4o"])

    def test_stack_tool_reads_compact_items(self):
        class C(Fake):
            def stack(self, **kw):
                return {"decision": "act", "items": [{"cid": "AN-2026-0080", "bucket": "exactly_applies", "title": "T", "date": "2026-04-30",
                                                      "action": "Move to 22", "citation": "https://nodejs.org/x"}]}
        out = BreakwireStackTool(client=C()).invoke({"packages": ["node@20"]})
        self.assertEqual(out["decision"], "act")
        self.assertEqual(out["applicable"][0]["fix"], "Move to 22")
        self.assertEqual(out["applicable"][0]["url"], "https://nodejs.org/x")
        self.assertEqual(out["applicable"][0]["deadline"], "2026-04-30")

    def test_lookup_tool(self):
        f = Fake()
        t = BreakwireLookupTool(client=f)
        out = t.invoke({"error": "boom", "service": "anthropic-api"})
        self.assertEqual(out["matches"][0]["id"], "AN-2026-0025")
        self.assertEqual(f.calls[0][2]["service"], "anthropic-api")
        self.assertFalse(f.calls[0][2]["log_miss"])
        self.assertIn("error", t.args)

    def test_stack_tool_and_bundle(self):
        f = Fake()
        out = BreakwireStackTool(client=f).invoke({"packages": ["node@20"]})
        self.assertEqual(out["applicable"][0]["id"], "AN-2026-0080")
        self.assertEqual(out["remember"], "R")
        self.assertTrue(BreakwireStackTool(client=f).invoke({})["empty"])
        names = [t.name for t in breakwire_tools(client=f)]
        self.assertEqual(names, ["breakwire_session_brief", "breakwire_lookup_error", "breakwire_close_lookup", "breakwire_changes", "breakwire_deadlines", "breakwire_check_stack"])
        import re
        self.assertEqual(__version__, re.search(r'^version = "([^"]+)"', (ROOT / "pyproject.toml").read_text(), re.M).group(1))

    def test_callback_handler_no_log_default(self):
        f = Fake()
        h = BreakwireCallbackHandler(client=f)
        self.assertTrue(h.lookup["no_log"])

    def test_lookup_tool_never_raises(self):
        out = BreakwireLookupTool(client=Fake(fail=True)).invoke({"error": "boom"})
        self.assertIn("unavailable", out["error"])

    def test_deadlines_tool(self):
        out = BreakwireDeadlinesTool(client=Fake()).invoke({"service": "anthropic-api"})
        self.assertEqual(out[0]["deadline"], "2026-11-30")

    def test_callback_handler_once_per_exception(self):
        f = Fake()
        h = BreakwireCallbackHandler(service="openai-api", client=f)
        inner = RunnableLambda(lambda x: (_ for _ in ()).throw(ValueError("Error code: 429 organization_spend_limit_exceeded")))
        chain = RunnableLambda(lambda x: x) | inner
        with self.assertRaises(ValueError) as cm:
            chain.invoke("hi", config={"callbacks": [h]})
        self.assertEqual(cm.exception.breakwire.id, "AN-2026-0025")
        self.assertEqual(len([c for c in f.calls if c[0] == "lookup"]), 1)

    def test_callback_handler_never_masks(self):
        h = BreakwireCallbackHandler(client=Fake(fail=True))
        err = KeyError("x")
        with self.assertRaises(KeyError) as cm:
            RunnableLambda(lambda x: (_ for _ in ()).throw(err)).invoke(1, config={"callbacks": [h]})
        self.assertIs(cm.exception, err)
        self.assertIsNone(err.breakwire.id)

    def test_default_client_channel_tag(self):
        h = BreakwireCallbackHandler()
        self.assertEqual(h.client.channel, f"langchain-breakwire/{__version__}")
        self.assertEqual(breakwire_tools()[0].client.channel, f"langchain-breakwire/{__version__}")

    def test_stack_tool_sends_parsed_facts_only(self):
        import json as _json
        from unittest import mock
        import breakwire.client as bwc
        sent = []

        class Op:
            def open(self, req, timeout=None):
                sent.append(_json.loads(req.data))

                class R:
                    def read(self):
                        return b'{"applicable": []}'

                    def __enter__(self):
                        return self

                    def __exit__(self, *a):
                        return False
                return R()

        pkg = '{"name": "@acme/secret", "scripts": {"x": "curl https://deploy.internal"}, "dependencies": {"next": "16.0.1", "own": "file:../own"}}'
        with mock.patch.object(bwc, "_opener", Op()):
            out = BreakwireStackTool(client=Breakwire()).invoke({"files": {"package.json": pkg}})
        self.assertEqual(out["total"], 0)
        self.assertEqual(sent, [{"dependencies": {"next": "16.0.1"}, "strict": True, "compact": True, "include_related": False}])

    def test_callback_handler_forwards_every_lookup_option(self):
        import json as _json
        from unittest import mock
        import breakwire.client as bwc
        from breakwire import clear_cache
        clear_cache()
        sent = []

        class Op:
            def open(self, req, timeout=None):
                sent.append(_json.loads(req.data))

                class R:
                    def read(self):
                        return _json.dumps(LOOKUP).encode()

                    def __enter__(self):
                        return self

                    def __exit__(self, *a):
                        return False
                return R()

        with mock.patch.object(bwc, "_opener", Op()):
            h = BreakwireCallbackHandler(service="openai-api", client=Breakwire(), compact=True, min_score=0.4, max_matches=2, model="gpt-x")
            h.on_llm_error(ValueError("429 rate limited"), run_id=UUID(int=1))
        self.assertEqual({k: sent[0].get(k) for k in ("compact", "min_score", "max_matches", "model", "no_log")},
                         {"compact": True, "min_score": 0.4, "max_matches": 2, "model": "gpt-x", "no_log": True})


if __name__ == "__main__":
    unittest.main()
