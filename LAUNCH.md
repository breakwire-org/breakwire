# Breakwire launch checklist

Everything here is built and tested; nothing has been published. Do the steps **in order** (later steps link to earlier
ones). Each step: what it needs, the exact commands, how to check it worked. Entry texts for every directory are in
[directories/ENTRIES.md](directories/ENTRIES.md).

GitHub home: **github.com/breakwire-org**. Two repos:
- `breakwire-org/breakwire`: this whole kit (clients, MCP docs, snippets, directory files, assets). Link target everywhere.
- `breakwire-org/breakwire-check`: the GitHub Action only (Marketplace needs `action.yml` at the repo root; users write
  `uses: breakwire-org/breakwire-check@v1`). Created from `action/` with `git subtree split`.

| # | Step | Account needed | Depends on |
|---|---|---|---|
| 0 | Pre-flight checks | none | |
| 1 | Push repos to GitHub | GitHub, admin of `breakwire-org` | |
| 2 | MCP Registry: DNS TXT + `mcp-publisher` | Cloudflare (breakwire.org zone) | |
| 3 | Action: tag v1 (+ optional Marketplace) | GitHub `breakwire-org` | 1 |
| 4 | npm: `breakwire` | npm account with 2FA | 1 |
| 5 | PyPI: `breakwire`, then `langchain-breakwire` | PyPI account with 2FA + API token | 1 |
| 6 | Glama claim → awesome-remote-mcp-servers PR | Glama (GitHub login), GitHub | 2 |
| 7 | mcp.so, mcpservers.org, Cline, Docker catalog | GitHub; an email for mcpservers.org | 1, 2 |
| 8 | Vercel AI SDK registry PR, LangChain listing issue | GitHub | 4, 5 |
| 9 | Show HN, X post | HN account, X account | 1–5 |

Name availability checked 2026-10-28: npm `breakwire` and `breakwire-check` free, PyPI `breakwire` and
`langchain-breakwire` free, MCP Registry has no `org.breakwire/*` server. GitHub user/org `breakwire` is taken by
someone else (hence `breakwire-org`).

---

## 0. Pre-flight (box, no accounts)

```bash
cd /workspace/breakwire-kit
git status                         # clean, everything committed
git grep -nE 'sk-ant-|sk-proj-|BEGIN [A-Z ]*PRIVATE KEY|wire-editor' -- . ':!tests' ':!packages/*/test*' ':!*redact*' ':!LAUNCH.md' || echo "no secrets"   # matches in tests/ and redact sources are fake fixtures
(cd packages/js && npm ci && npm test)
(cd packages/python && python3 -m unittest discover -s tests)
(cd action && npm test)
/tmp/mcpp/mcp-publisher validate mcp/server.json
curl -s https://breakwire.org/api/stats      # refresh the numbers quoted in launch/show-hn.md
```
Also decide: the MIT copyright line says `Ho Hum` (LICENSE files); `author` in package metadata says `Ho Hum`. Change
both if it should be a company name. Replace `assets/logo*` if you have a real logo (current one is a simple placeholder:
a broken orange wire with a spark).

## 1. GitHub repos (account: GitHub, owner/admin of `breakwire-org`)

```bash
cd /workspace/breakwire-kit
gh auth login                                            # or use the GitHub connector / web UI
gh repo create breakwire-org/breakwire --public \
  --description "Clients, MCP config and CI check for Breakwire, the source-linked registry of breaking changes" \
  --homepage https://breakwire.org --source . --remote origin --push

# Action repo from the action/ subfolder (keeps its history)
git subtree split --prefix action -b action-only
gh repo create breakwire-org/breakwire-check --public \
  --description "GitHub Action: fail CI on near deadlines and advisories for your dependencies (Breakwire)" \
  --homepage https://breakwire.org
git push https://github.com/breakwire-org/breakwire-check.git action-only:main
gh repo edit breakwire-org/breakwire --add-topic mcp,mcp-server,ai-agents,breaking-changes,deprecations,api
```
Check: https://github.com/breakwire-org/breakwire renders README; `assets/logo-64.png` loads at
https://raw.githubusercontent.com/breakwire-org/breakwire/main/assets/logo-64.png (the Docker entry uses it).

## 2. Official MCP Registry with DNS auth (account: Cloudflare, zone breakwire.org)

Namespace `org.breakwire/*` is proven by an Ed25519 public key in a TXT record on the **apex** `breakwire.org`
(per registry docs `authentication.mdx`, read 2026-10-28; not `_mcp-auth`). Needs OpenSSL 3 (macOS: `brew install openssl@3`).

```bash
# 2a. install mcp-publisher (v1.8.6 is latest)
brew install mcp-publisher   # or:
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/

# 2b. key pair (private key kept OUTSIDE the repo, chmod 600; back it up in the password manager)
cd mcp && ./registry-dns.sh keygen
#   equivalent raw commands:
#   openssl genpkey -algorithm Ed25519 -out key.pem
#   PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
#   echo "breakwire.org. IN TXT \"v=MCPv1; k=ed25519; p=${PUBLIC_KEY}\""
```

2c. Add the TXT record. **The exact record** (public key filled in by `./registry-dns.sh txt`):

| Type | Name | Content | TTL | Proxy |
|---|---|---|---|---|
| TXT | `@` (breakwire.org) | `v=MCPv1; k=ed25519; p=<PUBLIC_KEY>` | Auto/300 | n/a |

Cloudflare dashboard → breakwire.org → DNS → Records → Add record, or the API (zone id `0bb0adfbdaa6323ac36801cb5ff90a9f`;
a token with Zone.DNS:Edit; the parent can also do this through the Cloudflare connector):
```bash
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/0bb0adfbdaa6323ac36801cb5ff90a9f/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" \
  -d "{\"type\":\"TXT\",\"name\":\"breakwire.org\",\"content\":\"\\\"v=MCPv1; k=ed25519; p=${PUBLIC_KEY}\\\"\",\"ttl\":300,\"comment\":\"MCP Registry namespace org.breakwire\"}"
```
(There is no apex TXT today, so nothing conflicts. When rotating keys later, delete the old record.)

```bash
# 2d. wait until public resolvers see it, then log in and publish
./registry-dns.sh check            # dns.google and 1.1.1.1 should print v=MCPv1...
./registry-dns.sh login            # = mcp-publisher login dns --domain breakwire.org --private-key "$PRIVATE_KEY"
./registry-dns.sh publish          # = mcp-publisher validate server.json && mcp-publisher publish
./registry-dns.sh verify           # = curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=org.breakwire/breakwire"
```
Notes: `version` in server.json (`0.3.2`, the worker's version) can never be reused; bump it for each re-publish.
The registry doesn't probe the endpoint, but directories that ingest it do, so keep `/mcp` up. A remote URL can belong
to only one server name. Optional later: add `"repository": {"url": "https://github.com/breakwire-org/breakwire", "source": "github"}`
only if the server source becomes public there (the kit repo is clients, not the server, so I left it out).

## 3. GitHub Action release (account: GitHub `breakwire-org`)

```bash
git clone https://github.com/breakwire-org/breakwire-check && cd breakwire-check
git tag -a v1.0.0 -m "breakwire-check v1.0.0" && git tag v1 && git push origin v1.0.0 v1
gh release create v1.0.0 --title "v1.0.0" --notes "First release. Fails on Breakwire deadlines within N days and advisories covering pinned/locked versions; never fails on a Breakwire outage unless fail-on-api-error is set."
```
Optional Marketplace: on the release page tick **Publish this Action to the GitHub Marketplace** (first time: accept the
Marketplace developer agreement and enable 2FA on the account), category *Continuous integration* / *Dependency management*.
The name `Breakwire stack check` must be unique on Marketplace.
Check: in any repo, the workflow in `action/examples/breakwire.yml` runs (it uses `breakwire-org/breakwire-check@v1`).

## 4. npm: `breakwire` (account: npm, 2FA on)

```bash
cd packages/js
npm login                       # as the account that should own the package
npm ci && npm test && npm pack --dry-run     # 24 files, ~18 kB
npm publish --access public     # prompts for OTP
```
Optional: enable provenance later by publishing from GitHub Actions with `npm publish --provenance`.
Check: `npm view breakwire version` → 0.1.0; `npx -y -p breakwire node -e "require('breakwire')"`.

## 5. PyPI: `breakwire`, then `langchain-breakwire` (account: PyPI, 2FA, API token)

```bash
python3 -m pip install --upgrade build twine
cd packages/python && rm -rf dist && python3 -m build && twine check dist/* && twine upload dist/*   # user __token__, pw pypi-...
cd ../langchain-breakwire && rm -rf dist && python3 -m build && twine check dist/* && twine upload dist/*
```
`langchain-breakwire` depends on `breakwire>=0.1.0`, so upload `breakwire` first.
Optional: TestPyPI dry run with `twine upload -r testpypi dist/*`. Later: PyPI Trusted Publishing from the GitHub repo.
Check: `pip install breakwire langchain-breakwire` in a fresh venv.

## 6. Glama, then awesome-remote-mcp-servers (accounts: Glama via GitHub login; GitHub)

1. A day or so after step 2, open https://glama.ai/mcp/connectors/org.breakwire/breakwire (or add it manually, ENTRIES §2).
2. Claim it: Glama gives a token → TXT `_glama-claim.breakwire.org` in Cloudflare, or `/.well-known/glama.json` on the site.
3. Check the badge loads: https://glama.ai/mcp/connectors/org.breakwire/breakwire/badges/score.svg
4. Star https://github.com/punkpeye/awesome-remote-mcp-servers (their CI checks), fork, add the 3-line entry from
   ENTRIES §4 after `BotKelp` in 🛠️ Developer Tools, open PR "Add Breakwire".
   (Their CONTRIBUTING asks "automated agents" to put 🤖🤖🤖 in the title; see the note in ENTRIES §4.)

## 7. Other MCP directories

| Directory | How | Entry |
|---|---|---|
| mcp.so | https://mcp.so/submit (Remote Server) or issue on chatmcp/mcpso | ENTRIES §5 |
| mcpservers.org (= wong2/awesome-mcp-servers) | https://mcpservers.org/submit, needs a contact email | ENTRIES §6 |
| Cline marketplace | issue form, upload `assets/logo-400.png`; test with Cline first using `llms-install.md` | ENTRIES §7 |
| Docker MCP catalog | fork docker/mcp-registry, copy `directories/docker-mcp-registry/servers/breakwire/` to `servers/breakwire/`, PR | ENTRIES §8 |
| PulseMCP, GitHub/VS Code MCP list | automatic from step 2 | ENTRIES §3, §9 |
| modelcontextprotocol/servers | no longer lists community servers: skip | ENTRIES §10 |
| Smithery | skip (shutting down Oct 31) | |

Docker commands:
```bash
gh repo fork docker/mcp-registry --clone && cd mcp-registry && git checkout -b add-breakwire
cp -r /path/to/breakwire/directories/docker-mcp-registry/servers/breakwire servers/
git add servers/breakwire && git commit -m "Add Breakwire remote MCP server" && git push -u origin add-breakwire
gh pr create --title "Add Breakwire remote MCP server" --body "Remote (streamable-http, no auth) server at https://breakwire.org/mcp. Docs: https://github.com/breakwire-org/breakwire/blob/main/mcp/CLIENTS.md"
```

## 8. Framework lists (after npm/PyPI are live)

- **Vercel AI SDK Tools Registry** (accepts PRs): fork vercel/ai, append `directories/vercel-ai-tools-registry.entry.ts`
  to the end of `tools` in `content/tools-registry/registry.ts`, run their `pnpm prettier-fix` if asked, PR title
  `feat(tools-registry): add breakwire` (ENTRIES "Vercel AI SDK").
- **LangChain** (issue only; integration PRs are forbidden and auto-closed): open the Integration listing issue with the
  fields in ENTRIES "LangChain".
- **OpenAI Agents SDK**: don't submit. Non-collaborator PRs aren't accepted, and the only community list is tracing processors.
- **Anthropic SDK, MCP TS SDK**: no community list exists.

## 9. Posts (accounts: Ho Hum's HN and X)

- Show HN: `launch/show-hn.md` (title, URL, text, posting notes). Refresh the numbers from `/api/stats` first.
- X: `launch/x-post.txt` (278 chars with URLs counted as 23), optional replies in `launch/x-thread-optional.txt`.
- Directory blurb (150 words): `launch/directory-blurb.md`; short versions: `launch/short-descriptions.md`.
No usage numbers appear anywhere; every piece says outcome data is just starting. Keep it that way until there is data.

## After launch
- Test lookups made while building this kit are listed in `test-lookups.txt` (all `log_miss:false`, no outcome reports).
  Delete those rows from the prod `lookups` table if you want clean counts.
- Bump `version` in `mcp/server.json` and re-run `./registry-dns.sh publish` when the server's tools change.
