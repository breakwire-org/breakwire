// OpenAI Agents SDK (JS): wrap run() so a failed run carries its explanation,
// and give the agent a Breakwire tool for errors it hits in its own tool calls.
import OpenAI from 'openai';
import { Agent, run, tool, setDefaultOpenAIClient, setTracingDisabled } from '@openai/agents';
import { z } from 'zod';
import { Breakwire, withBreakwire } from 'breakwire';

if (process.env.OPENAI_BASE_URL) { setDefaultOpenAIClient(new OpenAI({ baseURL: process.env.OPENAI_BASE_URL, maxRetries: 0 })); setTracingDisabled(true); }

// --- the drop-in part ---------------------------------------------------------
const bw = new Breakwire();
const lookupError = tool({
  name: 'breakwire_lookup_error',
  description: 'Look up an API/SDK error in Breakwire (source-linked breaking changes, deprecations, advisories) and get the fix.',
  parameters: z.object({ error: z.string(), service: z.string().nullable() }),
  execute: async ({ error, service }) => {
    const r = await bw.lookup(error, { service: service ?? undefined, logMiss: false });
    return r.matches.slice(0, 3).map((m) => ({ id: m.cid, confidence: m.confidence, fix: m.fix, url: m.url }));
  },
});
const runWithBreakwire = withBreakwire(run, { client: bw, service: 'openai-api', sdk: 'openai-agents-js' });
// ------------------------------------------------------------------------------

export async function main() {
  const agent = new Agent({ name: 'Assistant', instructions: 'Be brief.', tools: [lookupError] });
  try {
    await runWithBreakwire(agent, 'Say hi');
  } catch (err) {
    console.log(err.constructor.name, err.breakwire?.id, err.breakwire?.confidence, '->', err.breakwire?.fix);
    return err.breakwire;
  }
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
