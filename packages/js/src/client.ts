import { redactSecrets } from './redact.js';

export const VERSION = '0.2.0';
export const DEFAULT_BASE_URL = 'https://breakwire.org';

type FetchLike = (input: string, init?: any) => Promise<any>;

export interface BreakwireOptions {
  /** Defaults to env BREAKWIRE_BASE_URL, then https://breakwire.org */
  baseUrl?: string;
  /** Per-request timeout in ms (default 3000). */
  timeoutMs?: number;
  /** Optional API key (only needed for claim reports; lookups and reads are anonymous). */
  apiKey?: string;
  /** Appended to the User-Agent, e.g. "my-agent/1.2". */
  userAgent?: string;
  /** Custom fetch (tests, proxies). Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Extra literal strings or patterns to strip before sending (e.g. your own tokens). */
  secrets?: Array<string | RegExp>;
}

export interface LookupOptions {
  /** Service slug, family or alias (see /api/services), e.g. "anthropic-api", "stripe", "cloudflare". Hard filter. */
  service?: string;
  sdk?: string;
  /** SDK version (sent as sdk_version). */
  version?: string;
  model?: string;
  httpStatus?: number;
  context?: string;
  crossService?: boolean;
  /** Log an unmatched error (redacted, anonymous) so clusters surface on /unexplained. Default true. */
  logMiss?: boolean;
  /**
   * Privacy mode: the server answers but stores nothing about this lookup (no lookup row, no gap, no lookup_id to
   * close). The error-path helpers (withBreakwire, breakwireFetch, explain, installBreakwire) default to true.
   */
  noLog?: boolean;
}

export interface Verification { status: string; reports: number; independent_operators: number; [k: string]: unknown }
export interface Match {
  cid: string; title: string; kind: string; confidence: 'signature' | 'related' | string; why: string; score: number;
  fix: string | null; deadline: string | null; severity: string | null; services: string[]; affected: string[]; fixed_in: string[];
  verification: Verification; source_url: string; url: string; json: string; [k: string]: unknown;
}
export interface LookupResult {
  lookup_id: string; normalized: string; explained: boolean; service: string | null;
  coverage: { service: string; covered: boolean; note: string | null; covered_services?: string[] } | null;
  matches: Match[]; unexplained: unknown; close_the_loop: unknown;
  /** One short line to save in agent memory: when to consult Breakwire again. */
  remember?: string;
  [k: string]: unknown;
}
/** Input for stack() / subscribe(): any mix of parsed fields and raw files (package.json, requirements*.txt,
 * pyproject.toml, .nvmrc, vercel.json, netlify.toml, .github/workflows/*.yml). Only dependency facts are kept. */
export interface StackInput {
  dependencies?: Record<string, string>; devDependencies?: Record<string, string>; engines?: Record<string, string>;
  packages?: string[]; services?: string[]; runtime?: string;
  files?: Record<string, string> | Array<{ path: string; content: string }>;
  package_json?: string | object; requirements_txt?: string; pyproject_toml?: string;
  [k: string]: unknown;
}
export interface SubscribeOptions {
  /** Alert this many days ahead of a deadline (1-180, default 30). */
  horizonDays?: number;
  /** Optional https webhook. It must answer the signed verify POST (2xx, body containing the challenge). */
  webhookUrl?: string;
}
export type Outcome = 'fixed' | 'not_fixed' | 'confirmed' | 'disputed';
export interface ReportEnv { sdk?: string; sdk_version?: string; model?: string; runtime?: string; tested_at?: string; [k: string]: string | undefined }

export class BreakwireError extends Error {
  status: number; body: unknown;
  constructor(message: string, status: number, body: unknown) { super(message); this.name = 'BreakwireError'; this.status = status; this.body = body; }
}

const envVar = (k: string): string | undefined => {
  try { return (globalThis as any).process?.env?.[k] || undefined; } catch { return undefined; }
};

/** Turn anything thrown into one line of error text (name, message, status, code, cause). Never includes stack traces. */
export function errorText(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  const e = err as any;
  const parts: string[] = [];
  const name = e.name && e.name !== 'Error' ? String(e.name) : '';
  const msg = typeof e.message === 'string' ? e.message : '';
  if (name || msg) parts.push(name && msg ? `${name}: ${msg}` : name || msg);
  const status = e.status ?? e.statusCode ?? e.response?.status;
  if (status && !msg.includes(String(status))) parts.push(`status ${status}`);
  const code = e.code ?? e.error?.type ?? e.error?.code;
  if (code && typeof code !== 'object' && !msg.includes(String(code))) parts.push(`code ${code}`);
  const inner = e.error?.message ?? e.error?.error?.message;
  if (typeof inner === 'string' && !msg.includes(inner)) parts.push(inner);
  // Vercel AI SDK APICallError / fetch wrappers keep the raw vendor body here
  if (typeof e.responseBody === 'string' && e.responseBody && !msg.includes(e.responseBody)) parts.push(e.responseBody.slice(0, 1500));
  if (e.cause && e.cause !== err) { const c = errorText(e.cause); if (c && !msg.includes(c)) parts.push(`cause: ${c}`); }
  if (!parts.length) { try { return JSON.stringify(err).slice(0, 2000); } catch { return String(err); } }
  return parts.join(' | ');
}

function httpStatusOf(err: unknown): number | undefined {
  const e = err as any; const s = e?.status ?? e?.statusCode ?? e?.response?.status;
  return typeof s === 'number' && s >= 100 && s < 600 ? s : undefined;
}

export class Breakwire {
  readonly baseUrl: string; readonly timeoutMs: number;
  private apiKey?: string; private ua: string; private f: FetchLike; private secrets: Array<string | RegExp>;

  constructor(opts: BreakwireOptions = {}) {
    this.baseUrl = (opts.baseUrl || envVar('BREAKWIRE_BASE_URL') || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.apiKey = opts.apiKey || envVar('BREAKWIRE_API_KEY');
    this.ua = `breakwire-js/${VERSION}${opts.userAgent ? ' ' + opts.userAgent : ''}`;
    const f = opts.fetch || (globalThis as any).fetch;
    if (!f) throw new Error('breakwire: no fetch available (Node 18+, Workers, Deno, Bun and browsers have one; or pass options.fetch)');
    this.f = f.bind ? f.bind(globalThis) : f;
    this.secrets = opts.secrets || [];
  }

  /** Strip secrets with the built-in rules plus your configured extra secrets. */
  redact(text: unknown): string { return redactSecrets(text, this.secrets); }

  async request<T = any>(method: string, path: string, body?: unknown, auth = false, bearer?: string): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': this.ua };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      let url = this.baseUrl + path;
      const init: any = { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal, redirect: 'manual' };
      let res = await this.f(url, init);
      // Host moves (workers.dev -> breakwire.org) answer 301. fetch would turn a redirected POST into a GET,
      // so re-send the same method and body to the new location once.
      for (let i = 0; i < 2 && res.status >= 301 && res.status <= 308 && res.headers?.get?.('location'); i++) {
        url = new URL(res.headers.get('location'), url).toString();
        res = await this.f(url, init);
      }
      if (res.type === 'opaqueredirect') res = await this.f(url, { ...init, redirect: 'follow' });
      const text = await res.text();
      let data: any = text;
      try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      if (!res.ok) throw new BreakwireError(`Breakwire ${method} ${path} -> ${res.status}${data?.error ? ': ' + data.error : ''}`, res.status, data);
      return data as T;
    } finally { clearTimeout(timer); }
  }

  /** Match an error against documented signatures and claims. The error text is redacted before it is sent. */
  lookup(error: unknown, opts: LookupOptions = {}): Promise<LookupResult> {
    const text = this.redact(errorText(error));
    const body: Record<string, unknown> = { error: text };
    if (opts.service) body.service = opts.service;
    if (opts.sdk) body.sdk = opts.sdk;
    if (opts.version) body.sdk_version = opts.version;
    if (opts.model) body.model = opts.model;
    const st = opts.httpStatus ?? httpStatusOf(error);
    if (st) body.http_status = st;
    if (opts.context) body.context = this.redact(opts.context).slice(0, 1000);
    if (opts.crossService) body.cross_service = true;
    if (opts.logMiss === false) body.log_miss = false;
    if (opts.noLog) body.no_log = true;
    return this.request<LookupResult>('POST', '/api/lookup', body);
  }

  /** Upcoming act-by dates, soonest first. */
  async deadlines(service?: string, opts: { kind?: string; limit?: number } = {}): Promise<any[]> {
    const q = new URLSearchParams();
    if (service) q.set('service', service);
    if (opts.kind) q.set('kind', opts.kind);
    if (opts.limit) q.set('limit', String(opts.limit));
    const r = await this.request<any>('GET', `/api/deadlines${q.toString() ? '?' + q.toString() : ''}`);
    return r.deadlines || r.claims || [];
  }

  /** Full claim record, e.g. claim("AN-2026-0001"); pass version for an immutable snapshot. */
  claim(id: string, opts: { version?: number } = {}): Promise<any> {
    if (!/^AN-\d{4}-\d{4,}$/.test(id)) return Promise.reject(new TypeError(`breakwire: not a claim id: ${id}`));
    return this.request('GET', `/api/claims/${id}${opts.version ? '/versions/' + opts.version : ''}`);
  }

  /**
   * Say whether a fix worked. Only call this after you actually applied the fix and observed the result.
   * - target "lk_..." (a lookup id): closes the lookup; anonymous unless an apiKey is set. Pass opts.cid to pick which match.
   * - target "AN-YYYY-NNNN" (a claim id): files an outcome report on the claim; needs an apiKey.
   */
  report(target: string, outcome: Outcome, env: ReportEnv = {}, opts: { cid?: string; note?: string; statementIndex?: number } = {}): Promise<any> {
    const positive = outcome === 'fixed' || outcome === 'confirmed';
    if (!['fixed', 'not_fixed', 'confirmed', 'disputed'].includes(outcome)) return Promise.reject(new TypeError('breakwire: outcome must be fixed|not_fixed|confirmed|disputed'));
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v != null) cleanEnv[k] = this.redact(v).slice(0, 200);
    const note = opts.note ? this.redact(opts.note).slice(0, 2000) : undefined;
    if (target.startsWith('lk_')) {
      return this.request('POST', `/api/lookups/${encodeURIComponent(target)}/outcome`, { cid: opts.cid, outcome: positive ? 'fixed' : 'not_fixed', note, env: cleanEnv }, true);
    }
    if (/^AN-\d{4}-\d{4,}$/.test(target)) {
      if (!this.apiKey) return Promise.reject(new TypeError('breakwire: reporting on a claim needs an apiKey (or report on the lookup id instead)'));
      if (!positive && !note) return Promise.reject(new TypeError('breakwire: a disputed report needs opts.note'));
      return this.request('POST', `/api/claims/${target}/reports`, { outcome: positive ? 'confirmed' : 'disputed', env: cleanEnv, note, statement_index: opts.statementIndex }, true);
    }
    return Promise.reject(new TypeError(`breakwire: report target must be a lookup id (lk_...) or claim id (AN-...): ${target}`));
  }

  /** package.json fields, raw files or ["name@version", ...] -> applicable deadlines, advisories and breaking changes.
   * An empty stack returns 200 with { empty: true, hint }. */
  stack(input: StackInput): Promise<any> {
    return this.request('POST', '/api/stack', input);
  }

  /**
   * Register a stack once and get alerts when a deadline or breaking change that affects it comes up.
   * Returns { id, manage_token (shown once: store it), feed: {json, atom, rss, status}, webhook?: {status, secret}, now, remember }.
   * No email or personal data is asked for or stored; only dependency facts from the input are kept.
   */
  subscribe(input: StackInput, opts: SubscribeOptions = {}): Promise<any> {
    const body: Record<string, unknown> = { ...input };
    if (opts.horizonDays) body.horizon_days = opts.horizonDays;
    if (opts.webhookUrl) body.webhook_url = opts.webhookUrl;
    return this.request('POST', '/api/subscriptions', body);
  }

  /** Pull alerts for a subscription (JSON). Poll before deploys or about weekly; alerts come first. */
  alerts(subscriptionId: string): Promise<any> {
    if (!/^sub_[A-Za-z0-9_-]{20,40}$/.test(subscriptionId)) return Promise.reject(new TypeError(`breakwire: not a subscription id: ${subscriptionId}`));
    return this.request('GET', `/api/subscriptions/${subscriptionId}/feed`);
  }

  /** Change the stack, horizon or webhook (webhookUrl null removes it). Needs the manage_token from subscribe(). */
  updateSubscription(subscriptionId: string, manageToken: string, patch: StackInput & { horizon_days?: number; webhook_url?: string | null }): Promise<any> {
    return this.request('PATCH', `/api/subscriptions/${subscriptionId}`, patch, false, manageToken);
  }

  /** Delete a subscription (clears the stored stack and webhook URL). Needs the manage_token. */
  unsubscribe(subscriptionId: string, manageToken: string): Promise<any> {
    return this.request('DELETE', `/api/subscriptions/${subscriptionId}`, undefined, false, manageToken);
  }

  /** Covered services with counts and aliases. */
  services(): Promise<any> { return this.request('GET', '/api/services'); }
}

/**
 * Verify a Breakwire webhook (X-Breakwire-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>).
 * Pass the raw request body string. Rejects signatures older than toleranceSec (default 300). Uses WebCrypto.
 */
export async function verifyWebhookSignature(secret: string, signatureHeader: string | null | undefined, rawBody: string, toleranceSec = 300): Promise<boolean> {
  try {
    const m = /t=(\d+),v1=([0-9a-f]{64})/.exec(String(signatureHeader || ''));
    if (!m) return false;
    const t = Number(m[1]);
    if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
    const subtle = (globalThis as any).crypto?.subtle;
    if (!subtle) return false;
    const enc = new TextEncoder();
    const key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await subtle.sign('HMAC', key, enc.encode(`${m[1]}.${rawBody}`)));
    const hex = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
    let diff = 0;
    for (let i = 0; i < 64; i++) diff |= hex.charCodeAt(i) ^ m[2].charCodeAt(i);
    return diff === 0;
  } catch { return false; }
}
