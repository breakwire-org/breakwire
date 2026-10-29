// 0.6.0 security and correctness tests (offline). Shared fixtures in ../../tests/ are run by the Python client too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Breakwire, BreakwireError, withBreakwire, breakwireFetch, explain, clearBreakwireCache, previewRedaction, previewStack, normalizeStack, redactSecrets } from '../dist/esm/index.js';

const fixture = (n) => JSON.parse(readFileSync(new URL(`../../../tests/${n}`, import.meta.url)));
const REDIRECTS = fixture('redirect-cases.json');
const STACK = fixture('stack-cases.json');
const CONTRACT = fixture('lookup-contract.json');

function mockFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const call = { url, method: init.method || 'GET', headers: { ...(init.headers || {}) }, rawBody: init.body, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect };
    calls.push(call);
    const r = await handler(call, calls.length);
    const status = r.status ?? 200;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    const headers = new Map(Object.entries(r.headers || {}));
    return { status, ok: status >= 200 && status < 300, type: r.type || 'basic', headers: { get: (k) => headers.get(k.toLowerCase()) ?? null }, text: async () => text, clone() { return this; } };
  };
  f.calls = calls;
  return f;
}
const MATCH = { cid: 'AN-2026-0025', title: 'T', confidence: 'signature', fix: 'Use tool_choice auto', url: 'https://breakwire.org/claim/AN-2026-0025', deadline: null };
const NOLOG = { lookup_id: null, explained: true, coverage: null, matches: [MATCH] };
const LOGGED = { ...NOLOG, lookup_id: 'lk_abc123' };

// ---------- P0: redirects never carry credentials or bodies to other origins ----------
for (const c of REDIRECTS.cases) {
  test(`redirect: ${c.name}`, async () => {
    const f = mockFetch((call, n) => (n === 1 ? { status: c.redirect.status, headers: { location: c.redirect.location }, body: '' } : { body: { ok: true } }));
    const bw = new Breakwire({ baseUrl: c.base_url, fetch: f, apiKey: REDIRECTS.api_key, trustedOrigins: c.trusted_origins });
    const p = bw.request(c.request.method, c.request.path, c.request.body ?? undefined, c.request.auth === 'api_key', c.request.auth === 'bearer' ? REDIRECTS.bearer : undefined);
    const baseOrigin = new URL(c.base_url).origin;
    if (!c.expect.follow) {
      await assert.rejects(p, (e) => e instanceof BreakwireError && /refused/.test(e.message));
      assert.equal(f.calls.length, 1, 'nothing is re-sent');
    } else {
      assert.deepEqual(await p, { ok: true });
      assert.equal(f.calls.length, 2);
      const second = f.calls[1];
      assert.equal(second.url, c.expect.url);
      assert.equal(second.method, c.expect.method);
      assert.equal(second.body !== undefined, c.expect.body_kept);
      assert.equal('authorization' in second.headers, c.expect.auth_kept);
    }
    for (const call of f.calls) {
      if (new URL(call.url).origin === baseOrigin) continue;
      const dump = JSON.stringify(call);
      assert.ok(!dump.includes(REDIRECTS.api_key) && !dump.includes(REDIRECTS.bearer), `credential crossed to ${call.url}`);
      assert.ok(!('authorization' in call.headers) && !('cookie' in call.headers));
    }
  });
}

test('redirect: lookup() through an attacker redirect fails open in explain() without leaking', async () => {
  const f = mockFetch((call, n) => (n === 1 ? { status: 307, headers: { location: 'https://attacker.example/x' } } : { body: LOGGED }));
  const info = await explain(new Error('boom'), { fetch: f, cache: false });
  assert.match(info.error, /refused 307 redirect to https:\/\/attacker\.example/);
  assert.equal(f.calls.length, 1);
});

test('redirect: browser opaqueredirect is never followed blindly', async () => {
  const f = mockFetch(() => ({ status: 0, type: 'opaqueredirect' }));
  await assert.rejects(new Breakwire({ fetch: f, apiKey: 'bwk_x' }).request('GET', '/api/services', undefined, true), /not inspectable/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].redirect, 'manual');
});

test('redirect: at most 3 hops', async () => {
  let i = 0;
  const f = mockFetch(() => ({ status: 307, headers: { location: `/hop${++i}` } }));
  await assert.rejects(new Breakwire({ fetch: f }).request('GET', '/api/services'), /too many redirects/);
  assert.equal(f.calls.length, 4);
});

test('trustedOrigins defaults to breakwire.org + base origin', () => {
  const bw = new Breakwire({ baseUrl: 'https://x.test/sub', fetch: mockFetch(() => ({})) });
  assert.deepEqual([...bw.trustedOrigins].sort(), ['https://breakwire.org', 'https://x.test']);
});

// ---------- P1: retry works in the default no-log mode ----------
test('no-log retry: runs on a match without lookup_id and returns its value; nothing reported', async () => {
  const f = mockFetch(() => ({ body: NOLOG }));
  let ran = 0;
  const wrapped = withBreakwire(async () => { throw new Error('tool_choice any not supported'); }, { fetch: f, cache: false, retry: async (info) => { ran++; assert.equal(info.lookupId, null); assert.equal(info.id, 'AN-2026-0025'); return 'retried'; } });
  assert.equal(await wrapped(), 'retried');
  assert.equal(ran, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.no_log, true);
});

test('no-log retry: a failing retry rethrows the ORIGINAL error; autoReport without lookup id sends no report', async () => {
  const f = mockFetch(() => ({ body: NOLOG }));
  const orig = new Error('original');
  const wrapped = withBreakwire(async () => { throw orig; }, { fetch: f, cache: false, noLog: true, autoReport: true, retry: async () => { throw new Error('still failing'); } });
  await assert.rejects(wrapped(), (e) => e === orig);
  assert.equal(f.calls.length, 1, 'only the lookup, no outcome report');
});

test('logged retry with autoReport still reports on the lookup id', async () => {
  const f = mockFetch((c) => ({ body: c.url.endsWith('/api/lookup') ? LOGGED : { ok: true } }));
  const wrapped = withBreakwire(async () => { throw new Error('x'); }, { fetch: f, autoReport: true, retry: async () => 'ok' });
  assert.equal(await wrapped(), 'ok');
  assert.equal(f.calls[1].url, 'https://breakwire.org/api/lookups/lk_abc123/outcome');
  assert.equal(f.calls[1].body.outcome, 'fixed');
});

test('no retry without a match', async () => {
  const f = mockFetch(() => ({ body: { ...NOLOG, matches: [] } }));
  let ran = 0;
  const wrapped = withBreakwire(async () => { throw new Error('x'); }, { fetch: f, cache: false, retry: async () => { ran++; } });
  await assert.rejects(wrapped());
  assert.equal(ran, 0);
});

// ---------- P1: cache keys include every result-affecting option ----------
const iso = [
  ['cross-model', { model: 'model-a' }, { model: 'model-b' }],
  ['cross-sdk', { sdk: 'openai-node' }, { sdk: 'anthropic-typescript' }],
  ['sdk version', { version: '1.0.0' }, { version: '2.0.0' }],
  ['min_score threshold', { minScore: 0.2 }, { minScore: 0.9 }],
  ['max_matches', { maxMatches: 1 }, { maxMatches: 5 }],
  ['compact', {}, { compact: true }],
  ['http status', { httpStatus: 400 }, { httpStatus: 429 }],
  ['cross_service', {}, { crossService: true }],
  ['context', { context: 'a' }, { context: 'b' }],
  ['since', { since: '2026-01-01' }, { since: '2026-06-01' }],
  ['service', { service: 'openai-api' }, { service: 'anthropic-api' }],
];
for (const [name, a, b] of iso) {
  test(`cache isolation: ${name}`, async () => {
    clearBreakwireCache();
    const f = mockFetch((c) => ({ body: { ...NOLOG, matches: [{ ...MATCH, cid: `AN-2026-${String(c.body.model || c.body.sdk || f.calls.length).length}000`, title: JSON.stringify(c.body) }] } }));
    const r1 = await explain(new Error('same text'), { fetch: f, ...a });
    const r2 = await explain(new Error('same text'), { fetch: f, ...b });
    assert.equal(f.calls.length, 2, 'different options must not share a cached answer');
    assert.notEqual(r1.title, r2.title);
    assert.ok(!r2.cached);
    const r3 = await explain(new Error('same text'), { fetch: f, ...a });
    assert.equal(f.calls.length, 2, 'identical options are still cached'); assert.equal(r3.cached, true); assert.equal(r3.title, r1.title);
  });
}

test('cache isolation: breakwireFetch keys on the HTTP status', async () => {
  clearBreakwireCache();
  const bwf = mockFetch(() => ({ body: NOLOG }));
  const client = new Breakwire({ fetch: bwf });
  let status = 400;
  const vendor = async () => ({ status, statusText: 'x', ok: false, clone() { return { text: async () => 'same body' }; } });
  const f = breakwireFetch(vendor, { client });
  await f('u'); status = 429; await f('u');
  assert.equal(bwf.calls.length, 2);
});

// ---------- P1: stack files are parsed locally ----------
for (const c of STACK) {
  test(`stack (shared fixture): ${c.name}`, () => {
    const r = normalizeStack(c.input);
    assert.deepEqual(r.body, c.expect);
    const s = JSON.stringify(r.body);
    for (const a of c.absent || []) assert.ok(!s.includes(a), `leaked ${a}`);
    if (c.ignored) assert.deepEqual(r.ignored, c.ignored);
  });
}

test('stack() sends only parsed facts by default; rawFiles is an explicit opt-in; previewStack is exactly what is sent', async () => {
  const f = mockFetch(() => ({ body: { ok: true } }));
  const bw = new Breakwire({ fetch: f });
  const input = STACK[0].input;
  await bw.stack(input);
  assert.deepEqual(f.calls[0].body, previewStack(input));
  assert.deepEqual(f.calls[0].body, bw.previewStack(input));
  assert.ok(!('files' in f.calls[0].body));
  assert.ok(!f.calls[0].rawBody.includes('scripts'));
  await bw.stack(input, { rawFiles: true });
  assert.deepEqual(f.calls[1].body, input);
  assert.deepEqual(previewStack(input, { rawFiles: true }), input);
});

test('subscribe() and updateSubscription() parse stack files locally too', async () => {
  const f = mockFetch(() => ({ body: { id: 'sub_aaaaaaaaaaaaaaaaaaaaaaaa' } }));
  const bw = new Breakwire({ fetch: f });
  await bw.subscribe({ files: { 'requirements.txt': 'mcp==1.9.0\n--index-url https://u:p@x.internal/simple\n' } }, { horizonDays: 14, launches: true });
  assert.deepEqual(f.calls[0].body, { requirements: 'mcp==1.9.0', horizon_days: 14, launches: true });
  await bw.updateSubscription('sub_aaaaaaaaaaaaaaaaaaaaaaaa', 'bwm_x', { files: { '.nvmrc': '22' }, webhook_url: null, horizon_days: 7 });
  assert.deepEqual(f.calls[1].body, { runtime: { node: '22' }, webhook_url: null, horizon_days: 7 });
});

// ---------- P2: redaction preview ----------
test('previewRedaction shows exactly the error text lookup() sends', async () => {
  const f = mockFetch(() => ({ body: NOLOG }));
  const bw = new Breakwire({ fetch: f, secrets: ['my-own-literal'] });
  const err = Object.assign(new Error('ENOENT open /srv/acme/x/y.json from 2001:db8::1 token my-own-literal req_011CPXa9bTzR8vQ2'), { status: 500 });
  await bw.lookup(err);
  assert.equal(f.calls[0].body.error, bw.previewRedaction(err));
  assert.ok(!bw.previewRedaction(err).includes('my-own-literal'));
  assert.equal(previewRedaction('plain sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx'), 'plain <secret>');
  assert.equal(previewRedaction({ apiKey: 'v', ok: 1 }), '{"apiKey":"<secret>","ok":1}');
  assert.equal(redactSecrets({ apiKey: 'v' }), '{"apiKey":"<secret>"}');
});

// ---------- P2: cross-language lookup option contract ----------
for (const c of CONTRACT) {
  test(`contract: ${Object.keys(c.js)[0]} reaches the wire via withBreakwire, explain and lookup`, async () => {
    const f = mockFetch(() => ({ body: NOLOG }));
    const wrapped = withBreakwire(async () => { throw new Error('contract'); }, { fetch: f, cache: false, ...c.js });
    await assert.rejects(wrapped());
    await explain(new Error('contract'), { fetch: f, cache: false, ...c.js });
    await new Breakwire({ fetch: f }).lookup('contract', c.js);
    for (const call of f.calls) for (const [k, v] of Object.entries(c.wire)) assert.deepEqual(call.body[k], v, `${k} missing in ${JSON.stringify(call.body)}`);
  });
}
