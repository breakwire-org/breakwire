"""Breakwire: look up an API/SDK error and get the source-linked change that explains it, with the fix.

    from breakwire import Breakwire, with_breakwire
    bw = Breakwire()                      # base_url defaults to $BREAKWIRE_BASE_URL or https://breakwire.org
    r = bw.lookup(exc, service="anthropic-api", log_miss=False)
"""
from ._redact import is_secret_key, redact_secrets
from ._stack import normalize_requirement, normalize_stack
from .client import (DEFAULT_BASE_URL, EVIDENCE_TYPES, LOOKUP_OUTCOMES, RECEIPT_OUTCOMES, Breakwire, BreakwireError, __version__,
                     error_text, preview_redaction, preview_stack, verify_webhook_signature)
from .wrap import SKIP, BreakwireInfo, clear_cache, explain, with_breakwire

__all__ = ["Breakwire", "BreakwireError", "BreakwireInfo", "DEFAULT_BASE_URL", "SKIP", "error_text", "explain",
           "redact_secrets", "with_breakwire", "verify_webhook_signature", "clear_cache", "__version__",
           "preview_redaction", "preview_stack", "normalize_stack", "normalize_requirement", "is_secret_key",
           "EVIDENCE_TYPES", "LOOKUP_OUTCOMES", "RECEIPT_OUTCOMES"]
