import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Breakwire, EVIDENCE_TYPES } from '../dist/esm/index.js';

function mockFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const call = { url, method: init.method || 'GET', headers: { ...(init.headers || {}) }, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = await handler(call, calls.length);
    const status = r.status ?? 200;
    const text = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    const headers = new Map(Object.entries(r.headers || {}));
    return { status, ok: status >= 200 && status < 300, type: 'basic', headers: { get: (k) => headers.get(k.toLowerCase()) ?? null }, text: async () => text };
  };
  f.calls = calls; return f;
}
const CLEAR = { decision: 'clear', next_cursor: 800, stack_fingerprint: 'sha256:abc', checked_at: '2026-10-29T00:00:00Z', cache_for_seconds: 21600 };
const ACT = { decision: 'block', next_cursor: 801, stack_fingerprint: 'sha256:abc', checked_at: '2026-10-29T00:00:00Z', cache_for_seconds: 900,
  items: [{ cid: 'AN-2026-0067', applies: 'exact_package_version', why: '@modelcontextprotocol/sdk 1.9.0 is in < 1.32.0', why_now: 'security exposure (high) in your pinned version', action: 'Upgrade to 1.32.0.', deadline: null, severity: 'high', evidence: 'sourced_only', source_url: 'https://github.com/advisories/GHSA-x', blocks: true }] };
const STACK = { packages: ['npm:@modelcontextprotocol/sdk@1.9.0'], runtime: { node: '22' }, models: ['claude-opus-4-7'], features: ['tool_choice:any'], services: ['anthropic-api'] };

test('sessionBrief: first call sends stack facts; clear injects nothing; cursor + ETag are stored locally', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bw-')), file = join(dir, 'state.json');
  const f = mockFetch((c, n) => (n === 1 ? { body: CLEAR, headers: { etag: '"b1"' } } : { status: 304 }));
  const bw = new Breakwire({ fetch: f });
  const b1 = await bw.sessionBrief(STACK, { state: file });
  assert.equal(b1.decision, 'clear'); assert.equal(b1.context, null);
  assert.equal(f.calls[0].url, 'https://breakwire.org/api/session-brief');
  assert.deepEqual(f.calls[0].body.models, ['claude-opus-4-7']); assert.deepEqual(f.calls[0].body.features, ['tool_choice:any']);
  assert.deepEqual(f.calls[0].body.packages, ['npm:@modelcontextprotocol/sdk@1.9.0']);
  const saved = Object.values(JSON.parse(readFileSync(file, 'utf8')))[0];
  assert.equal(saved.next_cursor, 800); assert.equal(saved.etag, '"b1"'); assert.equal(saved.stack_fingerprint, 'sha256:abc');
  assert.equal(statSync(file).mode & 0o077, 0, 'state file is private (0600)');
  const b2 = await bw.sessionBrief(STACK, { state: file });
  assert.deepEqual(f.calls[1].body, { stack_fingerprint: 'sha256:abc', cursor: 800 }, 'later sessions send fingerprint + cursor only');
  assert.equal(f.calls[1].headers['if-none-match'], '"b1"');
  assert.equal(b2.decision, 'clear'); assert.equal(b2.not_modified, true); assert.equal(b2.context, null);
});

test('sessionBrief: act/block returns items and a context block; the cursor does not advance past unresolved items', async () => {
  const store = new Map(); const st = { get: (k) => store.get(k), set: (k, v) => { store.set(k, v); } };
  const f = mockFetch(() => ({ body: ACT, headers: { etag: '"b2"' } }));
  const bw = new Breakwire({ fetch: f });
  const b = await bw.sessionBrief(STACK, { state: st, budgetTokens: 300 });
  assert.equal(b.decision, 'block'); assert.equal(b.items.length, 1);
  assert.match(b.context, /BLOCK/); assert.match(b.context, /AN-2026-0067/); assert.match(b.context, /GHSA-x/);
  assert.equal(f.calls[0].body.budget_tokens, 300);
  const saved = [...store.values()][0];
  assert.equal(saved.next_cursor, null); assert.equal(saved.etag, null);
});

test('sessionBrief: unknown fingerprint (400) re-sends the stack; network errors fail open', async () => {
  const store = new Map([['x', null]]); const st = { get: () => ({ stack_fingerprint: 'sha256:old', next_cursor: 5, etag: '"e"' }), set: (k, v) => store.set(k, v) };
  const f = mockFetch((c, n) => (n === 1 ? { status: 400, body: { error: 'Unknown stack_fingerprint' } } : { body: CLEAR }));
  const b = await new Breakwire({ fetch: f }).sessionBrief(STACK, { state: st });
  assert.equal(f.calls.length, 2); assert.ok(f.calls[1].body.packages); assert.equal(b.decision, 'clear');
  const down = await new Breakwire({ fetch: async () => { throw new Error('ECONNREFUSED'); } }).sessionBrief(STACK, { state: false });
  assert.equal(down.decision, 'unavailable'); assert.equal(down.context, null); assert.match(down.error, /ECONNREFUSED/);
});

test('stack(): strict + compact by default; installed and models pass through; full report on request', async () => {
  const f = mockFetch(() => ({ body: { decision: 'clear' } }));
  const bw = new Breakwire({ fetch: f });
  await bw.stack({ packages: ['pypi:mcp>=1.30.0'], installed: { mcp: '2.1.0' }, models: ['text-embedding-004'] });
  assert.equal(f.calls[0].body.strict, true); assert.equal(f.calls[0].body.compact, true); assert.equal(f.calls[0].body.include_related, false);
  assert.deepEqual(f.calls[0].body.installed, { mcp: '2.1.0' }); assert.deepEqual(f.calls[0].body.models, ['text-embedding-004']);
  await bw.stack({ packages: ['pypi:mcp==1.9.0'] }, { strict: false, compact: false, includeRelated: true });
  assert.equal(f.calls[1].body.strict, false); assert.equal(f.calls[1].body.compact, false); assert.equal(f.calls[1].body.include_related, true);
});

test('report(): receipts (rc_) go to /api/receipts with evidence_type; lookups and claims carry evidence_type', async () => {
  const f = mockFetch(() => ({ body: { ok: true } }));
  const bw = new Breakwire({ fetch: f, apiKey: 'bw_test' });
  await bw.report('rc_eyJ2IjoxfQ.0123456789abcdef01234567', 'fixed', {}, { cid: 'AN-2026-0021', evidenceType: 'remedy_tested' });
  assert.equal(f.calls[0].url, 'https://breakwire.org/api/receipts');
  assert.deepEqual(f.calls[0].body, { receipt: 'rc_eyJ2IjoxfQ.0123456789abcdef01234567', outcome: 'fixed', cid: 'AN-2026-0021', evidence_type: 'remedy_tested' });
  await bw.report('lk_abc', 'wrong_match', {}, { cid: 'AN-2026-0001', evidenceType: 'applicability_checked' });
  assert.equal(f.calls[1].body.evidence_type, 'applicability_checked');
  await bw.report('AN-2026-0001', 'confirmed', {}, { evidenceType: 'remedy_tested', intervention: 'switched to adaptive thinking', verification: 'call returned 200' });
  assert.equal(f.calls[2].body.evidence_type, 'remedy_tested'); assert.equal(f.calls[2].body.intervention, 'switched to adaptive thinking');
  await assert.rejects(bw.report('rc_x', 'not_covered'), /receipt outcome/);
  await assert.rejects(bw.report('lk_abc', 'fixed', {}, { evidenceType: 'vibes' }), /evidenceType/);
  assert.ok(EVIDENCE_TYPES.includes('production_recovered'));
});
