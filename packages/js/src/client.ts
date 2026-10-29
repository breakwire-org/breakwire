import { redactSecrets } from './redact.js';
import { normalizeStack } from './stack.js';

export const VERSION = '0.6.0';
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
  /**
   * Channel tag sent as X-Breakwire-Client (server 0.8.0 counts lookups per client surface in /api/stats "channels";
   * aggregate counts only). Default "breakwire-js/<version>". Integrations set their own, e.g. "kit/cursor".
   */
  channel?: string;
  /** Custom fetch (tests, proxies). Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Extra literal strings or patterns to strip before sending (e.g. your own tokens). */
  secrets?: Array<string | RegExp>;
  /**
   * Extra origins (e.g. "https://staging.example") a redirect may lead to. By default only https://breakwire.org and
   * the base URL's origin are trusted. Redirects to any other origin are refused (nothing is re-sent), and credentials
   * (Authorization, Cookie) never cross origins: an authenticated request redirected to another origin is refused.
   */
  trustedOrigins?: string[];
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
  /** Short, token-cheap answer (server compact mode). */
  compact?: boolean;
  /** Return at most this many matches (1-10). */
  maxMatches?: number;
  /** Drop matches whose confidence_score is below this (0-1). */
  minScore?: number;
  /** On a miss, count the service's changes since this date (YYYY-MM-DD). Default: last 30 days. */
  since?: string;
  /** Set false to omit the one-line `reflex` snippet from the answer. */
  reflex?: boolean;
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
  /** Ready-to-paste citation with the claim URL (or the gap ticket on a miss). */
  cite?: string;
  /** Optional one-line AGENTS.md reflex snippet. */
  reflex?: string;
  /** Present on an exact signature match: the one-call outcome report. */
  please?: string;
  /** Present when not explained: gap ticket, coverage note, nearest claims, deadlines and recent changes. */
  miss?: { gap?: { id: string; status: string; url: string } | string; coverage_note?: string; note?: string; [k: string]: unknown };
  [k: string]: unknown;
}
/** Input for stack() / subscribe(): any mix of parsed fields and raw files (package.json, package-lock.json, yarn.lock,
 * requirements*.txt, pyproject.toml, poetry.lock, uv.lock, Pipfile.lock, .nvmrc, .python-version, vercel.json,
 * netlify.toml, .github/workflows/*.yml). Files are parsed in your process; only dependency and runtime facts are sent
 * (see previewStack). Pass { rawFiles: true } to send the files themselves instead. */
export interface StackInput {
  dependencies?: Record<string, string>; devDependencies?: Record<string, string>; engines?: Record<string, string>;
  packages?: string[]; services?: string[]; runtime?: string;
  files?: Record<string, string> | Array<{ path: string; content: string }>;
  package_json?: string | object; requirements_txt?: string; pyproject_toml?: string;
  [k: string]: unknown;
}
export interface StackSendOptions {
  /** Explicit opt-in: send the raw files/fields as given (the pre-0.6 behavior) instead of locally parsed facts. */
  rawFiles?: boolean;
}
export interface SubscribeOptions extends StackSendOptions {
  /** Alert this many days ahead of a deadline (1-180, default 30). */
  horizonDays?: number;
  /** Opt in to new-model launch alerts: true (the stack's services) or a list of service slugs. */
  launches?: boolean | string[];
  /** Optional https webhook. It must answer the signed verify POST (2xx, body containing the challenge). */
  webhookUrl?: string;
}
/** Lookup outcomes (close a lookup id) and claim outcomes (report on a claim id). */
export type LookupOutcome = 'fixed' | 'partial' | 'applies' | 'not_fixed' | 'wrong_match' | 'not_covered' | 'solved';
export type Outcome = LookupOutcome | 'confirmed' | 'disputed';
export const LOOKUP_OUTCOMES: readonly LookupOutcome[] = ['fixed', 'partial', 'applies', 'not_fixed', 'wrong_match', 'not_covered', 'solved'];
export interface ReportEnv { sdk?: string; sdk_version?: string; model?: string; runtime?: string; tested_at?: string; [k: string]: string | undefined }

export class BreakwireError extends Error {
  status: number; body: unknown;
  constructor(message: string, status: number, body: unknown) { super(message); this.name = 'BreakwireError'; this.status = status; this.body = body; }
}

const STACK_FIELDS = new Set(['files', 'package_json', 'requirements_txt', 'pyproject_toml', 'requirements', 'workflows', 'nvmrc', 'netlify_toml', 'vercel_json',
  'dependencies', 'devDependencies', 'peerDependencies', 'engines', 'packages', 'runtime', 'services', 'ecosystem']);
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const originOf = (u: string): string => new URL(u).origin;

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

/** Exactly what the client would send for this error after local redaction (pass extra secrets to strip too). */
export function previewRedaction(input: unknown, secrets: Array<string | RegExp> = []): string {
  const plain = input && typeof input === 'object' && !(input instanceof Error) && (Array.isArray(input) || [Object.prototype, null].includes(Object.getPrototypeOf(input)));
  return redactSecrets(plain || typeof input === 'string' ? input : errorText(input), secrets);
}

/** Exactly the /api/stack (or /api/subscriptions) body the client would send for this input. */
export function previewStack(input: StackInput, opts: StackSendOptions = {}): Record<string, unknown> {
  return opts.rawFiles ? { ...input } : normalizeStack(input as Record<string, any>).body;
}

export class Breakwire {
  readonly baseUrl: string; readonly timeoutMs: number;
  /** Origins a redirect may lead to (breakwire.org, the base URL's origin, options.trustedOrigins). */
  readonly trustedOrigins: ReadonlySet<string>;
  private pinnedOrigins: Set<string>;
  private apiKey?: string; private ua: string; readonly channel: string; private f: FetchLike; private secrets: Array<string | RegExp>;

  constructor(opts: BreakwireOptions = {}) {
    this.baseUrl = (opts.baseUrl || envVar('BREAKWIRE_BASE_URL') || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.apiKey = opts.apiKey || envVar('BREAKWIRE_API_KEY');
    this.ua = `breakwire-js/${VERSION}${opts.userAgent ? ' ' + opts.userAgent : ''}`;
    this.channel = String(opts.channel || envVar('BREAKWIRE_CLIENT') || `breakwire-js/${VERSION}`).replace(/[^\x21-\x7e]/g, '').slice(0, 80) || `breakwire-js/${VERSION}`;
    const f = opts.fetch || (globalThis as any).fetch;
    if (!f) throw new Error('breakwire: no fetch available (Node 18+, Workers, Deno, Bun and browsers have one; or pass options.fetch)');
    this.f = f.bind ? f.bind(globalThis) : f;
    this.secrets = opts.secrets || [];
    this.pinnedOrigins = new Set([originOf(DEFAULT_BASE_URL), ...(opts.trustedOrigins || []).map(originOf)]);
    this.trustedOrigins = new Set([originOf(this.baseUrl), ...this.pinnedOrigins]);
  }

  /** Strip secrets with the built-in rules plus your configured extra secrets. */
  redact(text: unknown): string { return redactSecrets(text, this.secrets); }

  /** Exactly what lookup() would send as the error text for this input, with this client's extra secrets. */
  previewRedaction(input: unknown): string { return previewRedaction(input, this.secrets); }

  async request<T = any>(method: string, path: string, body?: unknown, auth = false, bearer?: string): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': this.ua, 'x-breakwire-client': this.channel };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      let url = this.baseUrl + path;
      let req: { method: string; headers: Record<string, string>; body?: string } = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
      let res: any;
      for (let hop = 0; ; hop++) {
        res = await this.f(url, { ...req, signal: ctrl.signal, redirect: 'manual' });
        // Browsers hide manual redirects (opaqueredirect): the target cannot be checked, so never follow blindly.
        if (res.type === 'opaqueredirect') throw new BreakwireError(`Breakwire ${method} ${path}: redirect target not inspectable; set baseUrl to the final URL`, 0, null);
        const loc = REDIRECT_CODES.has(res.status) ? res.headers?.get?.('location') : null;
        if (!loc) break;
        if (hop >= 3) throw new BreakwireError(`Breakwire ${method} ${path}: too many redirects`, res.status, null);
        const next = this.followRedirect(url, String(loc), res.status, req, path);
        url = next.url; req = next.req;
      }
      const text = await res.text();
      let data: any = text;
      try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      if (!res.ok) throw new BreakwireError(`Breakwire ${method} ${path} -> ${res.status}${data?.error ? ': ' + data.error : ''}`, res.status, data);
      return data as T;
    } finally { clearTimeout(timer); }
  }

  /**
   * Redirect policy (0.6.0): follow only to trusted origins (breakwire.org, the base URL's origin, trustedOrigins);
   * never carry Authorization or Cookie to another origin (such a redirect is refused); no https -> http downgrade;
   * 307/308 keep the method and body; 301/302/303 turn GET/HEAD into GET and are an error for requests with a body
   * unless the target origin is pinned (breakwire.org or trustedOrigins), where the same request is re-sent.
   */
  private followRedirect(from: string, location: string, status: number, req: { method: string; headers: Record<string, string>; body?: string }, path: string) {
    const target = new URL(location, from);
    const fail = (why: string) => new BreakwireError(`Breakwire ${req.method} ${path}: refused ${status} redirect to ${target.origin}: ${why}`, status, { location: target.origin + target.pathname });
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw fail('unsupported scheme');
    if (new URL(from).protocol === 'https:' && target.protocol !== 'https:') throw fail('https -> http downgrade');
    if (!this.trustedOrigins.has(target.origin)) throw fail('untrusted origin (add it to trustedOrigins if it is yours)');
    const crossOrigin = target.origin !== originOf(from);
    const headers = { ...req.headers };
    if (crossOrigin) {
      if (Object.keys(headers).some((h) => /^(authorization|cookie|proxy-authorization)$/i.test(h))) throw fail('credentials never cross origins; set baseUrl to the new origin');
      for (const h of Object.keys(headers)) if (/^(authorization|cookie|proxy-authorization)$/i.test(h)) delete headers[h];
    }
    const m = req.method.toUpperCase();
    if (status === 307 || status === 308) return { url: target.toString(), req: { ...req, headers } };
    if (m === 'GET' || m === 'HEAD') return { url: target.toString(), req: { method: m, headers, body: undefined } };
    if (!this.pinnedOrigins.has(target.origin)) throw fail(`a ${status} would drop the ${m} body; update baseUrl (or pin the origin with trustedOrigins)`);
    return { url: target.toString(), req: { ...req, headers } };
  }

  /** The exact /api/lookup request body for this error and options (redacted). Also the local cache key. */
  lookupBody(error: unknown, opts: LookupOptions = {}): Record<string, unknown> {
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
    if (opts.compact) body.compact = true;
    if (opts.maxMatches) body.max_matches = Math.max(1, Math.min(10, Math.floor(opts.maxMatches)));
    if (opts.minScore != null) body.min_score = Math.max(0, Math.min(1, opts.minScore));
    if (opts.since) body.since = opts.since;
    if (opts.reflex === false) body.reflex = false;
    return body;
  }

  /** Match an error against documented signatures and claims. The error text is redacted before it is sent. */
  lookup(error: unknown, opts: LookupOptions = {}): Promise<LookupResult> {
    return this.request<LookupResult>('POST', '/api/lookup', this.lookupBody(error, opts));
  }

  /** Status of a gap ticket returned on a miss, e.g. gap("UX-0123456789"). */
  gap(id: string): Promise<any> {
    if (!/^UX-[0-9a-f]{10}$/.test(id)) return Promise.reject(new TypeError(`breakwire: not a gap id: ${id}`));
    return this.request('GET', `/api/gaps/${id}`);
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
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v != null) cleanEnv[k] = this.redact(v).slice(0, 200);
    const note = opts.note ? this.redact(opts.note).slice(0, 2000) : undefined;
    if (target.startsWith('lk_')) {
      // every lookup outcome the server accepts; confirmed/disputed map to fixed/not_fixed for backwards compatibility
      const o = outcome === 'confirmed' ? 'fixed' : outcome === 'disputed' ? 'not_fixed' : outcome;
      if (!(LOOKUP_OUTCOMES as readonly string[]).includes(o)) return Promise.reject(new TypeError(`breakwire: lookup outcome must be ${LOOKUP_OUTCOMES.join('|')}`));
      if (o === 'solved' && !note) return Promise.reject(new TypeError('breakwire: outcome "solved" needs opts.note (what fixed it)'));
      const cid = o === 'not_covered' || o === 'solved' ? undefined : opts.cid;
      return this.request('POST', `/api/lookups/${encodeURIComponent(target)}/outcome`, { cid, outcome: o, note, env: cleanEnv }, true);
    }
    if (/^AN-\d{4}-\d{4,}$/.test(target)) {
      const positive = outcome === 'fixed' || outcome === 'confirmed';
      if (!['fixed', 'not_fixed', 'confirmed', 'disputed'].includes(outcome)) return Promise.reject(new TypeError('breakwire: a claim report outcome must be fixed|not_fixed|confirmed|disputed'));
      if (!this.apiKey) return Promise.reject(new TypeError('breakwire: reporting on a claim needs an apiKey (or report on the lookup id instead)'));
      if (!positive && !note) return Promise.reject(new TypeError('breakwire: a disputed report needs opts.note'));
      return this.request('POST', `/api/claims/${target}/reports`, { outcome: positive ? 'confirmed' : 'disputed', env: cleanEnv, note, statement_index: opts.statementIndex }, true);
    }
    return Promise.reject(new TypeError(`breakwire: report target must be a lookup id (lk_...) or claim id (AN-...): ${target}`));
  }

  /** New model launches (official vendor sources only), newest first. since: YYYY-MM-DD or "30d". */
  async launches(opts: { since?: string; services?: string[] } = {}): Promise<any> {
    const q = new URLSearchParams();
    if (opts.since) q.set('since', opts.since);
    if (opts.services?.length) q.set('services', opts.services.join(','));
    return this.request<any>('GET', `/api/launches${q.toString() ? '?' + q.toString() : ''}`);
  }

  /** What changed since a date (claims, model launches, revisions). Call with your training cutoff after deploys/upgrades. */
  changes(from: string, opts: { to?: string; service?: string; kind?: string } = {}): Promise<any> {
    const q = new URLSearchParams({ from });
    if (opts.to) q.set('to', opts.to);
    if (opts.service) q.set('service', opts.service);
    if (opts.kind) q.set('kind', opts.kind);
    return this.request<any>('GET', `/api/changes?${q.toString()}`);
  }


  /** package.json fields, files or ["name@version", ...] -> applicable deadlines, advisories and breaking changes.
   * Files are parsed locally and only dependency/runtime facts are sent (previewStack shows the body); { rawFiles: true }
   * sends the raw input instead. An empty stack returns 200 with { empty: true, hint }. */
  stack(input: StackInput, opts: StackSendOptions = {}): Promise<any> {
    return this.request('POST', '/api/stack', previewStack(input, opts));
  }

  /** The exact body stack()/subscribe() would send for this input. Nothing is sent. */
  previewStack(input: StackInput, opts: StackSendOptions = {}): Record<string, unknown> { return previewStack(input, opts); }

  /**
   * Register a stack once and get alerts when a deadline or breaking change that affects it comes up.
   * Returns { id, manage_token (shown once: store it), feed: {json, atom, rss, status}, webhook?: {status, secret}, now, remember }.
   * No email or personal data is asked for or stored; only dependency facts from the input are kept.
   */
  subscribe(input: StackInput, opts: SubscribeOptions = {}): Promise<any> {
    const body: Record<string, unknown> = previewStack(input, opts);
    if (opts.horizonDays) body.horizon_days = opts.horizonDays;
    if (opts.webhookUrl) body.webhook_url = opts.webhookUrl;
    if (opts.launches) body.launches = opts.launches;
    return this.request('POST', '/api/subscriptions', body);
  }

  /** Pull alerts for a subscription (JSON). Poll before deploys or about weekly; alerts come first. */
  alerts(subscriptionId: string): Promise<any> {
    if (!/^sub_[A-Za-z0-9_-]{20,40}$/.test(subscriptionId)) return Promise.reject(new TypeError(`breakwire: not a subscription id: ${subscriptionId}`));
    return this.request('GET', `/api/subscriptions/${subscriptionId}/feed`);
  }

  /** Change the stack, horizon or webhook (webhookUrl null removes it). Needs the manage_token from subscribe(). */
  updateSubscription(subscriptionId: string, manageToken: string, patch: StackInput & { horizon_days?: number; webhook_url?: string | null }, opts: StackSendOptions = {}): Promise<any> {
    const stack: Record<string, unknown> = {}, rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) (STACK_FIELDS.has(k) ? stack : rest)[k] = v;
    const body: Record<string, unknown> = { ...(Object.keys(stack).length ? previewStack(stack, opts) : {}), ...rest };
    return this.request('PATCH', `/api/subscriptions/${subscriptionId}`, body, false, manageToken);
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
