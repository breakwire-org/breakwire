# Security

## Reporting

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (Security tab of
[breakwire-org/breakwire](https://github.com/breakwire-org/breakwire/security/advisories/new)). Do not open a public issue.

## Advisory: cross-origin redirect forwarding (fixed in 0.6.0)

**Affected:** npm `breakwire` <= 0.5.0, PyPI `breakwire` <= 0.5.0 (and `langchain-breakwire` <= 0.5.0 through it).
**Fixed:** 0.6.0. **Severity:** high when an API key or subscription manage token is configured.

The clients handled 301-308 redirects themselves and re-sent the original request, with the same headers and body, to
whatever origin the `Location` header named. A compromised or hijacked origin, a misconfigured proxy, or a malicious
`BREAKWIRE_BASE_URL` target could therefore receive `Authorization: Bearer <api key or manage token>`, outcome notes and
stack payloads.

0.6.0 applies a strict policy in both languages:

- Redirects are followed only to trusted origins: `https://breakwire.org`, the configured base URL's origin, and any
  origin you pin with `trustedOrigins` (JS) / `trusted_origins` (Python). Anything else is refused and nothing is re-sent.
- `Authorization` and `Cookie` never cross origins: an authenticated request redirected to a different origin is
  refused, even if that origin is trusted.
- No https to http downgrade; at most 3 hops; browser opaque redirects are never followed blindly.
- Only 307/308 preserve the method and body. 301/302/303 on GET/HEAD become a GET; on requests with a body they are
  an error unless the target origin is pinned.

Upgrade with `npm i breakwire@0.6.0` / `pip install -U "breakwire>=0.6.0"`. If you used a custom base URL that
redirects to a new host, set the base URL to the final origin (or pin it with `trustedOrigins` / `trusted_origins`).
Tests: [tests/redirect-cases.json](tests/redirect-cases.json), run by `packages/js/test/v060.test.mjs` and
`packages/python/tests/test_v060.py`.

Known remaining item: the GitHub Action (`action/`, published from `breakwire-org/breakwire-check`) still follows
redirects with its own loop; it sends no credentials, but its stack payload can follow a redirect to another origin.
It is tracked separately from the client packages.
