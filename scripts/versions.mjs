#!/usr/bin/env node
// Writes versions.json into package manifests, source constants and README banners (default), or with --check
// fails (exit 1) when anything is stale. No dependencies. Run from anywhere: node scripts/versions.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const v = JSON.parse(readFileSync(join(root, 'versions.json'), 'utf8'));
const C = v.clients, S = v.server, A = v.action;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const banner = `<!-- versions:begin (generated from versions.json by scripts/versions.mjs; do not edit) -->
**Current release:** clients **${C}** (npm \`breakwire\`, PyPI \`breakwire\`, PyPI \`langchain-breakwire\`) · server **${S}** · GitHub Action \`breakwire-check\` **${A}** · [CHANGELOG](https://github.com/breakwire-org/breakwire/blob/main/CHANGELOG.md)
<!-- versions:end -->`;
const BANNER_RE = /<!-- versions:begin[\s\S]*?<!-- versions:end -->/;

/** [file, [[regex with one capture group for the version, expected]]] */
const pinned = [
  ['packages/js/package.json', [[/^  "version": "([^"]+)"/m, C]]],
  ['packages/js/package-lock.json', [[/^  "version": "([^"]+)"/m, C], [/"packages": \{\s*"": \{\s*"name": "breakwire",\s*"version": "([^"]+)"/, C]]],
  ['packages/js/src/client.ts', [[/export const VERSION = '([^']+)'/, C]]],
  ['packages/python/pyproject.toml', [[/^version = "([^"]+)"/m, C]]],
  ['packages/python/src/breakwire/client.py', [[/^__version__ = "([^"]+)"/m, C]]],
  ['packages/langchain-breakwire/pyproject.toml', [[/^version = "([^"]+)"/m, C], [/"breakwire>=([^"]+)"/, C]]],
  ['packages/langchain-breakwire/src/langchain_breakwire/__init__.py', [[/^__version__ = "([^"]+)"/m, C]]],
  ['action/package.json', [[/"version": "([^"]+)"/, A]]],
  ['plugins/claude-code/breakwire/hooks/hooks.json', [[/npx -y breakwire@(\d+\.\d+\.\d+)/, C]]],
];
const banners = ['README.md', 'packages/js/README.md', 'packages/python/README.md', 'packages/langchain-breakwire/README.md'];
// Docs that must not advertise another version as current (history lives in CHANGELOG.md / "## x.y.z" sections).
const STALE = [
  [/\bclients? (\d+\.\d+\.\d+)\b(?![^\n]*CHANGELOG)/g, C, 'clients'],
  [/\bserver (\d+\.\d+\.\d+)\b/g, S, 'server'],
  [/\b(?:npm i|npm install|pip install) (?:langchain-)?breakwire(?:@|==)(\d+\.\d+\.\d+)/g, C, 'install pin'],
];

let problems = 0, changed = 0;
for (const [file, rules] of pinned) {
  const p = join(root, file);
  let s = readFileSync(p, 'utf8'); const before = s;
  for (const [re, want] of rules) {
    const m = re.exec(s);
    if (!m) { console.error(`✗ ${file}: pattern ${re} not found`); problems++; continue; }
    if (m[1] !== want) {
      if (check) { console.error(`✗ ${file}: ${m[1]} != ${want}`); problems++; }
      else s = s.replace(re, (all) => all.replace(m[1], want));
    }
  }
  if (!check && s !== before) { writeFileSync(p, s); changed++; console.log(`updated ${file}`); }
}
for (const file of banners) {
  const p = join(root, file);
  let s = readFileSync(p, 'utf8');
  if (!BANNER_RE.test(s)) {
    if (check) { console.error(`✗ ${file}: no versions banner`); problems++; continue; }
    const lines = s.split('\n'); const h = lines.findIndex((l) => l.startsWith('# '));
    lines.splice(h + 1, 0, '', banner); s = lines.join('\n');
  } else if (s.match(BANNER_RE)[0] !== banner) {
    if (check) { console.error(`✗ ${file}: versions banner is stale`); problems++; continue; }
    s = s.replace(BANNER_RE, banner);
  } else continue;
  writeFileSync(p, s); changed++; console.log(`updated banner in ${file}`);
}
for (const file of banners) {
  const body = readFileSync(join(root, file), 'utf8').replace(BANNER_RE, '')
    // version-history sections ("## 0.5.0", "## 0.4.0 (clients) / server 0.7.0") are allowed to name old versions
    .split(/^(?=## )/m).filter((sec) => !/^## v?\d+\.\d+\.\d+/.test(sec)).join('');
  for (const [re, want, what] of STALE) {
    for (const m of body.matchAll(re)) if (m[1] !== want) { console.error(`✗ ${file}: stale ${what} version "${m[0]}" (current ${want})`); problems++; }
  }
}
if (problems) { console.error(`\n${problems} version problem(s). Edit versions.json and run: node scripts/versions.mjs`); process.exit(1); }
console.log(check ? `versions OK (clients ${C}, server ${S}, action ${A})` : `synced (${changed} file(s) changed)`);
