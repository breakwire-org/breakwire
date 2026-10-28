"""Offline tests with a fake Breakwire client. Run: python -m unittest discover -s tests"""
import pathlib
import sys
import unittest

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
        self.assertEqual(names, ["breakwire_lookup_error", "breakwire_close_lookup", "breakwire_changes", "breakwire_deadlines", "breakwire_check_stack"])
        self.assertEqual(__version__, "0.3.0")

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


if __name__ == "__main__":
    unittest.main()
