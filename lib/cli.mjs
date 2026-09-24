/**
 * Shared CLI helpers for every script.
 *
 *   import { cli, fail } from '../lib/cli.mjs';
 *   const args = cli(import.meta.url, { site: { type: 'string', required: true }, days: { type: 'string', default: '28' } });
 *
 * - `--help` / `-h` prints the script's leading JSDoc block (its documentation) and exits 0.
 * - `--version` prints the package version.
 * - Unknown flags and missing required flags print a short error plus usage, then exit 1 (no stack traces).
 * - `fail(err)` logs and exits 1. Use it instead of `main().catch(console.error)`, which exits 0 on a crash
 *   and makes CI report success.
 */
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function docOf(scriptUrl) {
  const src = readFileSync(fileURLToPath(scriptUrl), 'utf8');
  const m = src.match(/\/\*\*([\s\S]*?)\*\//);
  return m ? m[1].split('\n').map((l) => l.replace(/^\s*\* ?/, '')).join('\n').trim() : '(no documentation)';
}

export function cli(scriptUrl, options = {}, { allowPositionals = false } = {}) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(docOf(scriptUrl)); process.exit(0); }
  if (argv.includes('--version')) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(pkg.version); process.exit(0);
  }
  const required = Object.entries(options).filter(([, o]) => o.required).map(([k]) => k);
  const opts = Object.fromEntries(Object.entries(options).map(([k, { required: _r, ...o }]) => [k, o]));
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: opts, strict: true, allowPositionals });
  } catch (e) {
    console.error(`Error: ${e.message}\nRun with --help for usage.`);
    process.exit(1);
  }
  const missing = required.filter((k) => parsed.values[k] === undefined);
  if (missing.length) {
    console.error(`Error: missing required option(s): ${missing.map((k) => '--' + k).join(', ')}\nRun with --help for usage.`);
    process.exit(1);
  }
  return allowPositionals ? { ...parsed.values, _: parsed.positionals } : parsed.values;
}

export function fail(err) {
  console.error(err?.stack || String(err));
  process.exit(1);
}
