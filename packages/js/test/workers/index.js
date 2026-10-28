import { Breakwire, withBreakwire } from '../../dist/esm/index.js';
export default {
  async fetch(req, env) {
    const bw = new Breakwire({ baseUrl: 'https://agent-news.ethan-hawkes.workers.dev', userAgent: 'breakwire-kit-workers-test', timeoutMs: 8000 });
    const f = withBreakwire(async () => { throw new Error('Worker exceeded resource limits'); }, { client: bw, service: 'cloudflare-workers', logMiss: false });
    try { await f(); } catch (e) { return Response.json({ ok: true, runtime: 'workerd', id: e.breakwire?.id, confidence: e.breakwire?.confidence, lookupId: e.breakwire?.lookupId, error: e.breakwire?.error || null }); }
    return Response.json({ ok: false });
  },
};
