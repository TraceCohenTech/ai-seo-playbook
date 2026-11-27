/**
 * Deterministic synthetic Search Console rows for filter-detector tests. No real site data.
 * Every scenario: daily rows 2026-09-25 .. 2026-11-10, cliff 2026-10-19.
 *   sitewide  every type/country/device keeps ~1-3%, positions held (one survivor page keeps ~10%)
 *   demotion  pages keep ~40% of impressions but rank ~5 positions lower
 *   localized /blog keeps ~90%, /news keeps ~5%
 *   nocliff   everything keeps ~95%
 * Regenerate the static CLI fixtures with: node tests/fixtures/filter/make-fixtures.mjs
 */
export const CLIFF = '2026-10-19';
export const START = '2026-09-25';
export const END = '2026-11-10';

const shift = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export function dates() { const out = []; for (let d = START; d <= END; d = shift(d, 1)) out.push(d); return out; }

// page, pre impressions/day, pre position
const PAGES = [
  ['/', 120, 1.5], ['/blog/acme-is-profitable', 900, 3.5], ['/blog/widget-market-size', 600, 4.2], ['/blog/how-funds-work', 300, 5.1],
  ['/blog/tiny-post', 10, 8], ['/news/acme-raises', 500, 2.8], ['/news/beta-ipo', 400, 3.3], ['/vc/example-capital', 150, 6],
  ['/tools/calculator', 80, 7], ['https://data.example.com/report', 60, 4],
];
const SCEN = {
  sitewide: { keep: (p) => (p === '/blog/widget-market-size' ? 0.1 : p.startsWith('/news') ? 0.008 : 0.02), pos: (x) => x - 0.4 },
  demotion: { keep: () => 0.4, pos: (x) => x + 5 },
  localized: { keep: (p) => (p.startsWith('/blog') ? 0.9 : p.startsWith('/news') ? 0.05 : 0.6), pos: (x) => x },
  nocliff: { keep: () => 0.95, pos: (x) => x },
};
const SPLITS = {
  country: { sitewide: [['usa', 0.55, 0.017], ['gbr', 0.15, 0.017], ['ind', 0.2, 0.01], ['bra', 0.1, 0.011]] },
  device: { sitewide: [['DESKTOP', 0.7, 0.015], ['MOBILE', 0.3, 0.021]] },
};

/** Rows in parsed form ({ key, date, impressions, clicks, position }). */
export function scenario(kind) {
  const s = SCEN[kind];
  const pages = [], countries = [], devices = [];
  let preTotal = 0;
  for (const [, impr] of PAGES) preTotal += impr;
  for (const date of dates()) {
    const post = date > CLIFF, onCliff = date === CLIFF;
    for (const [page, impr, pos] of PAGES) {
      const k = post ? s.keep(page) : onCliff ? 0.3 : 1;
      const i = Math.round(impr * k);
      if (!i) continue; // GSC omits zero rows
      pages.push({ key: page, date, impressions: i, clicks: Math.round(i * 0.01), position: post ? s.pos(pos) : pos });
    }
    for (const [dim, out] of [['country', countries], ['device', devices]]) {
      const split = SPLITS[dim][kind] || SPLITS[dim].sitewide.map(([n, share]) => [n, share, SCEN[kind].keep('/blog/x')]);
      for (const [name, share, keep] of split) {
        const i = Math.round(preTotal * share * (post ? keep : 1));
        if (i) out.push({ key: name, date, impressions: i, clicks: Math.round(i * 0.01), position: post ? s.pos(4) : 4 });
      }
    }
  }
  return { pages, countries, devices };
}
