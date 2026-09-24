/**
 * Deterministic fake Search Console data for a fictional site (www.example.com, property
 * sc-domain:example.com). Every scenario below reproduces a bug the GSC scripts used to have.
 *
 * Anchor dates: final data runs through FINAL_THROUGH; the two days after it are provisional
 * (dataState 'all' only); TODAY is when the scripts "run".
 */
import { fakeGsc } from './fake-gsc.mjs';

export const SITE = 'sc-domain:example.com';
export const HOST = 'https://www.example.com';
export const TODAY = new Date('2026-09-21T12:00:00Z');
export const FINAL_THROUGH = '2026-09-18';
const START = '2026-06-20', LAST = '2026-09-20';

const day = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Each series: page (full URL), query, and a function date -> { i, c, p } of DAILY expected values (floats) or null.
const S = [];
const add = (page, query, fn) => S.push({ page: HOST + page, query, fn });
const always = (i, c, p) => () => ({ i, c, p });

// Trailing-slash variants of one page: must be SUMMED (never overwritten).
add('/blog/acme-series-b', 'acme series b', always(180, 18, 2));
add('/blog/acme-series-b/', 'acme series b', always(120, 12, 2));
// A second page for the same query that clearly loses: not cannibalization.
add('/news/acme-funding', 'acme series b', always(80, 1, 9));
// Brand-new query in the most recent week.
add('/blog/acme-series-b', 'acme series c rumor', (d) => (d >= '2026-09-12' ? { i: 120, c: 6, p: 4 } : null));

// High-impression, low-click page (outside any "top 50 by clicks"), plus a machine-shaped query.
add('/blog/example-capital-fund-iii', 'example capital fund iii', always(400, 2, 6));
add('/blog/example-capital-fund-iii', 'example capital fund size', always(200, 1, 7));
add('/blog/example-capital-fund-iii', 'evaluate the venture capital firms that closed a third fund in 2026', always(1500, 0, 5));
add('/blog/example-capital-fund-iii', 'example capital fund iii returns', always(10, 0, 16));

// Pages under the CTR curve by different margins (ctr-audit tiers).
add('/blog/acme-review', 'acme review', always(250, 2, 3));
add('/blog/globex-profile', 'globex profile', always(60, 0.5, 4));

// Real cannibalization: close positions, clicks split, nobody wins most clicks.
add('/blog/acme-pricing', 'acme pricing', always(150, 3, 7.2));
add('/tools/acme-pricing-calculator/', 'acme pricing', always(140, 2.5, 8.1));

// Brand / homepage queries: several URLs rank, which is normal.
add('/', 'example capital', always(500, 150, 1.1));
add('/about', 'example capital', always(200, 20, 2.5));
add('/about', 'example capital team', always(60, 10, 1.5));
add('/blog/example-capital-portfolio', 'example capital team', always(50, 8, 2));

// Dropping page, a truly absent page, and a stable page.
add('/blog/widget-trends', 'widget trends', (d) => (d <= '2026-09-04' ? { i: 400, c: 20, p: 4 } : { i: 300, c: 8, p: 6 }));
add('/blog/retired-post', 'retired widget guide', (d) => (d <= '2026-09-04' ? { i: 100, c: 6, p: 5 } : null));
add('/blog/stable-post', 'stable widget facts', always(100, 5, 4));

// Rising query.
add('/blog/widget-pricing', 'widget pricing 2026', (d) => (d >= '2026-09-12' ? { i: 90, c: 4, p: 6 } : { i: 10, c: 0.5, p: 9 }));

// Striking distance (positions 11-14).
add('/blog/widget-pricing', 'widget pricing guide', always(40, 0.2, 12));
add('/blog/stable-post', 'widget facts list', always(30, 0.3, 11));

// Query gaps. The second one's words ALL appear somewhere on the site, but on four different
// pages, so a site-wide bag of words called it covered.
add('/blog/acme-pricing', 'acme vs globex comparison', always(15, 0.1, 18));
add('/blog/widget-trends', 'widget series portfolio pricing', always(12, 0, 21));

// A short slug ("vc") must not substring-match other URLs.
add('/blog/vc-funding-guide', 'vc funding guide', always(20, 1, 8));

// Long tail used to FIT a CTR curve: 6 queries per rounded position 1-20, CTR = 0.6 x the
// default curve with +-40% noise.
const BASE = [0, 0.28, 0.15, 0.1, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.015, 0.01, 0.008, 0.007, 0.006, 0.005, 0.004, 0.003, 0.003, 0.002, 0.002];
const rnd = mulberry32(7);
for (let k = 0; k < 120; k++) {
  const pos = 1 + (k % 20) + (rnd() - 0.5) * 0.6;
  const ctr = 0.6 * BASE[Math.max(1, Math.min(20, Math.round(pos)))] * (0.6 + 0.8 * rnd());
  const i = 3 + Math.floor(rnd() * 6);
  add(`/blog/topic-${k % 6}`, `widget topic ${k}`, always(i, i * ctr, Math.max(1, pos)));
}

/** Daily rows. Fractional daily values are turned into integers with a running carry so totals are exact. */
export function buildRows() {
  const rows = [];
  for (const s of S) {
    let ci = 0, cc = 0;
    for (let d = START; d <= LAST; d = day(d, 1)) {
      const v = s.fn(d);
      if (!v) continue;
      ci += v.i; cc += v.c;
      const i = Math.floor(ci), c = Math.min(i, Math.floor(cc));
      ci -= i; cc -= c;
      if (i > 0) rows.push({ date: d, page: s.page, query: s.query, clicks: c, impressions: i, position: v.p });
    }
  }
  return rows;
}

export const makeClient = () => fakeGsc(buildRows(), { finalThrough: FINAL_THROUGH });
