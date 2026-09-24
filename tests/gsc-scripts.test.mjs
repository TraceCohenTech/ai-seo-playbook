import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeClient, SITE, TODAY } from './fixtures/gsc/dataset.mjs';
import { fakeGsc } from './fixtures/gsc/fake-gsc.mjs';
import { sumByPage, sumByPageQuery } from '../lib/gsc-rows.mjs';
import { loadCurve } from '../lib/ctr.mjs';
import * as weekly from '../scripts/weekly-report.mjs';
import * as cannibal from '../scripts/cannibalization-detector.mjs';
import * as ctrAudit from '../scripts/ctr-audit.mjs';
import * as striking from '../scripts/striking-distance.mjs';
import * as rewrite from '../scripts/gsc-rewrite-candidates.mjs';
import * as gap from '../scripts/query-gap-miner.mjs';
import * as refresh from '../scripts/refresh-tracker.mjs';
import * as measurer from '../scripts/rewrite-measurer.mjs';
import { scanContent } from '../lib/content-routes.mjs';

const base = { site: SITE, today: TODAY, now: TODAY };
const row = (keys, clicks, impressions, position) => ({ keys, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });
const siteDir = fileURLToPath(new URL('./fixtures/gsc/site/', import.meta.url));

// ---------------------------------------------------------------- weekly-report

test('weekly-report: windows end on the last FINAL date, and every query is fully paged', async () => {
  const sc = makeClient();
  const r = await weekly.buildReport(sc, base);
  assert.deepEqual(r.period, { startDate: '2026-09-12', endDate: '2026-09-18', previousStartDate: '2026-09-05', previousEndDate: '2026-09-11' });
  for (const c of sc.calls) {
    assert.ok(c.endDate <= '2026-09-18' || c.dimensions?.[0] === 'date', `window ends in provisional data: ${JSON.stringify(c)}`);
    if (c.dimensions?.[0] !== 'date' || c.startDate === '2026-09-05') assert.equal(c.rowLimit, 25000, 'use queryAll, not a top-N rowLimit');
  }
});

test('weekly-report: new queries are flagged, never Infinity/null growth', async () => {
  const r = await weekly.buildReport(makeClient(), base);
  const json = JSON.stringify(r);
  assert.ok(!/Infinity|NaN|"growthPct":null|null%/.test(json));
  const nw = r.trending.find((t) => t.query === 'acme series c rumor');
  assert.equal(nw.new, true);
  assert.ok(!('growthPct' in nw));
  const rising = r.trending.find((t) => t.query === 'widget pricing 2026');
  assert.equal(rising.new, false);
  assert.equal(rising.growthPct, 800);
  for (const v of Object.values(r.summary.changesFormatted)) assert.match(v, /^([+-]\d+(\.\d)?%|n\/a)$/);
  assert.equal(weekly.fmtChange(null), 'n/a');
  assert.equal(weekly.fmtChange(weekly.pctChange(0, 10)), 'n/a');
});

test('weekly-report: dropping pages compare complete page lists; trailing-slash variants summed', async () => {
  const r = await weekly.buildReport(makeClient(), base);
  const retired = r.dropping.find((d) => d.page === '/blog/retired-post');
  assert.deepEqual([retired.dropPct, retired.absentInRecent], [100, true]);
  const trends = r.dropping.find((d) => d.page === '/blog/widget-trends');
  assert.deepEqual([trends.dropPct, trends.absentInRecent], [60, false]);
  assert.ok(!r.dropping.some((d) => d.page === '/blog/stable-post'));
  const acme = r.topPages.find((p) => p.page === '/blog/acme-series-b');
  assert.equal(acme.variantCount, 2);
  assert.equal(acme.clicks, 30 * 28 + 6 * 7); // both variants of 'acme series b' plus the new query
  // A page far outside the top 200 in the recent half is not a false -100%.
  const first = new Map(), second = new Map();
  for (let i = 0; i < 300; i++) {
    first.set(`/p${i}`, { clicks: 1000 - i }); second.set(`/p${i}`, { clicks: 1000 - i });
  }
  assert.deepEqual(weekly.droppingPages(first, second), []);
});

test('weekly-report: ctrTriage considers ALL pages by impressions, not the top 50 by clicks', () => {
  const pages = new Map();
  for (let i = 0; i < 60; i++) pages.set(`/hit${i}`, { page: `/hit${i}`, clicks: 500, impressions: 5000, ctr: 0.1, position: 2 });
  pages.set('/buried', { page: '/buried', clicks: 12, impressions: 90000, ctr: 12 / 90000, position: 6 });
  const t = weekly.ctrTriage(pages);
  assert.equal(t[0].page, '/buried');
});

// ---------------------------------------------------------------- cannibalization-detector

test('cannibalization: flags close positions with split clicks as REVIEW, never 301', async () => {
  const r = await cannibal.buildReport(makeClient(), base);
  const q = r.clusters.map((c) => c.query);
  assert.ok(q.includes('acme pricing'));
  assert.ok(!q.includes('acme series b'), 'trailing-slash variants of one page are not two competing pages; the far-behind page is not close');
  assert.ok(!q.includes('example capital'), 'homepage query excluded');
  assert.equal(r.stats.excludedHomepage, 1);
  assert.ok(r.clusters.every((c) => c.action === 'REVIEW'));
  assert.ok(!/301|redirect/i.test(JSON.stringify(r.clusters)));
});

test('cannibalization: --brand, --query and --page filters', async () => {
  const noBrand = await cannibal.buildReport(makeClient(), base);
  assert.ok(noBrand.clusters.some((c) => c.query === 'example capital team'));
  const brand = await cannibal.buildReport(makeClient(), { ...base, brand: ['Example Capital'] });
  assert.ok(!brand.clusters.some((c) => c.query.includes('example capital')));
  assert.equal(brand.stats.excludedBrand, 5); // every query containing the brand term
  const byQuery = await cannibal.buildReport(makeClient(), { ...base, queries: ['pricing'] });
  assert.deepEqual(byQuery.clusters.map((c) => c.query), ['acme pricing']);
  const byPage = await cannibal.buildReport(makeClient(), { ...base, pages: ['https://www.example.com/tools/acme-pricing-calculator/'] });
  assert.deepEqual(byPage.clusters.map((c) => c.query), ['acme pricing']);
});

test('cannibalization: a clear click winner is not flagged', () => {
  const rows = [row(['q', 'https://x.com/a'], 80, 1000, 3), row(['q', 'https://x.com/b'], 20, 900, 4)];
  const { clusters, stats } = cannibal.findClusters(rows);
  assert.equal(clusters.length, 0);
  assert.equal(stats.clearWinner, 1);
});

test('cannibalization: paginates past the 25K-row API cap', async () => {
  const rows = [];
  for (let i = 0; i < 25500; i++) rows.push({ date: '2026-09-10', page: `https://www.example.com/p${i}`, query: `q${i}`, clicks: 1, impressions: 60, position: 5 });
  // A zero-click pair sorts after row 25,000.
  rows.push({ date: '2026-09-10', page: 'https://www.example.com/x', query: 'deep query', clicks: 0, impressions: 60, position: 7 });
  rows.push({ date: '2026-09-10', page: 'https://www.example.com/y', query: 'deep query', clicks: 0, impressions: 60, position: 8 });
  const r = await cannibal.buildReport(fakeGsc(rows), { ...base, today: new Date('2026-09-12T00:00:00Z') });
  assert.equal(r.stats.rowsFetched, 25502);
  assert.deepEqual(r.clusters.map((c) => c.query), ['deep query']);
});

// ---------------------------------------------------------------- ctr-audit

test('ctr-audit: clickGap (expected minus actual clicks) from a fitted curve', async () => {
  const r = await ctrAudit.buildReport(makeClient(), base);
  assert.equal(r.curve.source, 'fitted');
  assert.ok(!JSON.stringify(r).includes('wastedImpressions'));
  const p = r.pages.find((x) => x.url === '/blog/example-capital-fund-iii');
  assert.equal(p.clickGap, p.expectedClicks - p.clicks);
  assert.equal(p.expectedFrom, 'queries');
  assert.deepEqual(r.pages.map((x) => x.tier), ['HIGH', 'MEDIUM', 'LOW']);
  const d = await ctrAudit.buildReport(makeClient(), { ...base, curve: 'default' });
  assert.equal(d.curve.source, 'default');
  assert.match(d.curve.label, /illustrative/);
});

test('ctr-audit: expected CTR is impression-weighted per query, not from the blended page position', () => {
  const curve = loadCurve();
  // Page averages position ~5.5 but is really #1 for one query and #10 for another.
  const pq = sumByPageQuery([row(['https://x.com/p', 'a'], 250, 1000, 1), row(['https://x.com/p', 'b'], 5, 1000, 10)]);
  const pages = sumByPage([row(['https://x.com/p'], 255, 2000, 5.5)]);
  const scored = ctrAudit.scorePages(pages, pq, curve, { minImpressions: 1 });
  assert.equal(scored.length, 0, 'the page is at or above the curve for both queries: no gap');
});

// ---------------------------------------------------------------- striking-distance

test('striking-distance: uses ACTUAL clicks, skips machine queries by default', async () => {
  const r = await striking.buildReport(makeClient(), base);
  const f = r.opportunities.find((o) => o.page === '/blog/example-capital-fund-iii');
  assert.equal(f.topQuery, 'example capital fund iii');
  assert.equal(f.clicks, 3 * 28, 'actual clicks for the qualifying human queries');
  assert.equal(f.clickGain, Math.max(0, f.projectedClicks - f.clicks));
  assert.equal(r.curve.source, 'fitted');
  const withMachine = await striking.buildReport(makeClient(), { ...base, includeMachine: true });
  assert.match(withMachine.opportunities.find((o) => o.page === '/blog/example-capital-fund-iii').topQuery, /^evaluate/);
  assert.equal(striking.targetPosition(12), 8);
  assert.equal(striking.targetPosition(6), 4);
  assert.equal(striking.targetPosition(4.6), 3);
});

// ---------------------------------------------------------------- gsc-rewrite-candidates

test('rewrite-candidates: thresholds are options; machine share and --human-only', async () => {
  const r = await rewrite.buildReport(makeClient(), base);
  const f = r.candidates.find((c) => c.page === '/blog/example-capital-fund-iii');
  assert.equal(f.machineShare, 0.71);
  assert.match(f.diagnosis, /machine-generated/);
  assert.ok(!('currentTitle' in f));
  const human = await rewrite.buildReport(makeClient(), { ...base, humanOnly: true });
  const h = human.candidates.find((c) => c.page === '/blog/example-capital-fund-iii');
  assert.equal(h.impressions, (400 + 200 + 10) * 28);
  assert.ok(h.topQueries.every((q) => !q.machine));
  const strict = await rewrite.buildReport(makeClient(), { ...base, minImpressions: 1e9 });
  assert.equal(strict.candidatesFound, 0);
  const narrow = await rewrite.buildReport(makeClient(), { ...base, maxPosition: 5 });
  assert.ok(narrow.candidates.every((c) => c.position <= 5));
});

// ---------------------------------------------------------------- query-gap-miner

test('query-gap-miner: per-page matching finds gaps a site-wide bag of words hides', async () => {
  const r = await gap.buildReport(makeClient(), { ...base, dir: siteDir, minImpressions: 500 });
  const g = r.gaps.find((x) => x.query === 'widget series portfolio pricing');
  assert.ok(g, 'reported as a gap');
  assert.equal(g.closestPage.page, '/blog/widget-pricing');
  assert.ok(g.closestPage.score < 0.6);
  assert.ok(!r.gaps.some((x) => x.query === 'example capital fund iii returns'), 'covered by the App Router page');
  assert.equal(r.coveredCount, 1);
  // The old approach: every query word appears SOMEWHERE on the site.
  const files = await scanContent(siteDir);
  const bag = new Set(files.flatMap((f) => [...(f.slug || '').split('-'), ...f.title.toLowerCase().split(/\s+/)]));
  assert.ok('widget series portfolio pricing'.split(' ').every((w) => bag.has(w)));
});

test('query-gap-miner: scoring and tokenizing', () => {
  const idx = gap.buildIndex([{ page: '/blog/acme-pricing', title: 'Acme Pricing Explained' }, { page: '/blog/widgets', title: 'All about widgets' }]);
  assert.equal(gap.closestPage('acme pricing', idx).score, 1);
  assert.equal(gap.closestPage('acme pricing', idx).page, '/blog/acme-pricing');
  assert.equal(gap.closestPage('globex', idx).score, 0);
  assert.deepEqual(gap.tokenize('What is the Acme vs. Globex pricing?'), ['acme', 'globex', 'pricing']);
  assert.equal(gap.closestPage('', idx), null);
});

// ---------------------------------------------------------------- refresh-tracker

test('refresh-tracker: App Router pages match by exact path; no substring matches', async () => {
  const r = await refresh.buildReport(makeClient(), { ...base, dir: siteDir, minImpressions: 1 });
  const fund = r.refreshCandidates.find((c) => c.url === '/blog/example-capital-fund-iii');
  assert.deepEqual([fund.file, fund.match, fund.lastUpdated, fund.dateSource], ['app/blog/example-capital-fund-iii/page.tsx', 'exact', '2026-05-01', 'dateModified']);
  const acme = r.refreshCandidates.find((c) => c.url === '/blog/acme-series-b');
  assert.equal(acme.match, 'exact');
  assert.equal(acme.impressions, 300 * 28 + 120 * 7, 'both trailing-slash variants, summed');
  assert.ok(r.unmatched.includes('/blog/vc-funding-guide'), 'blog/vc.md must not substring-match');
  assert.ok(!r.refreshCandidates.concat().some((c) => c.file.endsWith('page.tsx') && c.url === '/blog/vc-funding-guide'));
  assert.deepEqual(r.skippedDynamicRoutes, ['app/blog/[slug]/page.tsx']);
});

test('refresh-tracker: slug fallback only when unique and exact', () => {
  const files = [
    { rel: 'a/intro.md', route: '/a/intro', slug: 'intro' },
    { rel: 'b/intro.md', route: '/b/intro', slug: 'intro' },
    { rel: 'posts/acme.md', route: '/posts/acme', slug: 'acme' },
  ];
  const m = refresh.makeMatcher(files);
  assert.equal(m('https://www.example.com/blog/intro/'), null, 'ambiguous slug');
  assert.equal(m('https://www.example.com/blog/acme/').match, 'slug-unique');
  assert.equal(m('/blog/acme-pricing'), null, 'no substring match');
  assert.equal(m('/b/intro/').file.rel, 'b/intro.md');
  assert.equal(refresh.makeMatcher(files, { allowSlugFallback: false })('/blog/acme'), null);
});

// ---------------------------------------------------------------- rewrite-measurer

test('rewrite-measurer: explicit pre/post windows that exclude the change week', () => {
  assert.deepEqual(measurer.measureWindows('2026-08-20', { window: 28, excludeDays: 7 }), {
    pre: { startDate: '2026-07-23', endDate: '2026-08-19' },
    excluded: { startDate: '2026-08-20', endDate: '2026-08-26' },
    post: { startDate: '2026-08-27', endDate: '2026-09-23' },
  });
  assert.throws(() => measurer.measureWindows('20 Aug'));
});

test('rewrite-measurer: lift relative to a matched control, with variants summed', () => {
  const pre = new Map(), post = new Map();
  const put = (m, p, clicks, impressions) => m.set(p, { page: p, clicks, impressions, ctr: clicks / impressions, position: 5 });
  const treated = [];
  for (let i = 0; i < 12; i++) { put(pre, `/t${i}`, 100, 2000); put(post, `/t${i}`, 150, 2000); treated.push(`/t${i}`); }
  for (let i = 0; i < 20; i++) { put(pre, `/c${i}`, 100, 2000); put(post, `/c${i}`, 110, 2000); }
  put(pre, '/huge', 50000, 900000); put(post, '/huge', 10, 900000); // outside the control band
  const r = measurer.measureCohort(pre, post, treated, new Set(treated));
  assert.equal(r.treated.clickChangePct, 50);
  assert.equal(r.control.n, 20);
  assert.equal(r.control.clickChangePct, 10);
  assert.equal(r.relativeLiftPct, 36.4);
  assert.equal(r.verdict, 'LIKELY POSITIVE');
  // Summing variants: overwriting the '/p' entry with its 0-click '/p/' twin would erase the page.
  const vPre = sumByPage([row(['https://www.example.com/p'], 518, 9000, 4), row(['https://www.example.com/p/'], 0, 50, 9)]);
  const vPost = sumByPage([row(['https://www.example.com/p/'], 0, 40, 9), row(['https://www.example.com/p'], 704, 9500, 4)]);
  const v = measurer.measureCohort(vPre, vPost, ['/p'], new Set(['/p']));
  assert.equal(v.treated.clickChangePct, 35.9);
  assert.equal(v.verdict, 'NO READOUT');
});

test('rewrite-measurer: refuses to read out before the post window has final data', async () => {
  await assert.rejects(
    measurer.buildReport(makeClient(), { ...base, changes: [{ page: '/blog/acme-pricing', changedAt: '2026-09-10' }] }),
    /post window ends .* final data runs only to 2026-09-18/,
  );
  const r = await measurer.buildReport(makeClient(), { ...base, window: 14, changes: [{ page: 'https://www.example.com/blog/acme-pricing/', changedAt: '2026-08-10' }] });
  const c = r.cohorts[0];
  assert.equal(c.treated.n, 1);
  assert.equal(c.verdict, 'INSUFFICIENT DATA');
  assert.ok(c.control.n > 0);
  assert.ok(!c.treated.pages.some((p) => p.page.endsWith('/')));
});

test('rewrite-measurer: old baseline/measure modes fail with a pointer to the new usage', () => {
  const res = spawnSync(process.execPath, ['scripts/rewrite-measurer.mjs', 'baseline', '--site', 'sc-domain:example.com'], { encoding: 'utf8', env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent' } });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--change-date/);
  assert.ok(!/\n\s+at /.test(res.stderr), 'no stack trace');
});

test('scripts reject unknown flags (strict CLI)', () => {
  for (const s of ['weekly-report', 'cannibalization-detector', 'ctr-audit']) {
    const res = spawnSync(process.execPath, [`scripts/${s}.mjs`, '--site', 'sc-domain:example.com', '--bogus', '1'], { encoding: 'utf8' });
    assert.equal(res.status, 1, s);
  }
  assert.match(execFileSync(process.execPath, ['scripts/cannibalization-detector.mjs', '--help'], { encoding: 'utf8' }), /--brand/);
});
