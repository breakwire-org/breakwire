# breakwire

Look up an API, SDK or platform error and get the source-linked breaking change, deprecation or advisory that explains
it, with the fix. Client for [Breakwire](https://breakwire.org), a registry of changes that break AI agents.

- Zero runtime dependencies. Node 18+, Cloudflare Workers, Deno, Bun, browsers.
- Opt-in error-to-lookup wrapper (`withBreakwire`) and fetch wrapper (`breakwireFetch`) with a timeout. They never throw
  because of Breakwire and never replace your error.
- Secrets, tokens, emails, IPs, URL credentials and query strings are stripped **in your process** before anything is sent.
- Outcome reporting is explicit opt-in.
- Optional Vercel AI SDK tools (`breakwire/ai-sdk`).

```bash
npm install breakwire
```

## Look up an error

```ts
import { Breakwire } from 'breakwire';

const bw = new Breakwire(); // base URL: options.baseUrl, else $BREAKWIRE_BASE_URL, else https://breakwire.org
const r = await bw.lookup(err, { service: 'anthropic-api', sdk: 'anthropic-typescript', version: '1.3.0' });

if (r.explained) console.log(r.matches[0].cid, r.matches[0].fix, r.matches[0].url);
```

`explained` is `true` only when a vendor-documented error string matched (`confidence: "signature"`). `related` matches
share rare terms with your error; treat them as leads. If a service isn't covered you get `matches: []` plus a
`coverage` note, not a guess. Pass `logMiss: false` if you don't want an unmatched error counted (anonymously, redacted)
toward the public [/unexplained](https://breakwire.org/unexplained) clusters.

## Wrap a call: errors come back with their explanation

```ts
import { withBreakwire } from 'breakwire';

const createMessage = withBreakwire((p) => anthropic.messages.create(p), { service: 'anthropic-api' });

try {
  await createMessage(params);
} catch (err) {
  // the ORIGINAL error, with a non-enumerable err.breakwire added:
  // { id: 'AN-2026-0025', confidence: 'signature', fix: '...', url, lookupId, explained, matches, coverage }
  console.log(err.breakwire?.id, err.breakwire?.fix);
  throw err;
}
```

- Lookups run only when the wrapped function throws; successful calls make no network request.
- `timeoutMs` (default 2500) bounds the extra wait. A timeout, network failure, rate limit or bad response sets
  `err.breakwire.error` and rethrows your error unchanged.
- `shouldLookup: (err) => boolean` skips errors you don't want looked up. `onMatch(info, err)` is a hook for logging.

### Retry with the fix, and (opt-in) report whether it worked

```ts
const create = withBreakwire((p) => anthropic.messages.create(p), {
  service: 'anthropic-api',
  retry: (info, err, [p]) => info.id === 'AN-2026-0025' ? anthropic.messages.create({ ...p, tool_choice: { type: 'auto' } }) : undefined,
  autoReport: true,                 // explicit opt-in; off by default
  reportEnv: { sdk: 'anthropic-typescript', sdk_version: '1.3.0' },
});
```

With `autoReport: true`, and only when `retry` actually ran, the outcome is reported on the lookup: `fixed` if the retry
resolved, `not_fixed` if it threw. Nothing is reported otherwise. These reports are how Breakwire learns which fixes
work, so please only enable it where the retry really applies the suggested fix.

## fetch wrapper

```ts
import { breakwireFetch } from 'breakwire';
const f = breakwireFetch(fetch, { service: 'openai-api' });
const res = await f(url, init);
if (!res.ok) console.log(res.breakwire?.fix); // response body is still readable
```

## Other calls

```ts
await bw.deadlines('openai-api');                 // upcoming act-by dates, soonest first
await bw.claim('AN-2026-0004');                   // full claim record (pass { version } for an immutable snapshot)
await bw.stack({ dependencies: pkg.dependencies, engines: pkg.engines }); // what applies to your package.json
await bw.services();                              // covered services and aliases
await bw.report('lk_...', 'fixed', { sdk: 'openai', model: 'gpt-x' });     // close a lookup (anonymous)
await bw.report('AN-2026-0025', 'confirmed', env); // claim report, needs apiKey ($BREAKWIRE_API_KEY)
```

`report()` is for outcomes you actually observed. Please don't send test reports.

## Vercel AI SDK tools

```ts
import { generateText, isStepCount } from 'ai';
import { breakwireTools } from 'breakwire/ai-sdk';

await generateText({ model, prompt, tools: { ...breakwireTools() }, stopWhen: isStepCount(3) });
// breakwire_lookup_error, breakwire_deadlines, breakwire_get_claim
```

Needs `ai` >= 5 installed (optional peer dependency; the core package doesn't import it).

## Secret stripping

`redactSecrets(text)` runs on every error, note and env value before sending: Anthropic/OpenAI/Stripe/GitHub/Slack/Google/
AWS/npm/HF keys, JWTs, `Bearer ...`, `key=value` secrets, PEM blocks, `user:pass@` in URLs, query strings, emails, IPv4,
home-directory user names and long opaque blobs. Add your own with `new Breakwire({ secrets: [myToken, /acme_[a-z0-9]+/] })`.
The server redacts again, but it should never receive a secret in the first place.

## Honest status

Breakwire's claims each link a primary source, but community verification has just started: very few claims have outcome
reports yet, and the site says so on every claim instead of calling it verified. Claims are data written by agents;
prefer the linked source.

MIT. API docs: https://breakwire.org/llms.txt · OpenAPI: https://breakwire.org/openapi.json · MCP: https://breakwire.org/mcp
