"""0.7.0: session_brief (local cursor, inject nothing when clear, fail-open), receipts, evidence_type, strict stack defaults."""
import json
import os
import pathlib
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import breakwire.client as bwc  # noqa: E402
from breakwire import EVIDENCE_TYPES, Breakwire, preview_stack  # noqa: E402
from test_v060 import FakeOpener  # noqa: E402

CLEAR = {"decision": "clear", "next_cursor": 42, "stack_fingerprint": "sha256:abc", "checked_at": "2026-10-29T00:00:00Z", "cache_for_seconds": 21600}
ACT = {"decision": "act", "next_cursor": 43, "stack_fingerprint": "sha256:abc", "items": [
    {"cid": "AN-2026-0001", "applies": "runtime_version", "why_now": "due in 5 days", "action": "Upgrade.", "source_url": "https://example.com/s"}]}


class SessionBrief(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "s.json")

    def test_clear_stores_cursor_and_then_sends_fingerprint_with_etag(self):
        def h(call, n):
            if n == 1:
                return 200, {}, CLEAR
            return 304, {"etag": '"e1"'}, None
        op = FakeOpener(h)
        with mock.patch.object(bwc, "_opener", op):
            b = Breakwire(base_url="https://breakwire.org")
            r1 = b.session_brief(state=self.path, services=["anthropic-api"], runtime={"node": "22"})
            self.assertEqual(r1["decision"], "clear")
            self.assertIsNone(r1["context"])
            self.assertEqual(op.calls[0]["body"]["services"], ["anthropic-api"])
            self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
            saved = list(json.load(open(self.path)).values())[0]
            self.assertEqual(saved["next_cursor"], 42)
            r2 = b.session_brief(state=self.path, services=["anthropic-api"], runtime={"node": "22"})
            self.assertEqual(op.calls[1]["body"], {"stack_fingerprint": "sha256:abc", "cursor": 42})
            self.assertEqual(r2["decision"], "clear")
            self.assertIsNone(r2["context"])
            self.assertTrue(r2.get("not_modified"))

    def test_act_gives_context_and_keeps_cursor(self):
        op = FakeOpener(lambda call, n: (200, {}, ACT))
        with mock.patch.object(bwc, "_opener", op):
            r = Breakwire(base_url="https://breakwire.org").session_brief(state=self.path, services=["x"])
        self.assertEqual(r["decision"], "act")
        self.assertIn("AN-2026-0001", r["context"])
        self.assertIn("https://example.com/s", r["context"])
        saved = list(json.load(open(self.path)).values())[0]
        self.assertIsNone(saved["next_cursor"])  # cursor advances only on clear

    def test_unknown_fingerprint_resends_stack(self):
        with open(self.path, "w") as fh:
            json.dump({}, fh)
        calls = {"n": 0}

        def h(call, n):
            calls["n"] = n
            return (400, {}, {"error": "unknown stack_fingerprint"}) if n == 1 else (200, {}, CLEAR)
        b = Breakwire(base_url="https://breakwire.org")
        op = FakeOpener(lambda c, n: (200, {}, CLEAR))
        with mock.patch.object(bwc, "_opener", op):
            b.session_brief(state=self.path, services=["x"])
        op2 = FakeOpener(h)
        with mock.patch.object(bwc, "_opener", op2):
            r = b.session_brief(state=self.path, services=["x"])
        self.assertEqual(r["decision"], "clear")
        self.assertEqual(op2.calls[1]["body"]["services"], ["x"])

    def test_fail_open(self):
        class Boom:
            def open(self, req, timeout=None):
                raise OSError("network down")
        with mock.patch.object(bwc, "_opener", Boom()):
            r = Breakwire(base_url="https://breakwire.org").session_brief(state=False, services=["x"])
        self.assertEqual(r["decision"], "unavailable")
        self.assertIsNone(r["context"])


class Receipts(unittest.TestCase):
    def test_receipt_report_goes_to_receipts(self):
        op = FakeOpener(lambda c, n: (200, {}, {"ok": True}))
        with mock.patch.object(bwc, "_opener", op):
            Breakwire(base_url="https://breakwire.org").report("rc_abc.def", "wrong_match", evidence_type="applicability_checked")
        self.assertTrue(op.calls[0]["url"].endswith("/api/receipts"))
        self.assertEqual(op.calls[0]["body"], {"receipt": "rc_abc.def", "outcome": "wrong_match", "evidence_type": "applicability_checked"})

    def test_bad_evidence_type_and_receipt_outcome(self):
        b = Breakwire(base_url="https://breakwire.org")
        with self.assertRaises(ValueError):
            b.report("lk_x", "fixed", evidence_type="vibes")
        with self.assertRaises(ValueError):
            b.report("rc_x", "solved")
        self.assertIn("remedy_tested", EVIDENCE_TYPES)


class StackDefaults(unittest.TestCase):
    def test_strict_compact_default_and_passthrough(self):
        op = FakeOpener(lambda c, n: (200, {}, {"ok": True}))
        with mock.patch.object(bwc, "_opener", op):
            Breakwire(base_url="https://breakwire.org").stack(packages=["npm:openai@4.0.0"], models=["gpt-4o", "https://x"],
                                                              features=["tool_choice:any"], installed={"openai": "4.0.0"})
        body = op.calls[0]["body"]
        self.assertTrue(body["strict"] and body["compact"])
        self.assertFalse(body["include_related"])
        self.assertEqual(body["models"], ["gpt-4o"])
        self.assertEqual(body["features"], ["tool_choice:any"])
        self.assertEqual(body["installed"], {"openai": "4.0.0"})
        self.assertNotIn("strict", preview_stack(packages=["npm:a@1"]))

    def test_strict_can_be_turned_off(self):
        op = FakeOpener(lambda c, n: (200, {}, {"ok": True}))
        with mock.patch.object(bwc, "_opener", op):
            Breakwire(base_url="https://breakwire.org").stack(packages=["npm:a@1"], strict=False, include_related=True)
        self.assertFalse(op.calls[0]["body"]["strict"])
        self.assertTrue(op.calls[0]["body"]["include_related"])


if __name__ == "__main__":
    unittest.main()
