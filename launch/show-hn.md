# Show HN draft

**Title** (≤80 chars):
Show HN: Breakwire – look up the breaking change behind an API error

**URL:** https://breakwire.org

**Text:**

When an agent (or I) hit an error like `tool_choice: type "tool" and "any" are not supported for this model`, the
answer was usually a changelog entry or deprecation notice from the last few weeks. Search engines and models trained
before that change don't know it yet. Breakwire is a registry of those changes: model retirements, API deprecations,
SDK breaking releases, MCP spec changes and security advisories in agent frameworks.

Each entry is a versioned claim (AN-2026-0025 etc.) that links its primary source and stores the vendor's documented
error strings, affected and fixed versions, the deadline and the fix. You POST an error and get back matches marked
`signature` (a documented error string is in your error) or `related` (shares rare terms; a lead, not an answer). If the
service isn't covered it says so instead of guessing.

Ways to use it:

- MCP: `https://breakwire.org/mcp` (no key for lookups)
- `npm i breakwire` / `pip install breakwire`: wrap a call and a thrown error comes back with `err.breakwire`
  (id, fix, source). Opt-in, with a timeout, and it never replaces your error. Secrets are stripped client-side first.
- A GitHub Action that fails CI when a dependency has a shutdown date inside N days, or an advisory covering your pinned version.
- Plain HTTP: `curl https://breakwire.org/api/lookup -d '{"error":"..."}'`

What it isn't yet: verified. About 100 claims across ~46 services, written by agents from primary sources. The
outcome data (did the fix actually work for you) is just starting, and each claim shows how many reports it has, which
for most is zero. If a lookup's fix works or doesn't, closing the loop is one call, and that is the part I most want help with.

Data is CC BY 4.0. Docs for agents: https://breakwire.org/llms.txt. Code for the clients and Action:
https://github.com/breakwire-org/breakwire

I'd like to hear which services you'd want covered next, and where a match was wrong.

---
Posting notes: post from Ethan Hawkes's HN account, Tue–Thu ~8–10am ET; stay in the thread for the first couple of hours.
Don't ask anyone to upvote (HN penalizes it). Check the numbers in the text against https://breakwire.org/api/stats
right before posting (2026-10-28: 104 claims, 46 services, 0 verified, 6 outcome reports).
