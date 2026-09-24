import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractMeta, checkMeta } from '../scripts/meta-length-checker.mjs';
import { ROOT, fx, read, run, tmp, skipTree } from './_content-helpers.mjs';

test('parses (P0-1: top-level await inside a non-async function)', () => {
  execFileSync(process.execPath, ['--check', join(ROOT, 'scripts/meta-length-checker.mjs')]);
});

test('TSX title with an apostrophe is read in full, not cut at "Don"', () => {
  const m = extractMeta(read('app/blog/why-vcs-dont-return-calls/page.tsx'), '.tsx');
  assert.equal(m.title, "Why VCs Don't Return Calls: What Founders Get Wrong About Outreach");
  const issues = checkMeta(m, '.tsx');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].length, 66);
});

test('openGraph / twitter titles are ignored even when they come first', () => {
  const m = extractMeta(read('app/tools/pricing/page.tsx'), '.tsx');
  assert.equal(m.title, 'Startup Valuation Calculator for Seed-Stage Teams');
  assert.equal(m.description, "Estimate pre-money and post-money valuation in seconds. It's free and needs no sign-up.");
  assert.deepEqual(checkMeta(m, '.tsx'), []);
});

test('CRLF frontmatter: quoted title with apostrophe and single-quoted description with doubled quote', () => {
  const raw = read('posts/crlf-post.md');
  assert.ok(raw.includes('\r\n'), 'fixture must be CRLF');
  const m = extractMeta(raw, '.md');
  assert.equal(m.title, "Founder's Guide to Cap Tables: Every Line Item Explained With Worked Examples");
  assert.ok(m.description.startsWith("It's the plain-English"));
  const fields = checkMeta(m, '.md').map((i) => i.field);
  assert.deepEqual(fields, ['title', 'description']);
});

test('HTML: <title> with entities; meta description with reversed attributes and an apostrophe; og:title ignored', () => {
  const m = extractMeta(read('posts/landing.html'), '.html');
  assert.ok(m.title.startsWith('Acme & Example Capital'));
  assert.ok(m.description.includes("It's written for first-time founders"));
});

test('--title-suffix models a title template; not applied to title.absolute or HTML', () => {
  const tools = extractMeta(read('app/tools/pricing/page.tsx'), '.tsx');
  const withSuffix = checkMeta(tools, '.tsx', { titleSuffix: ' | Example Site' });
  assert.equal(withSuffix.length, 1);
  assert.equal(withSuffix[0].value, 'Startup Valuation Calculator for Seed-Stage Teams | Example Site');
  assert.equal(withSuffix[0].suffixApplied, ' | Example Site');
  const abs = extractMeta(read('app/blog/pricing/page.tsx'), '.tsx');
  assert.equal(abs.titleAbsolute, true);
  assert.deepEqual(checkMeta(abs, '.tsx', { titleSuffix: ' | A Very Long Example Site Name Here For Testing' }), []);
});

test('dynamic template-literal titles are skipped, not guessed', () => {
  const m = extractMeta(read('app/blog/[slug]/page.tsx'), '.tsx');
  assert.equal(m.title, null);
  assert.deepEqual(m.dynamic, ['title']);
});

test('CLI: exit 2 with violations, JSON output matches; exit 0 when clean; skips node_modules, dot-dirs, binaries', () => {
  const out = join(tmp(), 'v.json');
  const r = run('meta-length-checker.mjs', ['--dir', fx(''), '--output', out]);
  assert.equal(r.status, 2, r.stderr);
  const v = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(v.map((x) => x.file.split('/').pop()).sort(), ['crlf-post.md', 'landing.html', 'page.tsx']);

  const clean = skipTree();
  const r2 = run('meta-length-checker.mjs', ['--dir', clean]);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /Files scanned:\s+2\b/); // ok.md + binary.md (read, then skipped as binary)
});

test('CLI: unknown flags fail with exit 1', () => {
  assert.equal(run('meta-length-checker.mjs', ['--dir', fx(''), '--bogus', 'x']).status, 1);
});
