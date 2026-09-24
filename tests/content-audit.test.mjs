import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { audit, classify, siteHost, countExternalLinks, indexGscRows, analyzeContent } from '../scripts/content-audit.mjs';
import { walkContentFiles, readTextFile } from '../scripts/thin-content-detector.mjs';
import { loadPhrases, compilePhrases } from '../scripts/template-detector.mjs';
import { FIX, fx, read, run, tmp } from './_content-helpers.mjs';

const rows = JSON.parse(read('gsc-rows.json'));
const site = siteHost('sc-domain:example.com', 'https://example.com');
const compiledPhrases = compilePhrases(loadPhrases());
const files = walkContentFiles(FIX).map((file) => ({ file, content: readTextFile(file) })).filter((f) => f.content !== null);
const NOW = new Date('2026-09-24T00:00:00Z');
const byPath = (r, p) => r.pages.find((x) => x.path === p);

test('App Router TSX is not counted as 0 words (P0-3)', () => {
  const a = analyzeContent(read('app/blog/why-vcs-dont-return-calls/page.tsx'), '.tsx', { site, compiledPhrases });
  assert.ok(a.wordCount > 400, String(a.wordCount));
  assert.equal(a.isThin, false);
  assert.equal(a.hasSchema, true);
});

test('GSC joined by full path: /blog/pricing does not inherit /tools/pricing traffic', () => {
  const r = audit({ files, dir: FIX, rows, site, compiledPhrases, now: NOW });
  const tools = byPath(r, '/tools/pricing');
  assert.equal(tools.gscStatus, 'matched');
  assert.equal(tools.gsc.impressions, 5300); // https + www/trailing-slash rows merged
  const blog = byPath(r, '/blog/pricing');
  assert.equal(blog.gscStatus, 'no-rows');
  assert.equal(blog.gsc.impressions, 0); // the 9,000-impression row is on blog.example.com, another host
});

test('a page with no GSC rows has position null, not 0; dynamic routes are "unmapped"', () => {
  const r = audit({ files, dir: FIX, rows, site, compiledPhrases, now: NOW });
  assert.equal(byPath(r, '/posts/old-thin').gsc.position, null);
  const dyn = r.pages.find((p) => p.file.includes('[slug]'));
  assert.equal(dyn.gscStatus, 'unmapped');
  assert.equal(dyn.gsc, null);
  assert.equal(dyn.bucket, 'REVIEW');
});

test('KILL only with guards: old + thin + zero traffic; new pages are REVIEW', () => {
  const r = audit({ files, dir: FIX, rows, site, compiledPhrases, now: NOW });
  assert.equal(byPath(r, '/posts/old-thin').bucket, 'KILL');
  assert.equal(byPath(r, '/blog/pricing').bucket, 'KILL');
  assert.equal(byPath(r, '/posts/linking-post').bucket, 'REVIEW'); // dated 2026-09-01: too new
  assert.equal(byPath(r, '/blog/why-vcs-dont-return-calls').bucket, 'PROMOTE');
  assert.equal(byPath(r, '/tools/pricing').bucket, 'UPDATE');
  const strict = audit({ files, dir: FIX, rows, site, compiledPhrases, now: NOW, minAgeDays: 100000 });
  assert.equal(strict.buckets.KILL, 0);
});

test('an unhealthy join (wrong url prefix) never produces KILL', () => {
  const r = audit({ files, dir: FIX, rows, site, compiledPhrases, now: NOW, urlPrefix: '/wrong' });
  assert.equal(r.joinStats.healthy, false);
  assert.equal(r.buckets.KILL, 0);
  const none = audit({ files, dir: FIX, rows: [], site, compiledPhrases, now: NOW });
  assert.equal(none.buckets.KILL, 0);
});

test('template phrases alone never KILL', () => {
  const analysis = { isThin: false, templateCount: 9 };
  assert.equal(classify('no-rows', { clicks: 0, impressions: 0 }, analysis, { oldEnough: true, joinHealthy: true }), 'REVIEW');
});

test('external links are judged against the site host, not the literal example.com', () => {
  const content = read('app/blog/why-vcs-dont-return-calls/page.tsx');
  assert.equal(countExternalLinks(content, site), 1); // acme-partners.test only; example.com/tools/pricing is internal
  const other = siteHost('sc-domain:acme-partners.test');
  assert.equal(countExternalLinks(content, other), 1); // now example.com is the external one
  assert.equal(countExternalLinks('<a href="https://www.example.com/x">x</a> [y](https://docs.example.com/y)', siteHost('sc-domain:example.com')), 0);
  assert.equal(countExternalLinks('<a href="https://docs.example.com/y">y</a>', siteHost('https://example.com/')), 1);
});

test('indexGscRows keeps only this host (www ignored)', () => {
  const idx = indexGscRows(rows, site);
  assert.ok(idx.has('/tools/pricing') && idx.has('/about'));
  assert.ok(!idx.has('/blog/pricing'));
});

test('template phrases come from the config file (--config)', () => {
  const dir = tmp();
  const cfg = join(dir, 'rules.json');
  writeFileSync(cfg, JSON.stringify({ blockedPhrases: { custom: ['warehouse automation'] } }));
  const a = analyzeContent(read('app/blog/why-vcs-dont-return-calls/page.tsx'), '.tsx', { site, compiledPhrases: compilePhrases(loadPhrases(cfg)) });
  assert.equal(a.templateCount, 1);
});

test('CLI with --rows writes the report and needs no network', () => {
  const out = join(tmp(), 'audit.json');
  const r = run('content-audit.mjs', ['--site', 'sc-domain:example.com', '--base-url', 'https://example.com', '--dir', fx(''), '--rows', fx('gsc-rows.json'), '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const rep = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(rep.buckets), ['KILL', 'REVIEW', 'UPDATE', 'PROMOTE', 'KEEP']);
  assert.equal(rep.joinStats.files, 10);
  assert.ok(!rep.pages.some((p) => p.file.endsWith('.png')));
});
