// Local stand-in for vendor APIs so the snippets can be run without API keys.
// Returns the vendors' documented error bodies (the same text Breakwire has signatures for).
import { createServer } from 'node:http';

const ANTHROPIC_400 = { type: 'error', error: { type: 'invalid_request_error', message: 'tool_choice: type "tool" and "any" are not supported for this model.' }, request_id: 'req_011CTEST0000000000000000' };
const OPENAI_429 = { error: { message: 'Your organization has reached its spend limit for this billing period.', type: 'insufficient_quota', param: null, code: 'organization_spend_limit_exceeded' } };

export function startMock(port = 0) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const send = (code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
        if (req.url.startsWith('/anthropic/')) return send(400, ANTHROPIC_400, { 'request-id': 'req_011CTEST0000000000000000' });
        if (req.url.startsWith('/openai/')) return send(429, OPENAI_429, { 'x-request-id': 'req_test' });
        send(404, { error: 'mock: unknown route ' + req.url });
      });
    });
    srv.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }));
  });
}
