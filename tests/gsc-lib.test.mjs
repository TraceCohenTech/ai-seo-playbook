import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normPath, siteOrigin, pageUrl, propertyPathPrefix, sumByPage, sumByPageQuery, lastDataDate, windowEnding, shiftDay } from '../lib/gsc-rows.mjs';
import { loadCurve, fitCurve, resolveCurve, expectedCtr, clickGap } from '../lib/ctr.mjs';
import { routeFor, extractTitle, extractUpdated, scanContent } from '../lib/content-routes.mjs';
import { makeClient, buildRows, SITE, TODAY } from './fixtures/gsc/dataset.mjs';

const row = (keys, clicks, impressions, position) => ({ keys, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

test('normPath folds URL variants to one key', () => {
  for (const u of ['https://www.example.com/blog/x/', 'https://example.com/blog/x', '/blog/x', 'blog/x', 'https://www.example.com/blog/x#:~:text=foo', 'https://example.com//blog//x/']) {
    assert.equal(normPath(u), '/blog/x', u);
  }
  assert.equal(normPath('https://www.example.com/'), '/');
  assert.equal(normPath('https://www.example.com'), '/');
  assert.equal(normPath('https://example.com/search/?q=a'), '/search?q=a');
});

test('property origins: domain, www and URL-prefix properties', () => {
  assert.equal(siteOrigin('sc-domain:example.com'), 'https://example.com');
  assert.equal(siteOrigin('sc-domain:example.com', 'https://www.example.com/'), 'https://www.example.com');
  assert.equal(siteOrigin('https://www.example.com/'), 'https://www.example.com');
  assert.equal(siteOrigin('https://example.com/blog/'), 'https://example.com');
  assert.equal(pageUrl('https://www.example.com/', '/p'), 'https://www.example.com/p'); // not https://www.example.com//p
  assert.equal(pageUrl('sc-domain:example.com', 'p', 'https://www.example.com'), 'https://www.example.com/p');
  assert.equal(propertyPathPrefix('https://example.com/blog/'), '/blog');
  assert.equal(propertyPathPrefix('sc-domain:example.com'), '');
  assert.throws(() => siteOrigin('example.com'));
});

test('sumByPage SUMS variants instead of overwriting (the +36% -> -39% bug)', () => {
  const m = sumByPage([
    row(['https://www.example.com/p'], 518, 10000, 3),
    row(['https://www.example.com/p/'], 0, 100, 9), // arrives last; overwriting would erase 518 clicks
  ]);
  const p = m.get('/p');
  assert.equal(p.clicks, 518);
  assert.equal(p.impressions, 10100);
  assert.equal(p.variantCount, 2);
  assert.ok(Math.abs(p.position - (3 * 10000 + 9 * 100) / 10100) < 1e-9, 'impression-weighted position');
  const pq = sumByPageQuery([row(['https://a.com/p', 'q'], 1, 10, 2), row(['https://a.com/p/', 'q'], 2, 30, 4)]);
  assert.deepEqual([...pq.keys()], ['/p\tq']);
  assert.equal(pq.get('/p\tq').clicks, 3);
});

test('lastDataDate anchors on final data, not yesterday', async () => {
  const sc = makeClient();
  assert.equal(await lastDataDate(sc, SITE, { today: TODAY }), '2026-09-18');
  assert.equal(await lastDataDate(sc, SITE, { today: TODAY, dataState: 'all' }), '2026-09-20');
  assert.deepEqual(windowEnding('2026-09-18', 7), { startDate: '2026-09-12', endDate: '2026-09-18' });
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
});

test('default CTR curve is labelled as illustrative', () => {
  const c = loadCurve();
  assert.equal(c.source, 'default');
  assert.match(c.label, /illustrative/);
  assert.equal(Object.keys(c.positions).length, 20);
});

test('fitCurve recovers the site curve from query rows (median by rounded position, non-increasing)', () => {
  const rows = [...sumByPageQuery(buildRows().filter((r) => r.date >= '2026-08-22' && r.date <= '2026-09-18')
    .map((r) => row([r.page, r.query], r.clicks, r.impressions, r.position))).values()];
  const f = fitCurve(rows);
  assert.ok(f.usable, f.reason);
  const def = loadCurve();
  // The fixture long tail has CTR = 0.6 x default with +-40% noise.
  for (const p of [1, 2, 3, 5]) {
    const ratio = f.curve.positions[p] / def.positions[p];
    assert.ok(ratio > 0.35 && ratio < 0.95, `position ${p}: ratio ${ratio}`);
  }
  for (let p = 2; p <= 20; p++) assert.ok(f.curve.positions[p] <= f.curve.positions[p - 1] + 1e-12, `non-increasing at ${p}`);
  assert.equal(f.curve.fit.buckets.length, 20);
});

test('resolveCurve falls back to the default when data is too thin; fit mode throws', () => {
  const thin = [{ clicks: 5, impressions: 100, position: 3 }];
  const c = resolveCurve('auto', thin);
  assert.equal(c.source, 'default');
  assert.match(c.note, /fit not possible/);
  assert.throws(() => resolveCurve('fit', thin), /Cannot fit/);
  assert.equal(resolveCurve('default', thin).source, 'default');
});

test('expectedCtr interpolates and clamps; clickGap is expected minus actual clicks', () => {
  const c = loadCurve();
  assert.equal(expectedCtr(c, 1), 0.28);
  assert.ok(Math.abs(expectedCtr(c, 1.5) - (0.28 + 0.15) / 2) < 1e-12);
  assert.equal(expectedCtr(c, 0.4), 0.28);
  assert.equal(expectedCtr(c, 55), c.positions[20]);
  assert.ok(Math.abs(clickGap(c, { impressions: 1000, clicks: 20, position: 5 }) - 30) < 1e-9);
  assert.ok(clickGap(c, { impressions: 1000, clicks: 90, position: 5 }) < 0);
});

test('routeFor: App Router slug is the parent directory of page.tsx', () => {
  assert.deepEqual(routeFor('app/blog/foo/page.tsx'), { route: '/blog/foo', slug: 'foo', kind: 'app' });
  assert.equal(routeFor('src/app/blog/foo/page.jsx').route, '/blog/foo');
  assert.equal(routeFor('app/(marketing)/about/page.tsx').route, '/about');
  assert.equal(routeFor('app/@modal/login/page.tsx').route, '/login');
  assert.equal(routeFor('app/page.tsx').route, '/');
  assert.equal(routeFor('app/blog/[slug]/page.tsx').route, null);
  assert.equal(routeFor('app/layout.tsx'), null);
  assert.equal(routeFor('app/blog/foo/chart.tsx'), null);
  assert.equal(routeFor('blog/foo.md').route, '/blog/foo');
  assert.equal(routeFor('foo.mdx', { urlPrefix: '/blog/' }).route, '/blog/foo');
  assert.equal(routeFor('docs/index.md').route, '/docs');
  assert.equal(routeFor('pages/blog/x.tsx').route, '/blog/x');
  assert.equal(routeFor('pages/_app.tsx'), null);
  assert.equal(routeFor('pages/api/hello.ts'), null);
  assert.equal(routeFor('lib/util.ts'), null);
  assert.equal(routeFor('public/logo.png'), null);
});

test('extractTitle / extractUpdated handle CRLF frontmatter and TSX metadata', () => {
  const crlf = '---\r\ntitle: "Acme Raises $40M Series B"\r\ndate: 2026-03-10\r\nlastUpdated: 2026-04-02\r\n---\r\n\r\nBody\r\n';
  assert.equal(extractTitle(crlf), 'Acme Raises $40M Series B');
  assert.deepEqual(extractUpdated(crlf), { date: '2026-04-02', field: 'lastUpdated' });
  const tsx = "import x from 'y';\nexport const metadata = { title: \"Fund III: Size\" };\nconst ld = { datePublished: '2026-03-02', dateModified: '2026-05-01' };\n";
  assert.equal(extractTitle(tsx), 'Fund III: Size');
  assert.deepEqual(extractUpdated(tsx), { date: '2026-05-01', field: 'dateModified' });
  assert.equal(extractTitle('<main><h1 className="x">Hello <b>there</b></h1></main>'), 'Hello there');
  assert.equal(extractUpdated('no dates here'), null);
});

test('scanContent skips binaries, dynamic routes and non-route files', async () => {
  const files = await scanContent(new URL('./fixtures/gsc/site/', import.meta.url).pathname);
  const rels = files.map((f) => f.rel);
  assert.ok(!rels.includes('public/logo.png'));
  assert.ok(!rels.includes('blog/corrupt.md'), 'NUL bytes: binary with a text extension');
  assert.ok(!rels.includes('app/layout.tsx'));
  assert.equal(files.find((f) => f.rel === 'app/blog/[slug]/page.tsx').route, null);
  const fund = files.find((f) => f.rel === 'app/blog/example-capital-fund-iii/page.tsx');
  assert.equal(fund.route, '/blog/example-capital-fund-iii');
  assert.equal(fund.title, 'Example Capital Fund III: Size, LPs and Strategy');
  assert.equal(files.find((f) => f.rel === 'blog/acme-series-b.md').title, 'Acme Raises $40M Series B');
});
