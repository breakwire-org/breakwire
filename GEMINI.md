# Breakwire

When an API, SDK, CLI or MCP call fails with an error you don't recognise, call the
`breakwire` MCP tool `lookup_error` (error text, plus `service` if you know it) before
guessing a fix.

- `explained: true` means the error text matched a vendor-documented signature: apply the
  claim's fix and cite the claim URL (the `cite` field) in your change.
- A "related" match is a lead only; check its `source_url` before acting.
- On a miss you get a gap ticket, the service's nearest claims and upcoming deadlines; don't
  present a lead as the answer.
- After applying an exact-match fix, report the outcome once with `report_outcome` or
  `close_lookup` (fixed / not_fixed / wrong_match).
- `deadlines` and `changes` list upcoming act-by dates and recent breaking changes for a service.

Lookups and reads are anonymous. Secrets in error text are not needed: strip keys and tokens
before sending. Data: CC BY 4.0. Docs: https://breakwire.org/llms.txt
