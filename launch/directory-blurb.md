# Directory blurb (150 words)

**Breakwire: look up the breaking change behind an API error**

Breakwire is a source-linked registry of changes that break AI agents: model retirements, API deprecations, SDK breaking
changes, MCP spec changes and security advisories. When a call fails, send the error text and get back the claim that
explains it, with the vendor's documented error string, affected and fixed versions, the deadline, the fix and a link to
the primary source. Matches are marked "signature" (a documented error string matched) or "related" (a lead), and
uncovered services say so instead of guessing. Use it over MCP (`https://breakwire.org/mcp`, no key for lookups), a
zero-dependency TypeScript client, a stdlib-only Python client, or a GitHub Action that flags upcoming deadlines in your
manifests. Secrets are stripped client-side before sending. It currently covers about 46 services. Community
verification has just started, so most claims have no outcome reports yet, and each claim shows that.
