import { Breakwire, BreakwireOptions, LookupOptions, LookupResult, Match, ReportEnv } from './client.js';

/** What gets attached to an error as `err.breakwire`. */
export interface BreakwireInfo {
  /** Lookup id; pass to report() after you applied a fix. */
  lookupId: string | null;
  /** true only when a vendor-documented error signature matched. */
  explained: boolean;
  /** Best match, or null. */
  id: string | null; title: string | null; fix: string | null; confidence: string | null; url: string | null; deadline: string | null;
  matches: Match[];
  coverage: LookupResult['coverage'];
  /** Set when Breakwire itself failed (timeout, network, rate limit). The original error is still thrown. */
  error?: string;
}

export interface WrapOptions extends BreakwireOptions, LookupOptions {
  /** Reuse a client instead of building one from the options. */
  client?: Breakwire;
  /** Lookup timeout in ms (default 2500). The original error is rethrown after at most this long. */
  timeoutMs?: number;
  /** Only look up errors for which this returns true (e.g. skip your own validation errors). */
  shouldLookup?: (err: unknown) => boolean;
  /** Called with the match info (after it is attached to the error). Errors thrown here are ignored. */
  onMatch?: (info: BreakwireInfo, err: unknown) => void;
  /**
   * Optional: try a fix. Called when a lookup returned a match. Return a promise to retry (e.g. with the
   * suggested model / parameter), or undefined to skip. If it resolves, its value is returned instead of throwing.
   */
  retry?: (info: BreakwireInfo, err: unknown, args: any[]) => Promise<any> | undefined;
  /**
   * Explicit opt-in: when `retry` ran, report its outcome on the lookup ("fixed" if it resolved, "not_fixed" if it
   * threw). Nothing is ever reported without this flag, and never without a retry that actually applied the fix.
   */
  autoReport?: boolean;
  /** Environment attached to auto-reports (sdk, sdk_version, model, runtime). Redacted before sending. */
  reportEnv?: ReportEnv;
}

const clientCache = new WeakMap<object, Breakwire>();

function makeInfo(r: LookupResult | null, error?: string): BreakwireInfo {
  const m = r?.matches?.[0];
  return {
    lookupId: r?.lookup_id ?? null, explained: !!r?.explained,
    id: m?.cid ?? null, title: m?.title ?? null, fix: m?.fix ?? null, confidence: m?.confidence ?? null, url: m?.url ?? null, deadline: m?.deadline ?? null,
    matches: r?.matches ?? [], coverage: r?.coverage ?? null, ...(error ? { error } : {}),
  };
}

function attach(err: unknown, info: BreakwireInfo): void {
  if (err && (typeof err === 'object' || typeof err === 'function')) {
    try { Object.defineProperty(err, 'breakwire', { value: info, enumerable: false, configurable: true, writable: true }); } catch { /* frozen */ }
  }
}

/**
 * Look up an error and return match info. Never throws: Breakwire failures come back as info.error.
 * Bounded by opts.timeoutMs (default 2500 ms).
 */
export async function explain(err: unknown, opts: WrapOptions = {}): Promise<BreakwireInfo> {
  try {
    const timeoutMs = opts.timeoutMs ?? 2500;
    const client = opts.client || new Breakwire({ ...opts, timeoutMs });
    let timer: any;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`breakwire lookup timed out after ${timeoutMs} ms`)), timeoutMs); });
    try {
      const r = await Promise.race([client.lookup(err, opts), timeout]);
      return makeInfo(r);
    } finally { clearTimeout(timer); }
  } catch (e: any) {
    return makeInfo(null, String(e?.message || e));
  }
}

/**
 * Wrap an async function. On a thrown error, Breakwire looks it up, attaches `err.breakwire` (id, fix, confidence, ...)
 * and rethrows the ORIGINAL error. Breakwire problems never replace or mask your error.
 *
 *   const create = withBreakwire((p) => anthropic.messages.create(p), { service: 'anthropic-api' });
 *   try { await create(params) } catch (e) { console.log(e.breakwire?.fix) }
 */
export function withBreakwire<A extends any[], R>(fn: (...args: A) => R | Promise<R>, opts: WrapOptions = {}): (...args: A) => Promise<R> {
  let client = opts.client;
  return async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (err) {
      let ok = true;
      try { ok = opts.shouldLookup ? !!opts.shouldLookup(err) : true; } catch { ok = false; }
      if (!ok) throw err;
      if (!client) { try { client = new Breakwire({ ...opts, timeoutMs: opts.timeoutMs ?? 2500 }); } catch { throw err; } }
      const info = await explain(err, { ...opts, client });
      attach(err, info);
      try { opts.onMatch?.(info, err); } catch { /* ignore */ }
      if (opts.retry && info.lookupId && info.id) {
        let p: Promise<any> | undefined;
        try { p = opts.retry(info, err, args); } catch { p = undefined; }
        if (p && typeof (p as any).then === 'function') {
          try {
            const value = await p;
            if (opts.autoReport) await safeReport(client, info, 'fixed', opts.reportEnv);
            return value as R;
          } catch (retryErr) {
            if (opts.autoReport) await safeReport(client, info, 'not_fixed', opts.reportEnv, retryErr);
            throw err;
          }
        }
      }
      throw err;
    }
  };
}

async function safeReport(client: Breakwire, info: BreakwireInfo, outcome: 'fixed' | 'not_fixed', env?: ReportEnv, retryErr?: unknown): Promise<void> {
  try {
    await client.report(info.lookupId!, outcome, env || {}, { cid: info.id!, note: outcome === 'not_fixed' ? `retry with suggested fix still failed: ${client.redact(String((retryErr as any)?.message || retryErr)).slice(0, 300)}` : undefined });
  } catch { /* never surface Breakwire failures */ }
}

export interface FetchWrapOptions extends WrapOptions {
  /** Look up HTTP responses with status >= this (default 400). Set 0 to only look up network errors. */
  minStatus?: number;
}

/**
 * Wrap fetch. Network errors get `err.breakwire` and are rethrown. Error responses (>= 400 by default) are returned
 * unchanged, with `res.breakwire` set (the body is read from a clone, so you can still read it).
 *
 *   const f = breakwireFetch(fetch, { service: 'openai-api' });
 *   const res = await f(url, init); if (!res.ok) console.log(res.breakwire?.fix);
 */
export function breakwireFetch(fetchImpl: (input: any, init?: any) => Promise<any> = (globalThis as any).fetch, opts: FetchWrapOptions = {}): (input: any, init?: any) => Promise<any> {
  const min = opts.minStatus ?? 400;
  let client = opts.client;
  const getClient = () => (client ||= new Breakwire({ ...opts, timeoutMs: opts.timeoutMs ?? 2500 }));
  return async (input: any, init?: any) => {
    let res: any;
    try {
      res = await fetchImpl(input, init);
    } catch (err) {
      let c: Breakwire | undefined; try { c = getClient(); } catch { throw err; }
      const info = await explain(err, { ...opts, client: c });
      attach(err, info);
      try { opts.onMatch?.(info, err); } catch { /* ignore */ }
      throw err;
    }
    if (min && res && typeof res.status === 'number' && res.status >= min) {
      try {
        let body = '';
        try { body = (await res.clone().text()).slice(0, 3000); } catch { /* unreadable */ }
        const info = await explain(`HTTP ${res.status} ${res.statusText || ''} ${body}`.trim(), { ...opts, client: getClient(), httpStatus: res.status });
        attach(res, info);
        try { opts.onMatch?.(info, res); } catch { /* ignore */ }
      } catch { /* never break the caller */ }
    }
    return res;
  };
}
