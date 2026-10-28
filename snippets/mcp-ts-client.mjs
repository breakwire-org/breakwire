// MCP TypeScript SDK client: (1) wrap callTool so failures from ANY MCP server carry an explanation,
// (2) or call Breakwire's own MCP server (lookup_error) directly.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { withBreakwire } from 'breakwire';

const BASE = process.env.BREAKWIRE_BASE_URL || 'https://breakwire.org';

export async function main() {
  const client = new Client({ name: 'my-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(BASE + '/mcp'))); // any MCP server URL

  // --- (1) the drop-in part -----------------------------------------------------
  const callTool = withBreakwire((req) => client.callTool(req), { service: 'mcp', sdk: 'mcp-typescript-sdk', version: '1.32.2', logMiss: false });
  // ------------------------------------------------------------------------------
  let info;
  try {
    await callTool({ name: 'tool_that_does_not_exist', arguments: {} });
  } catch (err) {
    console.log('(1)', err.code, err.message.slice(0, 60), '->', err.breakwire?.id ?? 'no match', err.breakwire?.confidence ?? '');
    info = err.breakwire;
  }

  // --- (2) Breakwire as an MCP tool -----------------------------------------------
  const res = await client.callTool({ name: 'lookup_error', arguments: { error: 'Worker exceeded resource limits', service: 'cloudflare-workers', log_miss: false } });
  const data = JSON.parse(res.content[0].text);
  console.log('(2)', data.matches?.[0]?.cid, data.matches?.[0]?.confidence, data.lookup_id);
  await client.close();
  return { info, lookupId: data.lookup_id, cid: data.matches?.[0]?.cid };
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
