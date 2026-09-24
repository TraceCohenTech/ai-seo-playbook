import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGraph, summarize, resolveInternal } from '../scripts/orphan-finder.mjs';
import { extractLinkTargets } from '../scripts/thin-content-detector.mjs';
import { fx, read, run, tmp, skipTree } from './_content-helpers.mjs';

const page = (path, content, file = path + '.md') => ({ file, path, content });

test('Markdown links count as inbound links', () => {
  const nodes = buildGraph([page('/posts/a', '[see b](/posts/b) and [ref][r]\n\n[r]: /posts/c'), page('/posts/b', ''), page('/posts/c', '')]);
  assert.deepEqual(nodes.map((n) => n.inboundLinks), [0, 1, 1]);
});

test('arbitrary quoted strings are not links', () => {
  const nodes = buildGraph([page('/posts/a', '<div id="crlf-post" className="old-thin">x</div>'), page('/posts/crlf-post', ''), page('/posts/old-thin', '')]);
  assert.equal(nodes[1].inboundLinks, 0);
  assert.equal(nodes[2].inboundLinks, 0);
});

test('relative links, absolute internal links and trailing slashes resolve', () => {
  assert.equal(resolveInternal('./old-thin', '/posts/linking-post'), '/posts/old-thin');
  assert.equal(resolveInternal('https://www.example.com/blog/x/', '/', ['example.com']), '/blog/x');
  assert.equal(resolveInternal('https://other.test/blog/x', '/', ['example.com']), null);
  assert.equal(resolveInternal('/img/logo.png', '/'), null);
});

test('same slug under different sections is not conflated', () => {
  const nodes = buildGraph([page('/blog/pricing', '', 'b.md'), page('/tools/pricing', '', 't.md'), page('/x', '<a href="/tools/pricing">t</a>', 'x.md')]);
  assert.equal(nodes[0].inboundLinks, 0);
  assert.equal(nodes[1].inboundLinks, 1);
});

test('fixture site: the hyphenated id="density-report" does not rescue the real orphan', () => {
  assert.ok(!extractLinkTargets(read('app/tools/pricing/page.tsx')).includes('density-report'));
  const out = join(tmp(), 'o.json');
  const r = run('orphan-finder.mjs', ['--dir', fx(''), '--base', 'https://example.com', '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const rep = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(rep.orphans.map((o) => o.path), ['/posts/density-report', '/posts/landing']);
  assert.ok(!rep.orphans.some((o) => o.path === '/posts/crlf-post')); // linked via [..](/posts/crlf-post)
  assert.equal(rep.dynamicRoutes.length, 1);
  assert.equal(rep.totalPages, 9);
});

test('binaries, node_modules and dot-dirs are not pages', () => {
  const d = skipTree();
  const out = join(tmp(), 'o.json');
  run('orphan-finder.mjs', ['--dir', d, '--ext', '.md,.png', '--output', out]);
  const rep = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(rep.orphans.map((o) => o.path), ['/ok']);
});

test('help text does not claim orphans are invisible to Google', () => {
  const r = run('orphan-finder.mjs', ['--help']);
  assert.ok(!/invisible/i.test(r.stdout));
  assert.match(r.stdout, /sitemap/);
  const s = summarize(buildGraph([page('/a', '')]));
  assert.equal(s.orphans.length, 1);
});
