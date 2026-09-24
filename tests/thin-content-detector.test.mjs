import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractVisibleText, countWords, analyzeThin, walkContentFiles, paragraphsOf, findPublishDate } from '../scripts/thin-content-detector.mjs';
import { fx, read, run, tmp, skipTree } from './_content-helpers.mjs';

test('App Router page.tsx keeps its JSX body (P0-3: was 3 words)', () => {
  const text = extractVisibleText(read('app/blog/why-vcs-dont-return-calls/page.tsx'), '.tsx');
  const words = countWords(text);
  assert.ok(words > 400, `expected > 400 visible words, got ${words}`);
  assert.ok(paragraphsOf(text).length >= 8);
  // Imports, metadata, JSON-LD, attributes and expressions are not visible text.
  for (const junk of ['import', 'Metadata', '@context', 'className', 'JSON.stringify', 'related.map', 'openGraph']) {
    assert.ok(!text.includes(junk), `leaked: ${junk}`);
  }
  assert.ok(text.includes("Why VCs Don't Return Calls")); // &apos; decoded
  assert.ok(text.includes('"Would love to connect"')); // {'…'} string literal kept
});

test('MDX: multi-line imports/exports and {expressions} dropped, text kept', () => {
  const text = extractVisibleText(read('posts/linking-post.mdx'), '.mdx');
  assert.ok(!/import|export|Example Editor|year:/.test(text), text);
  assert.ok(text.includes('An option pool is shares reserved'));
  assert.ok(text.includes('the cap table guide'));
});

test('CRLF markdown and HTML (<main> only, no <nav>/<footer>)', () => {
  const md = extractVisibleText(read('posts/crlf-post.md'), '.md');
  assert.ok(!md.includes('title:') && !md.includes('\r'));
  const html = extractVisibleText(read('posts/landing.html'), '.html');
  assert.ok(html.includes('Raising a seed round takes'));
  assert.ok(!html.includes('Copyright') && !html.includes('Home'));
});

test('walker: only content extensions; skips node_modules, dot-dirs', () => {
  const d = skipTree();
  const files = walkContentFiles(d).map((f) => f.slice(d.length + 1)).sort();
  assert.deepEqual(files, ['binary.md', 'ok.md']); // binary.md is dropped later by the NUL-byte check
});

test('NOINDEX needs age: too-new critical pages are REVIEW', () => {
  const base = { text: 'only a few words here', content: '' };
  assert.equal(analyzeThin({ ...base, age: { ageDays: 10 }, minAgeDays: 90 }).recommendation, 'REVIEW');
  assert.equal(analyzeThin({ ...base, age: { ageDays: 400 }, minAgeDays: 90 }).recommendation, 'NOINDEX_CANDIDATE');
  // Thin but not critical (>= a third of min-words) is never a NOINDEX candidate.
  const mid = { text: 'word '.repeat(150), content: '' };
  assert.equal(analyzeThin({ ...mid, age: { ageDays: 4000 } }).recommendation, 'REVIEW');
});

test('publish dates from frontmatter and Next.js metadata', () => {
  assert.equal(findPublishDate(read('posts/old-thin.md')).toISOString().slice(0, 10), '2023-06-01');
  assert.equal(findPublishDate(read('app/blog/why-vcs-dont-return-calls/page.tsx')).toISOString().slice(0, 10), '2025-01-15');
});

test('CLI honours --min-words; binaries and non-content files are not scored', () => {
  const out = join(tmp(), 't.json');
  const r = run('thin-content-detector.mjs', ['--dir', fx(''), '--min-words', '50', '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(readFileSync(out, 'utf8'));
  const names = res.map((x) => x.file.split('/').slice(-2).join('/'));
  assert.ok(!names.includes('why-vcs-dont-return-calls/page.tsx'));
  assert.ok(!names.some((n) => n.endsWith('.png')));
  assert.ok(!names.includes('posts/density-report.md')); // 126 words >= 50
  for (const x of res.filter((x) => x.issues.some((i) => i.type === 'thin'))) assert.match(x.issues[0].detail, /minimum: 50\)/);
  assert.equal(res.find((x) => x.file.endsWith('old-thin.md')).recommendation, 'REVIEW'); // 25 words: thin, not critical at 50

  run('thin-content-detector.mjs', ['--dir', fx(''), '--output', out]);
  const dflt = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(dflt.find((x) => x.file.endsWith('old-thin.md')).recommendation, 'NOINDEX_CANDIDATE'); // < 100 words, dated 2023

  const r2 = run('thin-content-detector.mjs', ['--dir', fx(''), '--min-age-days', '100000', '--output', out]);
  assert.equal(r2.status, 0);
  assert.ok(JSON.parse(readFileSync(out, 'utf8')).every((x) => x.recommendation === 'REVIEW'));

  const bin = skipTree();
  const r3 = run('thin-content-detector.mjs', ['--dir', bin, '--ext', '.md,.png', '--output', out]);
  assert.match(r3.stdout, /2 binary skipped/);
  assert.ok(JSON.parse(readFileSync(out, 'utf8')).every((x) => !/binary|logo/.test(x.file)));
});

test('CLI rejects the removed --min-children flag instead of silently ignoring it', () => {
  assert.equal(run('thin-content-detector.mjs', ['--dir', fx(''), '--min-children', '3']).status, 1);
});

test('dynamic [slug] routes are skipped, not reported as 0-word pages', () => {
  const out = join(tmp(), 't.json');
  const r = run('thin-content-detector.mjs', ['--dir', fx(''), '--output', out]);
  assert.match(r.stdout, /Dynamic routes:\s+1 skipped/);
  assert.ok(!JSON.parse(readFileSync(out, 'utf8')).some((x) => x.file.includes('[slug]')));
});
