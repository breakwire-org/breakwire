// Live smoke test against the real API. Read-only except lookups (sent with log_miss:false). Files NO reports.
// BREAKWIRE_BASE_URL=https://agent-news.ethan-hawkes.workers.dev node test/live.mjs
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { Breakwire, withBreakwire, breakwireFetch } from '../dist/esm/index.js';

const base = process.env.BREAKWIRE_BASE_URL || 'https://agent-news.ethan-hawkes.workers.dev';
const bw = new Breakwire({ baseUrl: base, userAgent: 'breakwire-kit-live-test', timeoutMs: 8000 });
const ids = [];
const log = (...a) => console.log('  ', ...a);
const rec = (r) => { if (r?.lookup_id) { ids.push(r.lookup_id); appendFileSync(new URL('../../../test-lookups.txt', import.meta.url), `${r.lookup_id}\tjs\t${new Date().toISOString()}\n`); } return r; };

console.log('base', base);
const svc = await bw.services(); log('services:', (svc.services || svc.covered || []).length ?? Object.keys(svc).join(','));

const d = await bw.deadlines('stripe-api'); log('deadlines(stripe-api):', d.length, d[0]?.cid, d[0]?.deadline);
assert.ok(Array.isArray(d));

const c = await bw.claim('AN-2026-0025'); log('claim:', c.cid || c.claim?.cid, (c.title || c.claim?.title || '').slice(0, 70));
assert.ok((c.cid || c.claim?.cid) === 'AN-2026-0025');

// 1) signature match, with a secret in the text that must not leave the process
const err = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"tool_choice: type \\"tool\\" and \\"any\\" are not supported for this model."}} key sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ'), { status: 400 });
const r1 = rec(await bw.lookup(err, { service: 'anthropic-api', sdk: 'anthropic-typescript', version: '0.60.0', logMiss: false }));
log('lookup signature:', r1.explained, r1.matches[0]?.cid, r1.matches[0]?.confidence, '| normalized has key?', r1.normalized.includes('zzzz'));
assert.equal(r1.explained, true); assert.equal(r1.matches[0].cid, 'AN-2026-0025'); assert.ok(!r1.normalized.includes('zzzz'));

// 2) Stripe webhook signature error
const r2 = rec(await bw.lookup('StripeSignatureVerificationError: No signatures found matching the expected signature for payload. Are you passing the raw request body you received from Stripe?', { service: 'stripe', logMiss: false }));
log('lookup stripe:', r2.explained, r2.matches[0]?.cid);
assert.equal(r2.matches[0]?.cid, 'AN-2026-0076');

// 3) uncovered/unknown error -> no confident wrong match, not logged
const r3 = rec(await bw.lookup('frobnicator quux exploded unexpectedly zzqv', { logMiss: false }));
log('lookup miss:', r3.explained, r3.matches.length, 'unexplained:', JSON.stringify(r3.unexplained));
assert.equal(r3.explained, false); assert.equal(r3.unexplained, null);

// 4) withBreakwire on a real thrown error
const call = withBreakwire(async () => { throw Object.assign(new Error('Worker exceeded resource limits'), { status: 503 }); }, { client: bw, service: 'cloudflare-workers', logMiss: false, timeoutMs: 8000 });
try { await call(); assert.fail('should throw'); } catch (e) {
  rec({ lookup_id: e.breakwire?.lookupId });
  log('withBreakwire:', e.message, '->', e.breakwire?.id, e.breakwire?.confidence, (e.breakwire?.fix || '').slice(0, 60));
  assert.equal(e.breakwire.id, 'AN-2026-0082');
}

// 5) breakwireFetch on a real 404 from the API itself (logMiss false)
const f = breakwireFetch(fetch, { client: bw, logMiss: false, timeoutMs: 8000 });
const res = await f(base + '/api/definitely-not-a-route', { headers: { 'user-agent': 'breakwire-kit-live-test' } });
rec({ lookup_id: res.breakwire?.lookupId });
log('breakwireFetch: status', res.status, 'breakwire attached:', !!res.breakwire, 'error:', res.breakwire?.error || 'none', 'matches:', res.breakwire?.matches.length);
assert.equal(res.status, 404); assert.ok(res.breakwire);

// 6) stack
const st = await bw.stack({ dependencies: { '@anthropic-ai/sdk': '^0.60.0', stripe: '^14', next: '15.0.0' }, engines: { node: '20' } });
log('stack:', st.applicable_count, 'applicable;', st.services.map((s) => s.service).join(','));
assert.ok(st.applicable_count > 0);

console.log('LIVE OK; lookups made:', ids.length, ids.join(' '));
