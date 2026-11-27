import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, decide, parseRows, pageTyper, windows, DEFAULTS } from '../scripts/filter-detector.mjs';
import { scenario, CLIFF } from './fixtures/filter/scenarios.mjs';

const fx = (f) => new URL(`./fixtures/filter/${f}`, import.meta.url);
const run = (kind, extra = {}) => analyze({ ...scenario(kind), cliff: CLIFF, preDays: 17, indexedShare: 0.95, ...extra });

test('windows: pre ends before the excluded days, post starts after them', () => {
  assert.deepEqual(windows('2026-10-19', { preDays: 17, exclude: 1, postEnd: '2026-11-25' }), {
    pre: { startDate: '2026-10-01', endDate: '2026-10-17' }, post: { startDate: '2026-10-20', endDate: '2026-11-25' },
  });
});

test('sitewide scenario: SITEWIDE FILTER, uniform retention, positions held', () => {
  const r = run('sitewide');
  assert.equal(r.verdict, 'SITEWIDE FILTER');
  assert.ok(r.overall.retention < 0.05);
  for (const c of [...r.byType, ...r.byCountry, ...r.byDevice]) assert.ok(c.retention < 0.25, `${c.name} ${c.retention}`);
  assert.ok(r.pages.medianPositionChange <= 0);
  assert.equal(r.pages.topSurvivors[0].page, '/blog/widget-market-size');
  assert.deepEqual(r.byDevice.map((d) => d.name), ['desktop', 'mobile']);
  assert.equal(r.byCountry.find((c) => c.name === 'usa').retention, 0.0169);
  assert.deepEqual(r.warnings, []);
});

test('demotion scenario: DEMOTION when shown pages rank much lower', () => {
  const r = run('demotion');
  assert.equal(r.verdict, 'DEMOTION');
  assert.equal(r.pages.medianPositionChange, 5);
});

test('localized scenario: LOCALIZED names the cohorts that kept and lost traffic', () => {
  const r = run('localized');
  assert.equal(r.verdict, 'LOCALIZED');
  assert.ok(r.reasons.some((x) => x.includes('type:blog')));
  assert.ok(r.reasons.some((x) => x.startsWith('Lost traffic') && x.includes('type:news')));
});

test('no cliff and indexing problem are separated from a filter', () => {
  assert.equal(run('nocliff').verdict, 'NO CLIFF');
  assert.equal(run('sitewide', { indexedShare: 0.3 }).verdict, 'INDEXING PROBLEM');
});

test('a filter with one strong cohort is not called a filter', () => {
  const overall = { retention: 0.1, preImprPerDay: 1000, postImprPerDay: 100 };
  const cohorts = [{ dim: 'type', name: 'blog', retention: 0.3 }, { dim: 'type', name: 'news', retention: 0.4 }];
  assert.equal(decide({ overall, cohorts, posDelta: 0, T: DEFAULTS }).verdict, 'INCONCLUSIVE');
});

test('missing splits and indexing produce warnings, not a crash', () => {
  const { pages } = scenario('sitewide');
  const r = analyze({ pages, cliff: CLIFF, preDays: 17 });
  assert.equal(r.verdict, 'SITEWIDE FILTER');
  assert.equal(r.warnings.length, 2);
});

test('pre window before the data is a clear error', () => {
  assert.throws(() => run('sitewide', { preDays: 60 }), /pre window starts/);
});

test('parseRows: JSONL, Search Console CSV (quoted thousands, % CTR) and API key rows agree', () => {
  const { pages, countries, devices } = scenario('sitewide');
  assert.deepEqual(parseRows(readFileSync(fx('pages.jsonl'), 'utf8'), 'page'), pages);
  assert.deepEqual(parseRows(readFileSync(fx('countries.csv'), 'utf8'), 'country'), countries);
  assert.deepEqual(parseRows(readFileSync(fx('devices.json'), 'utf8'), 'device'), devices);
  assert.throws(() => parseRows('page,clicks\n/a,1', 'page'), /YYYY-MM-DD/);
});

test('pageTyper: homepage, first segment, other host, and custom rules', () => {
  const t = pageTyper(['/', '/blog/a', 'https://data.example.com/x', '/news/b']);
  assert.deepEqual(['/', '/blog/a', 'https://data.example.com/x', '/news/b'].map(t), ['homepage', 'blog', 'data.example.com', 'news']);
  const u = pageTyper(['https://example.com/', 'https://example.com/blog/a', 'https://example.com/c'], [{ type: 'deep-dive', pattern: '^/blog/' }]);
  assert.deepEqual(['https://example.com/', 'https://example.com/blog/a'].map(u), ['homepage', 'deep-dive']);
});

test('CLI: end to end on the fixture files, writes JSON, exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'filter-detector-'));
  try {
    const out = join(dir, 'r.json');
    const res = spawnSync(process.execPath, ['scripts/filter-detector.mjs', '--pages', fileUrlPath('pages.jsonl'), '--countries', fileUrlPath('countries.csv'),
      '--devices', fileUrlPath('devices.json'), '--cliff', CLIFF, '--pre-days', '17', '--indexed-share', '0.95', '--output', out], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /VERDICT: SITEWIDE FILTER/);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).verdict, 'SITEWIDE FILTER');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: bad input exits 1 with a message, no stack trace', () => {
  const res = spawnSync(process.execPath, ['scripts/filter-detector.mjs', '--pages', fileUrlPath('pages.jsonl'), '--cliff', 'yesterday'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^Error: --cliff must be YYYY-MM-DD/);
});

function fileUrlPath(f) { return fx(f).pathname; }
