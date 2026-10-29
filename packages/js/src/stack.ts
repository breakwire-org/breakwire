/**
 * Local stack normalization: parse package.json, lockfiles, requirements, pyproject, runtime files and workflow YAML
 * in-process and keep only dependency and runtime facts (names, versions, runtimes, action refs). Scripts, repository
 * URLs, private registry URLs, git/file/workspace dependencies, comments and everything else never leave the process.
 * Same rules as the Python client; both run tests/stack-cases.json.
 */
export interface StackFiles { [path: string]: string }
export type StackFileInput = StackFiles | Array<{ path: string; content: string }>;

const MAX_PACKAGES = 500;
const NON_REGISTRY_SPEC = /^(?:file|link|git|git\+[a-z]+|github|gitlab|bitbucket|https?|workspace|portal|patch|exec):|:\/\/|^[\w.-]+\/[\w.-]+(?:#.*)?$|^[.~/]/i;
const RAW_KEYS = new Set(['files', 'package_json', 'requirements_txt', 'pyproject_toml', 'requirements', 'workflows', 'nvmrc', 'netlify_toml', 'vercel_json']);
const DEP_KEYS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

const base = (p: string) => p.replace(/\\/g, '/').split('/').pop() || p;
const pep503 = (n: string) => n.toLowerCase().replace(/[-_.]+/g, '-');

function cleanDeps(d: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!d || typeof d !== 'object' || Array.isArray(d)) return out;
  for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
    if (typeof v !== 'string' || !/^(@[\w.-]+\/)?[\w.-]+$/.test(k)) continue;
    const spec = v.trim();
    if (NON_REGISTRY_SPEC.test(spec)) continue;
    out[k] = spec.slice(0, 64);
  }
  return out;
}

/** One requirements line -> "name<spec>" (PEP 503 name, no extras, markers, hashes, URLs or options), or null. */
export function normalizeRequirement(line: string): string | null {
  let s = line.replace(/(^|\s)#.*$/, '').trim();
  if (!s || s.startsWith('-') || /:\/\/|\s@\s|^[.\/~]/.test(s)) return null;
  s = s.split(';')[0].replace(/\s+--hash[=\s]\S+/g, '').trim();
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*((?:===|==|!=|~=|>=|<=|>|<)\s*[^\s,;]+(?:\s*,\s*(?:===|==|!=|~=|>=|<=|>|<)\s*[^\s,;]+)*)?\s*$/.exec(s);
  if (!m) return null;
  return pep503(m[1]) + (m[3] ? m[3].replace(/\s+/g, '') : '');
}

function poetrySpec(name: string, spec: string): string | null {
  const v = spec.trim();
  if (!v || v === '*') return pep503(name);
  let out: string;
  if (/^[\^~]=?\s*\d/.test(v)) out = '>=' + v.replace(/^[\^~]=?\s*/, '');
  else if (/^\d/.test(v)) out = '==' + v;
  else out = v.replace(/\s+/g, '');
  return normalizeRequirement(pep503(name) + out);
}

/** Tiny TOML helpers: enough for [project] / [tool.poetry] dependency tables. */
function tomlSections(text: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /^\s*\[([^\[\]\n]+)\]\s*$/gm;
  let m: RegExpExecArray | null, last: { name: string; start: number } | null = null;
  while ((m = re.exec(text))) {
    if (last) out.push({ name: last.name, body: text.slice(last.start, m.index) });
    last = { name: m[1].trim(), start: re.lastIndex };
  }
  if (last) out.push({ name: last.name, body: text.slice(last.start) });
  return out;
}
const tomlStrings = (s: string) => Array.from(s.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g), (x) => x[1] ?? x[2]);
function tomlArray(body: string, key: string): string[] {
  const m = new RegExp(`^\\s*${key.replace(/[-]/g, '\\-')}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm').exec(body);
  return m ? tomlStrings(m[1].replace(/#[^\n]*/g, '')) : [];
}

function parsePyproject(text: string, reqs: Set<string>): void {
  for (const { name, body } of tomlSections(text)) {
    if (name === 'project') for (const r of tomlArray(body, 'dependencies')) { const n = normalizeRequirement(r); if (n) reqs.add(n); }
    else if (name === 'project.optional-dependencies' || name === 'dependency-groups') {
      for (const m of body.matchAll(/^\s*[\w.-]+\s*=\s*\[([\s\S]*?)\]/gm)) for (const r of tomlStrings(m[1].replace(/#[^\n]*/g, ''))) { const n = normalizeRequirement(r); if (n) reqs.add(n); }
    } else if (/^tool\.poetry\.(?:dev-dependencies|dependencies|group\.[\w.-]+\.dependencies)$/.test(name)) {
      for (const m of body.matchAll(/^\s*([A-Za-z0-9][\w.-]*)\s*=\s*(.+)$/gm)) {
        if (m[1].toLowerCase() === 'python') continue;
        const val = m[2].trim();
        let spec: string | null = null;
        if (/^["']/.test(val)) spec = tomlStrings(val)[0] ?? null;
        else if (val.startsWith('{')) {
          if (/\b(?:path|git|url|file)\s*=/.test(val)) continue;
          const v = /\bversion\s*=\s*["']([^"']*)["']/.exec(val); spec = v ? v[1] : '*';
        }
        if (spec == null) continue;
        const n = poetrySpec(m[1], spec); if (n) reqs.add(n);
      }
    }
  }
}

function lockBlocks(text: string): string[] { return text.split(/^\s*\[\[package\]\]\s*$/m).slice(1); }
function parsePyLock(text: string, pkgs: Set<string>): void {
  for (const b of lockBlocks(text)) {
    const body = b.split(/^\s*\[\[/m)[0];
    const n = /^\s*name\s*=\s*"([^"]+)"/m.exec(body), v = /^\s*version\s*=\s*"([^"]+)"/m.exec(body);
    if (!n || !v) continue;
    if (/^\s*source\s*=\s*\{[^}]*\b(?:editable|virtual|path|directory|git|url)\s*=/m.test(body)) continue;
    if (/\[package\.source\][\s\S]*?\btype\s*=\s*"(?:git|directory|file|url)"/.test(body)) continue;
    pkgs.add(`pypi:${pep503(n[1])}==${v[1]}`);
  }
}

function parseNpmLock(text: string, pkgs: Set<string>): void {
  let j: any; try { j = JSON.parse(text); } catch { return; }
  const ok = (e: any) => e && typeof e.version === 'string' && !e.link && !(typeof e.resolved === 'string' && /^(?:file|git|link)[:+]/.test(e.resolved)) && !NON_REGISTRY_SPEC.test(e.version);
  if (j && j.packages && typeof j.packages === 'object') {
    for (const [k, e] of Object.entries<any>(j.packages)) {
      const parts = k.split('node_modules/');
      if (parts.length !== 2 || parts[0] !== '' || !ok(e)) continue;
      pkgs.add(`npm:${parts[1]}@${e.version}`);
    }
  } else if (j && j.dependencies && typeof j.dependencies === 'object') {
    for (const [k, e] of Object.entries<any>(j.dependencies)) if (ok(e)) pkgs.add(`npm:${k}@${e.version}`);
  }
}

function parseYarnLock(text: string, pkgs: Set<string>): void {
  for (const m of text.matchAll(/^"?((?:@[^@\s"\/]+\/)?[^@\s"\/,]+)@([^\n]*?)"?:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+version:?\s+"?([^"\s]+)"?/gm)) {
    if (/workspace:|file:|link:|portal:|patch:|git|https?:/.test(m[2])) continue;
    pkgs.add(`npm:${m[1]}@${m[3]}`);
  }
}

function parsePipfileLock(text: string, pkgs: Set<string>): void {
  let j: any; try { j = JSON.parse(text); } catch { return; }
  for (const sec of ['default', 'develop']) for (const [k, e] of Object.entries<any>(j?.[sec] || {})) {
    if (e && typeof e.version === 'string' && /^==/.test(e.version)) pkgs.add(`pypi:${pep503(k)}${e.version}`);
  }
}

function workflowUses(text: string, uses: Set<string>): void {
  for (const m of String(text).matchAll(/^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)/gm)) {
    const ref = m[1];
    if (ref.startsWith('./') || ref.startsWith('docker://') || !/^[\w.-]+\/[\w.\/-]+@[\w.\/-]+$/.test(ref)) continue;
    uses.add(ref);
  }
}

const nodeMajor = (s: string) => { const m = /^\s*v?(\d{1,2})(?:\.\d+){0,2}\s*$/.exec(s); return m ? m[1] : null; };

function setRuntime(rt: Record<string, string>, k: 'node' | 'python', v: string | null) { if (v && !rt[k]) rt[k] = v; }

function fromRuntimeFile(name: string, text: string, rt: Record<string, string>): boolean {
  const lower = name.toLowerCase();
  if (lower === '.nvmrc' || lower === '.node-version') { setRuntime(rt, 'node', nodeMajor(text.split('\n')[0])); return true; }
  if (lower === '.python-version') { const m = /^\s*(\d+\.\d+)/.exec(text); setRuntime(rt, 'python', m ? m[1] : null); return true; }
  if (lower === 'runtime.txt') { const m = /python-(\d+\.\d+)/.exec(text); setRuntime(rt, 'python', m ? m[1] : null); return true; }
  if (lower === 'vercel.json') { const m = /nodejs(\d{2})\.x/.exec(text); setRuntime(rt, 'node', m ? m[1] : null); return true; }
  if (lower === 'netlify.toml') { const m = /NODE_VERSION\s*=\s*["']?v?(\d{1,2})/.exec(text); setRuntime(rt, 'node', m ? m[1] : null); return true; }
  return false;
}

export interface NormalizeResult { body: Record<string, unknown>; ignored: string[] }

/** Parse a stack input locally. Returns the exact request body (dependency/runtime facts only) and the ignored file names. */
export function normalizeStack(input: Record<string, any> = {}): NormalizeResult {
  const deps: Record<string, Record<string, string>> = {};
  const engines: Record<string, string> = {};
  const pkgs = new Set<string>(), reqs = new Set<string>(), uses = new Set<string>();
  const rt: Record<string, string> = {};
  const ignored: string[] = [];
  const addPackageJson = (pj: any) => {
    if (typeof pj === 'string') { try { pj = JSON.parse(pj); } catch { return; } }
    if (!pj || typeof pj !== 'object') return;
    for (const k of DEP_KEYS) { const c = cleanDeps(pj[k]); if (Object.keys(c).length) deps[k] = { ...(deps[k] || {}), ...c }; }
    for (const [k, v] of Object.entries(pj.engines || {})) if (typeof v === 'string' && /^[\w-]+$/.test(k)) engines[k] = v.slice(0, 64);
  };
  const addReqText = (t: string) => { for (const line of String(t).split(/\r?\n/)) { const n = normalizeRequirement(line); if (n) reqs.add(n); } };

  // structured fields the caller already parsed: cleaned, never trusted blindly
  for (const k of DEP_KEYS) { const c = cleanDeps(input[k]); if (Object.keys(c).length) deps[k] = { ...(deps[k] || {}), ...c }; }
  if (input.engines) addPackageJson({ engines: input.engines });
  if (Array.isArray(input.packages)) for (const p of input.packages) if (typeof p === 'string' && p.trim() && !/:\/\//.test(p)) pkgs.add(p.trim().slice(0, 200));
  if (input.runtime && typeof input.runtime === 'object') {
    for (const [k, v] of Object.entries(input.runtime)) if ((typeof v === 'string' || typeof v === 'number') && /^[\w-]+$/.test(k)) rt[k] = String(v).slice(0, 32);
  } else if (typeof input.runtime === 'string') { const m = /^(node|python)\s*@?\s*v?(\d+(?:\.\d+)?)/i.exec(input.runtime); if (m) rt[m[1].toLowerCase()] = m[2]; }
  // raw text fields
  if (input.package_json) addPackageJson(input.package_json);
  if (typeof input.requirements_txt === 'string') addReqText(input.requirements_txt);
  if (typeof input.requirements === 'string') addReqText(input.requirements);
  if (typeof input.pyproject_toml === 'string') parsePyproject(input.pyproject_toml, reqs);
  if (Array.isArray(input.workflows)) for (const w of input.workflows) workflowUses(String(w), uses);
  if (typeof input.nvmrc === 'string') fromRuntimeFile('.nvmrc', input.nvmrc, rt);
  if (typeof input.netlify_toml === 'string') fromRuntimeFile('netlify.toml', input.netlify_toml, rt);
  if (typeof input.vercel_json === 'string') fromRuntimeFile('vercel.json', input.vercel_json, rt);
  // files: path -> content
  const files: Array<[string, string]> = Array.isArray(input.files) ? input.files.map((f: any) => [String(f?.path || ''), String(f?.content ?? '')])
    : input.files && typeof input.files === 'object' ? Object.entries(input.files).map(([p, c]) => [p, String(c ?? '')]) : [];
  for (const [path, text] of files) {
    const name = base(path), lower = name.toLowerCase(), norm = path.replace(/\\/g, '/');
    if (lower === 'package.json') addPackageJson(text);
    else if (lower === 'package-lock.json' || lower === 'npm-shrinkwrap.json') parseNpmLock(text, pkgs);
    else if (lower === 'yarn.lock') parseYarnLock(text, pkgs);
    else if (lower === 'poetry.lock' || lower === 'uv.lock') parsePyLock(text, pkgs);
    else if (lower === 'pipfile.lock') parsePipfileLock(text, pkgs);
    else if (lower === 'pyproject.toml') parsePyproject(text, reqs);
    else if (/^requirements[\w.-]*\.(?:txt|in)$/.test(lower) || lower === 'constraints.txt') addReqText(text);
    else if (fromRuntimeFile(name, text, rt)) { /* runtime */ }
    else if (/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(norm) || /\.ya?ml$/i.test(lower) && /^\s*(?:-\s*)?uses:/m.test(text)) workflowUses(text, uses);
    else ignored.push(name);
  }

  const body: Record<string, unknown> = {};
  // pass-through of non-raw scalar facts the server understands
  if (Array.isArray(input.services)) body.services = input.services.filter((s: unknown) => typeof s === 'string').map((s: string) => s.slice(0, 64));
  if (input.ecosystem === 'npm' || input.ecosystem === 'pypi') body.ecosystem = input.ecosystem;
  for (const k of DEP_KEYS) if (deps[k] && Object.keys(deps[k]).length) body[k] = sortObj(deps[k]);
  if (Object.keys(engines).length) body.engines = sortObj(engines);
  if (pkgs.size) body.packages = Array.from(pkgs).sort().slice(0, MAX_PACKAGES);
  if (reqs.size) body.requirements = Array.from(reqs).sort().join('\n');
  if (Object.keys(rt).length) body.runtime = sortObj(rt);
  if (uses.size) body.workflows = [Array.from(uses).sort().map((u) => `uses: ${u}`).join('\n')];
  // 0.7.0 (server 0.9.0+): model ids, feature flags and installed versions are facts, not files: cleaned and passed through
  const strList = (v: unknown, n: number) => Array.isArray(v) ? Array.from(new Set(v.filter((x): x is string => typeof x === 'string' && !!x.trim() && !/:\/\//.test(x)).map((x) => x.trim().slice(0, 100)))).slice(0, n) : [];
  const models = strList(input.models, 50), features = strList(input.features, 50);
  if (models.length) body.models = models;
  if (features.length) body.features = features;
  if (input.installed && typeof input.installed === 'object' && !Array.isArray(input.installed)) {
    const inst: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.installed)) if ((typeof v === 'string' || typeof v === 'number') && /^[@\w./:-]{1,214}$/.test(k)) inst[k] = String(v).slice(0, 64);
    if (Object.keys(inst).length) body.installed = sortObj(inst);
  }
  for (const [k, v] of Object.entries(input)) {
    if (RAW_KEYS.has(k) || k in body || (DEP_KEYS as readonly string[]).includes(k) || ['engines', 'packages', 'runtime', 'services', 'ecosystem', 'models', 'features', 'installed'].includes(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') body[k] = v; // e.g. horizon_days; strings/objects are not forwarded
  }
  return { body, ignored };
}

function sortObj<T>(o: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return out;
}
