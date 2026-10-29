/**
 * breakwire brief [dir]   Session-start preflight for the project in dir (default: cwd).
 *
 * Reads package.json, requirements.txt, pyproject.toml, .nvmrc, .node-version and .python-version from dir, parses them
 * locally and sends only dependency and runtime facts to POST /api/session-brief. Prints nothing when the decision is
 * clear or Breakwire is unavailable (fail-open, always exits 0); otherwise prints a short source-linked brief.
 * Env: BREAKWIRE_SERVICES / BREAKWIRE_MODELS / BREAKWIRE_FEATURES (comma lists), BREAKWIRE_BRIEF=0 to disable,
 * BREAKWIRE_BASE_URL, BREAKWIRE_STATE_DIR. Flags: --json (print the whole brief), --timeout <ms>.
 */
import { Breakwire, VERSION } from './client.js';

declare const process: any;

const FILES = ['package.json', 'requirements.txt', 'pyproject.toml', '.nvmrc', '.node-version', '.python-version'];
const MAX_FILE = 256 * 1024;

function list(v: string | undefined): string[] | undefined {
  const out = (v || '').split(',').map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

export async function runCli(argv: string[]): Promise<number> {
  const args = argv.slice();
  const cmd = args.shift();
  if (cmd !== 'brief') {
    process.stdout.write(`breakwire ${VERSION}\nusage: breakwire brief [dir] [--json] [--timeout ms]\n`);
    return cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === '--version' ? 0 : 2;
  }
  if (process.env.BREAKWIRE_BRIEF === '0') return 0;
  const json = args.includes('--json');
  const ti = args.indexOf('--timeout');
  const timeoutMs = ti >= 0 ? Number(args[ti + 1]) || 5000 : 5000;
  const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--timeout') || process.cwd();
  try {
    const spec = 'node:fs/promises';
    const pathSpec = 'node:path';
    const fs: any = await import(/* @vite-ignore */ spec);
    const path: any = await import(/* @vite-ignore */ pathSpec);
    const files: Record<string, string> = {};
    for (const f of FILES) {
      try {
        const st = await fs.stat(path.join(dir, f));
        if (st.isFile() && st.size <= MAX_FILE) files[f] = await fs.readFile(path.join(dir, f), 'utf8');
      } catch { /* missing */ }
    }
    const input: Record<string, unknown> = { files };
    const services = list(process.env.BREAKWIRE_SERVICES), models = list(process.env.BREAKWIRE_MODELS), features = list(process.env.BREAKWIRE_FEATURES);
    if (services) input.services = services;
    if (models) input.models = models;
    if (features) input.features = features;
    if (!Object.keys(files).length && !services && !models) return 0;
    const bw = new Breakwire({ timeoutMs, userAgent: `breakwire-cli/${VERSION}`, channel: process.env.BREAKWIRE_CLIENT || `breakwire-cli/${VERSION}` } as any);
    const brief = await bw.sessionBrief(input as any);
    if (json) process.stdout.write(JSON.stringify(brief, null, 1) + '\n');
    else if (brief.context) process.stdout.write(brief.context + '\n');
  } catch { /* fail open */ }
  return 0;
}
