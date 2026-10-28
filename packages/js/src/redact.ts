/**
 * Client-side secret stripping. Runs before anything leaves the process.
 * The Breakwire server redacts again, but secrets should never be sent in the first place.
 * Order matters: specific token formats first, generic "key=value" and long-blob rules last.
 */
const RULES: Array<[RegExp, string]> = [
  // PEM private keys / certificates
  [/-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z0-9 ]*(PRIVATE KEY|CERTIFICATE)-----/g, '<secret>'],
  // credentials inside URLs: scheme://user:pass@host  (postgres://, redis://, https://, ...)
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s:@\/]+:[^\s@\/]+@/gi, '$1<secret>@'],
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
  // "Authorization: Bearer xyz", "api_key=xyz", "password: xyz", x-api-key headers
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <secret>'],
  [/((?:x-)?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|token|secret|password|passwd|pwd|authorization|cookie|set-cookie|session[_-]?id))(["']?\s*[:=]\s*["']?)[^\s"',;&}]{4,}/gi, '$1$2<secret>'],
  // e-mail addresses
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>'],
  // query strings and fragments on URLs (often carry tokens)
  [/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, '$1'],
  // IPv4
  [/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>'],
  // home directories: /home/alice/..., /Users/alice/..., C:\Users\alice\...
  [/(\/home\/|\/Users\/|[A-Za-z]:\\Users\\)[^\/\\\s"']+/g, '$1<user>'],
  // long hex strings (API keys, HMACs)
  [/\b[0-9a-fA-F]{32,}\b/g, '<secret>'],
  // any remaining long opaque blob (40+ chars mixing upper, lower and digits: base64 keys); plain URL paths survive
  [/(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{40,}={0,2}/g, '<secret>'],
];

export const MAX_ERROR_CHARS = 4000;

/** Remove secrets, credentials, emails, IPs, query strings and user names from text. */
export function redactSecrets(input: unknown, extra: Array<string | RegExp> = []): string {
  let s = String(input ?? '');
  for (const e of extra) {
    if (!e) continue;
    s = typeof e === 'string' ? s.split(e).join('<secret>') : s.replace(e.global ? e : new RegExp(e.source, e.flags + 'g'), '<secret>');
  }
  for (const [re, rep] of RULES) s = s.replace(re, rep);
  return s.slice(0, MAX_ERROR_CHARS);
}
