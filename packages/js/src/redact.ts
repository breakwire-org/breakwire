/**
 * Client-side secret stripping. Runs before anything leaves the process.
 * The Breakwire server redacts again, but secrets should never be sent in the first place.
 * Same rules as the Python client; both run the shared fixtures in tests/redaction-cases.json.
 * Order matters: specific token formats first, generic "key=value", ids, addresses and paths after, long blobs last.
 */
type Rule = [RegExp, string | ((...m: any[]) => string)];

const HTTP_METHOD_BEFORE = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+$/;
/** First path segments that mark an API route, not a filesystem path: kept so error signatures still match. */
const API_FIRST_SEGMENT = /^(?:v\d+[A-Za-z0-9.]*|api|apis|graphql|\.well-known|oauth2?|openai|rest|rpc|webhooks?|mcp)$/i;
const PKG_DIRS = new Set(['node_modules', 'site-packages', 'dist-packages']);
const HOME_DIRS = new Set(['home', 'users']);

/** Keys whose values are treated as secrets in structured (JSON / object) input. Matched after camelCase -> snake_case. */
const SECRET_KEY = /(?:^|[_.-])(?:secret|token|password|passwd|pwd|passphrase|apikey|api[_-]?key|authorization|auth|credentials?|private[_-]?key|cookie|set[_-]cookie|signature|access[_-]?key|session(?:[_-]?(?:id|token|key))?)$/i;
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase());
}

function pathReplacement(segs: string[], sep: string): string {
  const i = segs.findIndex((s) => PKG_DIRS.has(s.toLowerCase()));
  if (i >= 0) return '<path>' + sep + segs.slice(i).join(sep);
  if (segs.length <= 2 && HOME_DIRS.has(segs[0].toLowerCase())) return '<path>';
  return '<path>' + sep + segs[segs.length - 1];
}

function posixPath(m: string, offset: number, whole: string): string {
  const segs = m.split('/').filter(Boolean);
  if (!segs.length || API_FIRST_SEGMENT.test(segs[0])) return m;
  if (HTTP_METHOD_BEFORE.test(whole.slice(Math.max(0, offset - 12), offset))) return m;
  return pathReplacement(segs, '/');
}

function windowsPath(m: string): string {
  const body = m.replace(/^(?:[A-Za-z]:|\\+)/, '');
  const segs = body.split(/[\\/]+/).filter(Boolean);
  if (!segs.length) return m;
  return pathReplacement(segs, '\\');
}

const HEX4 = /^[0-9A-Fa-f]{1,4}$/;
function ipv6(m: string): string {
  if (!/\d/.test(m) || (m.match(/:/g) || []).length < 2) return m;
  let s = m, extra = 0;
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) { s = s.slice(0, -v4[1].length); if (!s.endsWith(':')) return m; s = s.endsWith('::') ? s : s.slice(0, -1); extra = 2; }
  const dbl = s.split('::');
  if (dbl.length > 2) return m;
  const groups = (part: string) => (part ? part.split(':') : []);
  const all = dbl.flatMap(groups);
  if (!all.every((g) => HEX4.test(g))) return m;
  const n = all.length + extra;
  if (dbl.length === 2 ? n > 7 : n !== 8) return m;
  return '<ip>';
}

function jsonField(m: string, key: string, colon: string): string {
  return isSecretKey(key) ? `"${key}"${colon}"<secret>"` : m;
}

const RULES: Rule[] = [
  // PEM private keys / certificates
  [/-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z0-9 ]*(PRIVATE KEY|CERTIFICATE)-----/g, '<secret>'],
  // credentials inside URLs, any scheme: scheme://user:pass@host, scheme://token@host (postgres, redis, amqps, mongodb+srv, https, ssh, ...)
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s\/@?#"'<>]+@/gi, '$1<secret>@'],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, '<secret>'],
  // Anthropic, OpenAI (sk-, sk-proj-), generic sk-/rk-/pk-
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '<secret>'],
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, '<secret>'],
  // Stripe: sk_live_, rk_test_, pk_live_, whsec_
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/g, '<secret>'],
  [/\bwhsec_[A-Za-z0-9+/=]{8,}/g, '<secret>'],
  // GitHub, Slack, Google, AWS, Breakwire keys, npm, HuggingFace, Resend
  [/\b(ghp|gho|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{10,}/g, '<secret>'],
  [/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, '<secret>'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '<secret>'],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, '<secret>'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '<secret>'],
  [/\ban_[A-Za-z0-9_-]{16,}/g, '<secret>'],
  [/\bnpm_[A-Za-z0-9]{20,}/g, '<secret>'],
  [/\bhf_[A-Za-z0-9]{20,}/g, '<secret>'],
  [/\bre_[A-Za-z0-9_]{16,}/g, '<secret>'],
  // "Authorization: Bearer xyz", "Basic xyz"
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <secret>'],
  // structured JSON: "client_secret": "...", "accessToken": "...", "x-api-key": "..."
  [/"([^"\\\n]{1,64})"(\s*:\s*)"(?:[^"\\\n]|\\.)*"/g, jsonField],
  // request / trace / correlation ids in headers or fields
  [/\b((?:x-)?(?:request|trace|correlation|span|amzn-request|amz-request)[ _-]?id|x-amzn-trace-id|cf-ray|traceparent)(["']?\s*[:=]\s*["']?)[^\s"',;&}]{4,}/gi, '$1$2<id>'],
  [/\b00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}\b/g, '<id>'],
  [/\breq_[A-Za-z0-9]{8,}/g, '<id>'],
  // "api_key=xyz", "password: xyz", x-api-key headers
  [/((?:x-)?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|token|secret|password|passwd|pwd|authorization|cookie|set-cookie|session[_-]?id))(["']?\s*[:=]\s*["']?)[^\s"',;&}]{4,}/gi, '$1$2<secret>'],
  // e-mail addresses
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>'],
  // query strings and fragments on URLs of any scheme (often carry tokens)
  [/(\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, '$1'],
  // UUIDs (request ids, account ids)
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<uuid>'],
  // IPv6 (validated: 8 groups, or one "::"; must contain a digit), then IPv4
  [/(?<![0-9A-Za-z_:.])[0-9A-Fa-f:]{2,39}(?:\d{1,3}(?:\.\d{1,3}){3})?(?![0-9A-Za-z_:]|\.\d)/g, ipv6],
  [/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>'],
  // UNC paths (\\server\share\...) and Windows drive paths (C:\..., C:/...), keeping only the file name or the package tail
  [/(?<![A-Za-z0-9_\\])\\{2,4}[A-Za-z0-9._$-]+(?:\\{1,2}[^\\\s"'<>:|?*]+)+/g, windowsPath],
  [/(?<![A-Za-z0-9_])[A-Za-z]:(?:\\{1,2}|\/)[^\\\/\s"'<>:|?*]+(?:(?:\\{1,2}|\/)[^\\\/\s"'<>:|?*]+)*/g, windowsPath],
  // absolute POSIX paths with 2+ segments (API routes like /v1/messages, and "POST /x/y", are kept)
  [/(?<![A-Za-z0-9_.:\/~@\]>-])\/(?:[^\s\/\\"'<>:;,()\[\]{}|*?]+\/)+[^\s\/\\"'<>:;,()\[\]{}|*?]*/g, posixPath],
  // long hex strings (API keys, HMACs)
  [/\b[0-9a-fA-F]{32,}\b/g, '<secret>'],
  // any remaining long opaque blob (40+ chars mixing upper, lower and digits: base64 keys); plain URL paths survive
  [/(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{40,}={0,2}/g, '<secret>'],
];

export const MAX_ERROR_CHARS = 4000;

function isPlainStructure(v: unknown): v is object {
  if (!v || typeof v !== 'object' || v instanceof Error) return false;
  if (Array.isArray(v)) return true;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

/** Replace the values of secret-looking keys in a plain object/array (deep copy). */
export function redactStructure(v: unknown, depth = 0): unknown {
  if (depth > 20) return '<truncated>';
  if (Array.isArray(v)) return v.map((x) => redactStructure(x, depth + 1));
  if (isPlainStructure(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = isSecretKey(k) && (x == null || typeof x !== 'object') ? '<secret>' : redactStructure(x, depth + 1);
    }
    return out;
  }
  return v;
}

/** Remove secrets, credentials, emails, IPs, ids, query strings and filesystem paths from text (or a plain object). */
export function redactSecrets(input: unknown, extra: Array<string | RegExp> = []): string {
  let s: string;
  if (isPlainStructure(input)) { try { s = JSON.stringify(redactStructure(input)); } catch { s = String(input); } }
  else s = String(input ?? '');
  for (const e of extra) {
    if (!e) continue;
    s = typeof e === 'string' ? s.split(e).join('<secret>') : s.replace(e.global ? e : new RegExp(e.source, e.flags + 'g'), '<secret>');
  }
  for (const [re, rep] of RULES) s = s.replace(re, rep as any);
  return s.slice(0, MAX_ERROR_CHARS);
}
