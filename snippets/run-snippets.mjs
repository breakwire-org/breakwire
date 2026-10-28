// Runs every JS snippet against a local mock vendor API (no API keys needed) and the LIVE Breakwire API.
// Lookups are real (log_miss:false where the snippet sets it); no outcome reports are filed.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { startMock } from './mock-vendor.mjs';

const mock = await startMock();
process.env.ANTHROPIC_BASE_URL = mock.url + '/anthropic';
process.env.ANTHROPIC_API_KEY ||= 'test-key-not-real';
process.env.OPENAI_BASE_URL = mock.url + '/openai/v1';
process.env.OPENAI_API_KEY ||= 'test-key-not-real';
process.env.BREAKWIRE_BASE_URL ||= 'https://breakwire.org';
const rec = (id, tag) => id && appendFileSync(new URL('../test-lookups.txt', import.meta.url), `${id}\tsnippet:${tag}\t${new Date().toISOString()}\n`);
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, e?.stack || e); }
}

await check('anthropic-sdk', async () => {
  const info = await (await import('./anthropic-sdk.mjs')).main(); rec(info?.lookupId, 'anthropic');
  assert.equal(info.id, 'AN-2026-0025'); assert.equal(info.confidence, 'signature');
});
await check('vercel-ai-sdk (ai@7 + @ai-sdk/anthropic)', async () => {
  process.env.ANTHROPIC_BASE_URL = mock.url + '/anthropic/v1';
  const info = await (await import('./vercel-ai-sdk.mjs')).main(); rec(info?.lookupId, 'ai-sdk');
  assert.equal(info.id, 'AN-2026-0025');
});
await check('openai-agents (JS)', async () => {
  const info = await (await import('./openai-agents.mjs')).main(); rec(info?.lookupId, 'openai-agents');
  assert.equal(info.id, 'AN-2026-0044');
});
await check('mcp-ts-client', async () => {
  const r = await (await import('./mcp-ts-client.mjs')).main(); rec(r.info?.lookupId, 'mcp-1'); rec(r.lookupId, 'mcp-2');
  assert.ok(r.info && r.info.lookupId, 'callTool failure was looked up'); assert.equal(r.cid, 'AN-2026-0082');
});
await check('ai-sdk tools execute', async () => {
  const { breakwireTools } = await import('breakwire/ai-sdk');
  const t = breakwireTools();
  const out = await t.breakwire_lookup_error.execute({ error: 'No signatures found matching the expected signature for payload', service: 'stripe' }, { toolCallId: 't1', messages: [] });
  rec(out.lookup_id, 'ai-sdk-tool');
  assert.equal(out.matches[0].id, 'AN-2026-0076');
  const d = await t.breakwire_deadlines.execute({ service: 'anthropic-api' }, { toolCallId: 't2', messages: [] });
  assert.ok(Array.isArray(d));
});
mock.close();
console.log(failed ? `${failed} FAILED` : 'ALL SNIPPETS OK');
process.exit(failed ? 1 : 0);
