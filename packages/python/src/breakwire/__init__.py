"""Breakwire: look up an API/SDK error and get the source-linked change that explains it, with the fix.

    from breakwire import Breakwire, with_breakwire
    bw = Breakwire()                      # base_url defaults to $BREAKWIRE_BASE_URL or https://breakwire.org
    r = bw.lookup(exc, service="anthropic-api", log_miss=False)
"""
from ._redact import redact_secrets
from .client import DEFAULT_BASE_URL, Breakwire, BreakwireError, __version__, error_text
from .wrap import SKIP, BreakwireInfo, explain, with_breakwire

__all__ = ["Breakwire", "BreakwireError", "BreakwireInfo", "DEFAULT_BASE_URL", "SKIP", "error_text", "explain",
           "redact_secrets", "with_breakwire", "__version__"]
