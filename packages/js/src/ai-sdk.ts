/**
 * Vercel AI SDK tools (optional subpath: `breakwire/ai-sdk`; needs `ai` >= 5 installed).
 * Gives the model itself the ability to look up an error, check deadlines and read a claim.
 *
 *   import { breakwireTools } from 'breakwire/ai-sdk';
 *   await generateText({ model, tools: { ...breakwireTools() }, prompt });
 */
import { jsonSchema, tool } from 'ai';
import type { Tool } from 'ai';
import { Breakwire, BreakwireOptions, LookupResult } from './client.js';

export interface BreakwireToolsOptions extends BreakwireOptions {
  client?: Breakwire;
  /** Default false here: errors the model looks up are not logged as unexplained misses unless you opt in. */
  logMiss?: boolean;
  /** Max matches returned to the model (default 3). */
  maxMatches?: number;
}

/** Compact, token-cheap view of a lookup for a model. */
export function compactLookup(r: LookupResult, maxMatches = 3) {
  return {
    lookup_id: r.lookup_id,
    explained: r.explained,
    coverage_note: r.coverage && !r.coverage.covered ? r.coverage.note : undefined,
    matches: (r.matches || []).slice(0, maxMatches).map((m) => ({
      id: m.cid, title: m.title, confidence: m.confidence, fix: m.fix, deadline: m.deadline, url: m.url, source_url: m.source_url,
      verification: m.verification?.status,
    })),
    note: 'Claims are community data; "signature" = vendor-documented error text matched, "related" = a lead only. Prefer source_url.',
  };
}

const safe = async <T>(fn: () => Promise<T>): Promise<T | { error: string }> => {
  try { return await fn(); } catch (e: any) { return { error: `Breakwire unavailable: ${String(e?.message || e)}` }; }
};

export type BreakwireToolName = 'breakwire_lookup_error' | 'breakwire_deadlines' | 'breakwire_get_claim';

/** AI SDK tools: spread into `tools` of generateText/streamText/Agent. */
export function breakwireTools(opts: BreakwireToolsOptions = {}): Record<BreakwireToolName, Tool> {
  const bw = opts.client || new Breakwire(opts);
  const max = opts.maxMatches ?? 3;
  return {
    breakwire_lookup_error: tool({
      description: 'Look up an API/SDK/platform error message in Breakwire, a source-linked registry of breaking changes, deprecations and advisories. Returns the claim that explains it and the fix. Use when a call fails with an error you do not recognise.',
      inputSchema: jsonSchema<{ error: string; service?: string; sdk?: string; sdk_version?: string; model?: string }>({
        type: 'object',
        properties: {
          error: { type: 'string', description: 'The error message text (secrets are stripped before sending)' },
          service: { type: 'string', description: 'Service slug, e.g. anthropic-api, openai-api, stripe, cloudflare-workers, github-api, mcp' },
          sdk: { type: 'string' }, sdk_version: { type: 'string' }, model: { type: 'string' },
        },
        required: ['error'], additionalProperties: false,
      }),
      execute: async (i) => safe(async () => compactLookup(await bw.lookup(i.error, { service: i.service, sdk: i.sdk, version: i.sdk_version, model: i.model, logMiss: opts.logMiss ?? false }), max)),
    }),
    breakwire_deadlines: tool({
      description: 'Upcoming act-by dates (model retirements, API shutdowns, required migrations) for a service, soonest first.',
      inputSchema: jsonSchema<{ service?: string }>({ type: 'object', properties: { service: { type: 'string' } }, additionalProperties: false }),
      execute: async (i) => safe(async () => (await bw.deadlines(i.service, { limit: 10 })).map((c: any) => ({ id: c.cid, title: c.title, deadline: c.deadline, fix: c.fix, url: c.url }))),
    }),
    breakwire_get_claim: tool({
      description: 'Read one Breakwire claim by id (AN-YYYY-NNNN): statements, affected versions, fix, primary source.',
      inputSchema: jsonSchema<{ id: string }>({ type: 'object', properties: { id: { type: 'string', pattern: '^AN-\\d{4}-\\d{4,}$' } }, required: ['id'], additionalProperties: false }),
      execute: async (i) => safe(() => bw.claim(i.id)),
    }),
  };
}
