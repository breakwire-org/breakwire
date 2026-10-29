// Offline unit tests: no network. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Breakwire, withBreakwire, breakwireFetch, explain, redactSecrets, errorText, DEFAULT_BASE_URL, verifyWebhookSignature, clearBreakwireCache, VERSION } from '../dist/esm/index.js';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';

const cases = JSON.parse(readFileSync(new URL('../../../tests/redaction-cases.json', import.meta.url)));

function mockFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const call = { url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = await handler(call);
    const status = r.status ?? 200;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    const headers = new Map(Object.entries(r.headers || {}));
    return { status, ok: status >= 200 && status < 300, type: 'basic', headers: { get: (k) => headers.get(k.toLowerCase()) ?? null }, text: async () => text, clone() { return this; } };
  };
  f.calls = calls;
  return f;
}
const LOOKUP = { lookup_id: 'lk_abc123', normalized: 'x', explained: true, service: 'anthropic-api', coverage: null, unexplained: null, close_the_loop: {},
  matches: [{ cid: 'AN-2026-0025', title: 'T', kind: 'breaking', confidence: 'signature', why: 'w', score: 12, fix: 'Use tool_choice auto', deadline: null, severity: 'high', services: ['anthropic-api'], affected: [], fixed_in: [], verification: { status: 'unverified', reports: 0, independent_operators: 0 }, source_url: 's', url: 'https://breakwire.org/claim/AN-2026-0025', json: 'j' }] };

test('redaction cases (shared with the Python client)', () => {
  for (const c of cases) {
    const out = redactSecrets(c.in);
    for (const a of c.absent) assert.ok(!out.includes(a), `leaked ${a} in: ${out}`);
    for (const p of c.present) assert.ok(out.includes(p), `lost ${p} in: ${out}`);
  }
});

test('extra secrets option strips literal values', () => {
  assert.equal(redactSecrets('failed with mytoken123', ['mytoken123']), 'failed with <secret>');
});

test('default base URL is breakwire.org, env and option override', () => {
  delete process.env.BREAKWIRE_BASE_URL;
  assert.equal(new Breakwire({ fetch: mockFetch(() => ({})) }).baseUrl, DEFAULT_BASE_URL);
  assert.equal(DEFAULT_BASE_URL, 'https://breakwire.org');
  process.env.BREAKWIRE_BASE_URL = 'https://example.test/';
  assert.equal(new Breakwire({ fetch: mockFetch(() => ({})) }).baseUrl, 'https://example.test');
  assert.equal(new Breakwire({ baseUrl: 'https://o.test', fetch: mockFetch(() => ({})) }).baseUrl, 'https://o.test');
  delete process.env.BREAKWIRE_BASE_URL;
});

test('lookup sends redacted error, maps options, sets User-Agent', async () => {
  const f = mockFetch(() => ({ body: LOOKUP }));
  const bw = new Breakwire({ baseUrl: 'https://x.test', fetch: f, userAgent: 'my-agent/1' });
  const err = Object.assign(new Error('invalid x-api-key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx'), { status: 401 });
  const r = await bw.lookup(err, { service: 'anthropic-api', sdk: 'anthropic-typescript', version: '0.60.0', logMiss: false });
  assert.equal(r.lookup_id, 'lk_abc123');
  const c = f.calls[0];
  assert.equal(c.url, 'https://x.test/api/lookup');
  assert.equal(c.method, 'POST');
  assert.match(c.headers['user-agent'], /^breakwire-js\/\d+\.\d+\.\d+ my-agent\/1$/);
  assert.match(c.headers['x-breakwire-client'], /^breakwire-js\/\d+\.\d+\.\d+$/, 'channel tag header');
  assert.ok(!JSON.stringify(c.body).includes('AbCdEfGh'));
  assert.deepEqual({ ...c.body, error: undefined }, { error: undefined, service: 'anthropic-api', sdk: 'anthropic-typescript', sdk_version: '0.60.0', http_status: 401, log_miss: false });
  assert.equal(c.headers.authorization, undefined, 'no auth header on lookups');
});

test('errorText: name, message, status, code, nested API error, cause; no stack', () => {
  const e = Object.assign(new Error('400 bad'), { name: 'BadRequestError', status: 400, error: { type: 'invalid_request_error', message: 'tool_choice not supported' } });
  e.cause = new Error('inner');
  const t = errorText(e);
  assert.match(t, /BadRequestError: 400 bad/); assert.match(t, /invalid_request_error/); assert.match(t, /tool_choice not supported/); assert.match(t, /cause: inner/);
  assert.ok(!t.includes('at '), 'no stack frames');
});

test('POST is re-sent with same method/body across a 301 host move', async () => {
  const f = mockFetch((c) => c.url.startsWith('https://old.test') ? { status: 301, headers: { location: 'https://new.test/api/lookup' }, body: '' } : { body: LOOKUP });
  const r = await new Breakwire({ baseUrl: 'https://old.test', fetch: f }).lookup('some error text');
  assert.equal(r.lookup_id, 'lk_abc123');
  assert.equal(f.calls[1].url, 'https://new.test/api/lookup'); assert.equal(f.calls[1].method, 'POST'); assert.equal(f.calls[1].body.error, 'some error text');
});

test('deadlines, claim, stack, services hit the right routes', async () => {
  const f = mockFetch((c) => ({ body: c.url.includes('deadlines') ? { deadlines: [{ cid: 'AN-2026-0001' }] } : { ok: 1 } }));
  const bw = new Breakwire({ baseUrl: 'https://x.test', fetch: f });
  assert.equal((await bw.deadlines('stripe-api', { limit: 5 }))[0].cid, 'AN-2026-0001');
  await bw.deadlines();
  await bw.claim('AN-2026-0001'); await bw.claim('AN-2026-0001', { version: 2 });
  await bw.stack({ packages: ['next@15'] }); await bw.services();
  assert.deepEqual(f.calls.map((c) => `${c.method} ${c.url.replace('https://x.test', '')}`), [
    'GET /api/deadlines?service=stripe-api&limit=5', 'GET /api/deadlines', 'GET /api/claims/AN-2026-0001', 'GET /api/claims/AN-2026-0001/versions/2', 'POST /api/stack', 'GET /api/services']);
  await assert.rejects(bw.claim('../etc'), TypeError);
});

test('report: lookup id -> close lookup; claim id -> needs key; outcome mapping; redacted env', async () => {
  const f = mockFetch(() => ({ body: { ok: true } }));
  const bw = new Breakwire({ baseUrl: 'https://x.test', fetch: f });
  await bw.report('lk_abc123', 'fixed', { sdk: 'openai', model: 'gpt-x', runtime: 'node 22 key=sk-proj-abcdefghijklmnop12' }, { cid: 'AN-2026-0025' });
  assert.equal(f.calls[0].url, 'https://x.test/api/lookups/lk_abc123/outcome');
  assert.equal(f.calls[0].body.outcome, 'fixed'); assert.equal(f.calls[0].body.cid, 'AN-2026-0025');
  assert.ok(!JSON.stringify(f.calls[0].body).includes('abcdefghijklmnop12'));
  await bw.report('lk_abc123', 'disputed'); assert.equal(f.calls[1].body.outcome, 'not_fixed');
  await assert.rejects(bw.report('AN-2026-0025', 'confirmed'), /apiKey/);
  const keyed = new Breakwire({ baseUrl: 'https://x.test', fetch: f, apiKey: 'k_test' });
  await assert.rejects(keyed.report('AN-2026-0025', 'not_fixed'), /note/);
  await keyed.report('AN-2026-0025', 'fixed', {}, { statementIndex: 0 });
  const last = f.calls.at(-1);
  assert.equal(last.url, 'https://x.test/api/claims/AN-2026-0025/reports'); assert.equal(last.body.outcome, 'confirmed'); assert.equal(last.body.statement_index, 0);
  assert.equal(last.headers.authorization, 'Bearer k_test');
  await assert.rejects(bw.report('bogus', 'fixed'), TypeError);
  await assert.rejects(bw.report('lk_x', 'maybe'), TypeError);
});

test('withBreakwire attaches match and rethrows the original error', async () => {
  const f = mockFetch(() => ({ body: LOOKUP }));
  const orig = new Error('tool_choice boom');
  const wrapped = withBreakwire(async () => { throw orig; }, { baseUrl: 'https://x.test', fetch: f, service: 'anthropic-api' });
  await assert.rejects(wrapped(), (e) => e === orig && e.breakwire.id === 'AN-2026-0025' && e.breakwire.fix === 'Use tool_choice auto' && e.breakwire.confidence === 'signature' && e.breakwire.lookupId === 'lk_abc123');
  assert.equal(Object.keys(orig).includes('breakwire'), false, 'non-enumerable: does not pollute logs/serialization');
});

test('withBreakwire passes through success without any network call', async () => {
  const f = mockFetch(() => { throw new Error('should not be called'); });
  assert.equal(await withBreakwire(async (a, b) => a + b, { fetch: f })(2, 3), 5);
  assert.equal(f.calls.length, 0);
});

test('Breakwire failures never mask the original error (network error, 500, 429, bad JSON)', async () => {
  for (const handler of [() => { throw new TypeError('fetch failed'); }, () => ({ status: 500, body: 'oops' }), () => ({ status: 429, body: { error: 'rate limited' } }), () => ({ body: '<html>' })]) {
    const orig = new Error('real failure');
    const wrapped = withBreakwire(async () => { throw orig; }, { baseUrl: 'https://x.test', fetch: mockFetch(handler) });
    await assert.rejects(wrapped(), (e) => e === orig && e.breakwire && e.breakwire.id === null);
  }
});

test('timeout: lookup is abandoned after timeoutMs and original error rethrown', async () => {
  const slow = mockFetch(() => new Promise(() => {}));
  const orig = new Error('real');
  const t0 = Date.now();
  await assert.rejects(withBreakwire(async () => { throw orig; }, { baseUrl: 'https://x.test', fetch: slow, timeoutMs: 150 })(), (e) => e === orig && /timed out/.test(e.breakwire.error));
  assert.ok(Date.now() - t0 < 1000);
});

test('thrown non-objects (strings) still rethrow unchanged', async () => {
  await assert.rejects(withBreakwire(async () => { throw 'plain string'; }, { baseUrl: 'https://x.test', fetch: mockFetch(() => ({ body: LOOKUP })) })(), (e) => e === 'plain string');
});

test('shouldLookup filters errors', async () => {
  const f = mockFetch(() => ({ body: LOOKUP }));
  await assert.rejects(withBreakwire(async () => { throw new RangeError('mine'); }, { fetch: f, baseUrl: 'https://x.test', shouldLookup: (e) => !(e instanceof RangeError) })());
  assert.equal(f.calls.length, 0);
});

test('autoReport is off by default even when retry succeeds', async () => {
  const f = mockFetch(() => ({ body: LOOKUP }));
  const w = withBreakwire(async () => { throw new Error('x'); }, { baseUrl: 'https://x.test', fetch: f, retry: async () => 'retried' });
  assert.equal(await w(), 'retried');
  assert.deepEqual(f.calls.map((c) => c.url), ['https://x.test/api/lookup']);
});

test('autoReport opt-in: reports fixed when retry resolves, not_fixed when it throws', async () => {
  const f = mockFetch((c) => ({ body: c.url.endsWith('/api/lookup') ? LOOKUP : { ok: true } }));
  const ok = withBreakwire(async () => { throw new Error('x'); }, { baseUrl: 'https://x.test', fetch: f, autoReport: true, reportEnv: { sdk: 'test' }, retry: async () => 'ok' });
  assert.equal(await ok(), 'ok');
  assert.equal(f.calls[1].url, 'https://x.test/api/lookups/lk_abc123/outcome'); assert.equal(f.calls[1].body.outcome, 'fixed'); assert.equal(f.calls[1].body.cid, 'AN-2026-0025');
  const orig = new Error('y');
  const bad = withBreakwire(async () => { throw orig; }, { baseUrl: 'https://x.test', fetch: f, autoReport: true, retry: async () => { throw new Error('still broken'); } });
  await assert.rejects(bad(), (e) => e === orig);
  assert.equal(f.calls.at(-1).body.outcome, 'not_fixed');
});

test('no report when the lookup had no match', async () => {
  const f = mockFetch((c) => ({ body: c.url.endsWith('/api/lookup') ? { ...LOOKUP, explained: false, matches: [] } : { ok: true } }));
  let retried = false;
  await assert.rejects(withBreakwire(async () => { throw new Error('x'); }, { baseUrl: 'https://x.test', fetch: f, autoReport: true, retry: async () => { retried = true; } })());
  assert.equal(retried, false); assert.equal(f.calls.length, 1);
});

test('breakwireFetch: error responses get res.breakwire, body still readable; network errors rethrown with info', async () => {
  const bwf = mockFetch(() => ({ body: LOOKUP }));
  const upstream = async (url) => {
    if (url === 'down') throw new TypeError('fetch failed');
    const status = url === 'bad' ? 400 : 200;
    return { status, ok: status < 300, statusText: '', clone() { return { text: async () => '{"error":"tool_choice"}' }; }, text: async () => '{"error":"tool_choice"}' };
  };
  const f = breakwireFetch(upstream, { baseUrl: 'https://x.test', fetch: bwf, service: 'openai-api' });
  const good = await f('good'); assert.equal(good.breakwire, undefined); assert.equal(bwf.calls.length, 0);
  const res = await f('bad'); assert.equal(res.status, 400); assert.equal(res.breakwire.id, 'AN-2026-0025'); assert.equal(await res.text(), '{"error":"tool_choice"}');
  assert.equal(bwf.calls[0].body.http_status, 400); assert.equal(bwf.calls[0].body.service, 'openai-api');
  await assert.rejects(f('down'), (e) => e instanceof TypeError && e.breakwire.id === 'AN-2026-0025');
});

test('explain never throws', async () => {
  clearBreakwireCache();
  const info = await explain(new Error('x'), { baseUrl: 'https://x.test', fetch: mockFetch(() => { throw new Error('dns'); }) });
  assert.equal(info.id, null); assert.match(info.error, /dns/);
});

test('CommonJS build loads', () => {
  const require = createRequire(import.meta.url);
  const cjs = require('../dist/cjs/index.js');
  assert.equal(typeof cjs.withBreakwire, 'function'); assert.equal(typeof cjs.Breakwire, 'function');
});

// ---- 0.2.0: error-path defaults, cache, subscriptions, webhook verification ----
test('version is 0.5.0', () => { assert.equal(VERSION, '0.5.0'); });

test('explain(): no-log by default, opt out with noLog:false', async () => {
  clearBreakwireCache();
  const f = mockFetch(() => ({ body: LOOKUP }));
  await explain(new Error('boom unique 1'), { fetch: f, cache: false });
  assert.equal(f.calls[0].body.no_log, true);
  await explain(new Error('boom unique 2'), { fetch: f, cache: false, noLog: false });
  assert.equal(f.calls[1].body.no_log, undefined);
});

test('explain(): local cache avoids repeat lookups and marks cached', async () => {
  clearBreakwireCache();
  const f = mockFetch(() => ({ body: { ...LOOKUP, remember: 'check Breakwire first' } }));
  const a = await explain(new Error('same error text'), { fetch: f });
  const b = await explain(new Error('same error text'), { fetch: f });
  assert.equal(f.calls.length, 1);
  assert.equal(b.cached, true); assert.equal(a.remember, 'check Breakwire first');
  await explain(new Error('same error text'), { fetch: f, cache: false });
  assert.equal(f.calls.length, 2);
});

test('explain(): Breakwire failure is not cached', async () => {
  clearBreakwireCache();
  let n = 0;
  const f = mockFetch(() => (n++ === 0 ? { status: 503, body: { error: 'down' } } : { body: LOOKUP }));
  const a = await explain(new Error('flaky'), { fetch: f });
  assert.ok(a.error);
  const b = await explain(new Error('flaky'), { fetch: f });
  assert.ok(!b.error); assert.equal(f.calls.length, 2);
});

test('subscribe/alerts/unsubscribe send the right requests', async () => {
  const f = mockFetch((c) => ({ body: c.method === 'POST' ? { id: 'sub_aaaaaaaaaaaaaaaaaaaaaaaa', manage_token: 'bwm_x' } : { ok: true } }));
  const bw = new Breakwire({ fetch: f });
  const s = await bw.subscribe({ files: { 'package.json': '{"dependencies":{"next":"16.0.0"}}' } }, { horizonDays: 14 });
  assert.equal(f.calls[0].url, DEFAULT_BASE_URL + '/api/subscriptions');
  assert.equal(f.calls[0].body.horizon_days, 14);
  await bw.alerts(s.id);
  assert.equal(f.calls[1].url, DEFAULT_BASE_URL + '/api/subscriptions/sub_aaaaaaaaaaaaaaaaaaaaaaaa/feed');
  await bw.unsubscribe(s.id, 'bwm_x');
  assert.equal(f.calls[2].method, 'DELETE'); assert.equal(f.calls[2].headers.authorization, 'Bearer bwm_x');
  await assert.rejects(bw.alerts('nope'));
});

test('verifyWebhookSignature matches the server scheme and rejects tampering/staleness', async () => {
  const secret = 'whsec_test', body = '{"type":"stack.alerts"}', t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  assert.equal(await verifyWebhookSignature(secret, `t=${t},v1=${sig}`, body), true);
  assert.equal(await verifyWebhookSignature(secret, `t=${t},v1=${sig}`, body + ' '), false);
  assert.equal(await verifyWebhookSignature('other', `t=${t},v1=${sig}`, body), false);
  const old = t - 1000, sigOld = createHmac('sha256', secret).update(`${old}.${body}`).digest('hex');
  assert.equal(await verifyWebhookSignature(secret, `t=${old},v1=${sigOld}`, body), false);
  assert.equal(await verifyWebhookSignature(secret, null, body), false);
});

// ---- 0.4.0 parity ----
test('0.4.0: report() sends every lookup outcome; solved needs a note; not_covered drops cid', async () => {
  const f = mockFetch(() => ({ body: { ok: true } }));
  const bw = new Breakwire({ fetch: f });
  for (const o of ['fixed', 'partial', 'applies', 'not_fixed', 'wrong_match', 'not_covered']) await bw.report('lk_abc', o, {}, { cid: 'AN-2026-0025' });
  assert.deepEqual(f.calls.map((c) => c.body.outcome), ['fixed', 'partial', 'applies', 'not_fixed', 'wrong_match', 'not_covered']);
  assert.equal(f.calls[5].body.cid, undefined);
  await assert.rejects(bw.report('lk_abc', 'solved'), /needs opts.note/);
  await bw.report('lk_abc', 'solved', {}, { note: 'pinned the SDK' });
  assert.equal(f.calls.at(-1).body.outcome, 'solved');
  await bw.report('lk_abc', 'confirmed');
  assert.equal(f.calls.at(-1).body.outcome, 'fixed');
  await assert.rejects(bw.report('lk_abc', 'bogus'), /lookup outcome must be/);
});
test('0.4.0: lookup sends compact, max_matches, min_score', async () => {
  const f = mockFetch(() => ({ body: LOOKUP }));
  await new Breakwire({ fetch: f }).lookup('x error', { compact: true, maxMatches: 40, minScore: 0.5, noLog: true });
  const b = f.calls[0].body;
  assert.equal(b.compact, true); assert.equal(b.max_matches, 10); assert.equal(b.min_score, 0.5); assert.equal(b.no_log, true);
});
test('0.4.0: launches(), changes() and subscribe({launches})', async () => {
  const f = mockFetch(() => ({ body: { launches: [], changes: [] } }));
  const bw = new Breakwire({ fetch: f });
  await bw.launches({ since: '30d', services: ['openai-api', 'gemini-api'] });
  await bw.changes('2026-06-01', { service: 'openai-api' });
  await bw.subscribe({ services: ['openai-api'] }, { launches: true });
  assert.match(f.calls[0].url, /\/api\/launches\?since=30d&services=openai-api%2Cgemini-api$/);
  assert.match(f.calls[1].url, /\/api\/changes\?from=2026-06-01&service=openai-api$/);
  assert.equal(f.calls[2].body.launches, true);
});

test('channel option overrides the channel tag (X-Breakwire-Client)', async () => {
  const f = mockFetch(() => ({ body: LOOKUP }));
  await new Breakwire({ baseUrl: 'https://x.test', fetch: f, channel: 'kit/cursor' }).lookup('boom error text', { logMiss: false });
  assert.equal(f.calls[0].headers['x-breakwire-client'], 'kit/cursor');
});
