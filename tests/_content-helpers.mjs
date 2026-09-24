// Shared test helpers for the content-script tests (not a test file itself).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const FIX = join(ROOT, 'tests/fixtures/content');
export const fx = (p) => join(FIX, p);
export const read = (p) => readFileSync(fx(p), 'utf8');

export function tmp() { return mkdtempSync(join(tmpdir(), 'playbook-content-')); }

/** Run a script; returns { status, stdout, stderr }. */
export function run(script, args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A temp tree with things that must be skipped: node_modules, a dot-dir, a binary with a content extension. */
export function skipTree() {
  const d = tmp();
  const long = 'Real words about seed rounds and cap tables. '.repeat(10);
  mkdirSync(join(d, 'node_modules/pkg'), { recursive: true });
  mkdirSync(join(d, '.cache'), { recursive: true });
  writeFileSync(join(d, 'node_modules/pkg/readme.md'), '---\ntitle: ' + 'x'.repeat(90) + '\n---\nhi');
  writeFileSync(join(d, '.cache/draft.md'), '---\ntitle: ' + 'y'.repeat(90) + '\n---\nhi');
  writeFileSync(join(d, 'binary.md'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x41, 0x42]));
  writeFileSync(join(d, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x77, 0x6f, 0x72, 0x64]));
  writeFileSync(join(d, 'ok.md'), `---\ntitle: Short title\ndate: 2020-01-01\n---\n\n${long}\n`);
  return d;
}
