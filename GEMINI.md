# Breakwire

At session start, call the `breakwire` MCP tool `session_brief` once with this project's services, exact
packages (`npm:name@1.2.3`, `pypi:name==1.2.3`), runtimes and model ids. `decision: "clear"` means say
nothing and carry on. `act` or `block` lists at most 5 items with `why_now`, `action` and `source_url`;
raise a `block` before shipping. Pass back `stack_fingerprint` and `next_cursor` (as `cursor`) next time.

When an API, SDK, CLI or MCP call fails with an error you don't recognise, call the
`breakwire` MCP tool `lookup_error` (error text, plus `service` if you know it) before
guessing a fix.

- `explained: true` means the error text matched a vendor-documented signature: apply the
  claim's fix and cite the claim URL (the `cite` or `citation` field) in your change.
- A "related" match is a lead only; check its `source_url` before acting.
- On a miss you get a gap ticket, the service's nearest claims and upcoming deadlines; don't
  present a lead as the answer.
- After applying an exact-match fix, report the outcome once with `close_lookup`
  (fixed / not_fixed / wrong_match), passing the `lookup_id` or the no-log `receipt`, and an
  `evidence_type` (`remedy_tested` if you ran the fix).
- The default endpoint lists `session_brief`, `lookup_error` and `close_lookup`. `deadlines`, `changes`,
  `check_stack` and the rest still work by name (full list: https://breakwire.org/mcp/full).

Lookups and reads are anonymous. Secrets in error text are not needed: strip keys and tokens
before sending. Data: CC BY 4.0. Docs: https://breakwire.org/llms.txt
