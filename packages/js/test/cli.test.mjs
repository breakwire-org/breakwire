// breakwire brief CLI: silent when clear or unavailable, prints the brief when act/block, sends parsed facts only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'esm', 'bin.js');

function run(args, env) {
  return new Promise((resolve) => execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
}

async function server(reply) {
  const bodies = [];
  const s = createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      bodies.push({ url: req.url, body: b ? JSON.parse(b) : null });
      const [status, obj] = reply(bodies.length);
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj));
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, bodies, close: () => s.close() };
}

function project() {
  const d = mkdtempSync(join(tmpdir(), 'bw-cli-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { openai: '4.77.0' }, scripts: { secret: 'do-not-send' } }));
  writeFileSync(join(d, '.nvmrc'), '20\n');
  return d;
}

test('clear prints nothing and sends parsed facts only', async () => {
  const s = await server(() => [200, { decision: 'clear', next_cursor: 7, stack_fingerprint: 'sha256:x' }]);
  const r = await run(['brief', project()], { BREAKWIRE_BASE_URL: s.url, BREAKWIRE_STATE_DIR: mkdtempSync(join(tmpdir(), 'bw-st-')), BREAKWIRE_SERVICES: 'openai-api' });
  s.close();
  assert.equal(r.code, 0); assert.equal(r.stdout, '');
  assert.equal(s.bodies[0].url, '/api/session-brief');
  assert.deepEqual(s.bodies[0].body.services, ['openai-api']);
  assert.ok(!JSON.stringify(s.bodies[0].body).includes('do-not-send'));
  assert.ok(!('files' in s.bodies[0].body));
});

test('act prints the brief; unavailable is silent; BREAKWIRE_BRIEF=0 sends nothing', async () => {
  const s = await server(() => [200, { decision: 'act', stack_fingerprint: 'sha256:x', items: [{ cid: 'AN-2026-0080', applies: 'runtime_version', why_now: 'overdue', action: 'Move to Node 22.', source_url: 'https://nodejs.org/x' }] }]);
  const st = mkdtempSync(join(tmpdir(), 'bw-st-'));
  const r = await run(['brief', project()], { BREAKWIRE_BASE_URL: s.url, BREAKWIRE_STATE_DIR: st });
  assert.match(r.stdout, /AN-2026-0080/); assert.match(r.stdout, /https:\/\/nodejs\.org\/x/);
  const off = await run(['brief', project()], { BREAKWIRE_BASE_URL: s.url, BREAKWIRE_STATE_DIR: st, BREAKWIRE_BRIEF: '0' });
  assert.equal(off.stdout, ''); assert.equal(s.bodies.length, 1);
  s.close();
  const down = await run(['brief', project(), '--timeout', '500'], { BREAKWIRE_BASE_URL: 'http://127.0.0.1:9', BREAKWIRE_STATE_DIR: st });
  assert.equal(down.code, 0); assert.equal(down.stdout, '');
});
