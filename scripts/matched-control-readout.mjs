#!/usr/bin/env node
/**
 * Matched-Control Readout: did your SEO change actually work?
 *
 * Before/after comparisons lie. Sites grow, seasons shift, Google updates, and pages you
 * picked because they were peaking regress to the mean. Compare each changed cohort
 * against a MATCHED control: pages that existed in the "before" window with real
 * impressions, that you did NOT touch, measured over the same two windows.
 *
 * On valueaddvc.com this showed: title rewrites +44% clicks vs control +1%; snippet
 * rewrites +2% vs +14% (neutral, not worth the tokens); freshness refreshes -38%, but
 * only because they had picked fading news spikes.
 *
 * Usage:
 *   node scripts/matched-control-readout.mjs --site sc-domain:example.com --changes changes.json [--window 21] [--min-impr 300] [--path-contains /blog/]
 *   changes.json: [{ "page": "https://example.com/blog/x" | "/blog/x", "changedAt": "2026-08-20", "cohort": "retitle" }, ...]
 */
import { cli } from '../lib/cli.mjs';
import { readFileSync } from 'node:fs';
import { gscClient, queryAll, isoDay } from '../lib/gsc.mjs';

const a = cli(import.meta.url, {
  site: { type: 'string', required: true }, changes: { type: 'string', required: true }, window: { type: 'string', default: '21' },
  'min-impr': { type: 'string', default: '300' }, 'path-contains': { type: 'string' },
});

const W = Number(a.window), minImpr = Number(a['min-impr']);
const changes = JSON.parse(readFileSync(a.changes, 'utf8'));
const norm = (u) => u.replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, '') || '/';
const shift = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return isoDay(x); };
const touched = new Set(changes.map((c) => norm(c.page)));
const sc = await gscClient();
const filters = a['path-contains'] ? [{ dimension: 'page', operator: 'contains', expression: a['path-contains'] }] : undefined;
const cache = new Map();
async function pages(start, end) {
  const k = start + end; if (cache.has(k)) return cache.get(k);
  const m = new Map();
  // SUM, don't overwrite: GSC reports URL variants separately (trailing slash, typo'd inbound links), and
  // they normalize to the same page. Overwriting let a 0-click variant erase a 518-click page.
  for (const r of await queryAll(sc, a.site, { startDate: start, endDate: end, dimensions: ['page'], filters })) {
    const k = norm(r.keys[0]), e = m.get(k) || { c: 0, i: 0 };
    e.c += r.clicks; e.i += r.impressions; m.set(k, e);
  }
  cache.set(k, m); return m;
}

// Group changes into cohorts by (cohort, changedAt): each cohort gets its own windows and control.
const cohorts = new Map();
for (const c of changes) { const k = `${c.cohort || 'change'}|${c.changedAt}`; (cohorts.get(k) || cohorts.set(k, []).get(k)).push(norm(c.page)); }
const pctChg = (x, y) => (x > 0 ? (100 * (y / x - 1)).toFixed(0) + '%' : 'n/a');
for (const [k, list] of cohorts) {
  const [cohort, date] = k.split('|');
  const pre = await pages(shift(date, -W), shift(date, -1)), post = await pages(shift(date, 1), shift(date, W));
  const agg = (set) => { let c0 = 0, i0 = 0, c1 = 0, i1 = 0, n = 0; for (const p of set) { const b = pre.get(p); if (!b || b.i < minImpr) continue; const f = post.get(p) || { c: 0, i: 0 }; c0 += b.c; i0 += b.i; c1 += f.c; i1 += f.i; n++; } return { n, c0, c1, i0, i1 }; };
  const t = agg(list), ctl = agg([...pre.keys()].filter((p) => !touched.has(p)));
  console.log(`\n## ${cohort} on ${date} (±${W}d)`);
  console.log(`  treated ${t.n} pages: clicks ${t.c0}→${t.c1} (${pctChg(t.c0, t.c1)}), CTR ${(100 * t.c0 / Math.max(t.i0, 1)).toFixed(2)}%→${(100 * t.c1 / Math.max(t.i1, 1)).toFixed(2)}%`);
  console.log(`  control ${ctl.n} pages: clicks ${ctl.c0}→${ctl.c1} (${pctChg(ctl.c0, ctl.c1)}), CTR ${(100 * ctl.c0 / Math.max(ctl.i0, 1)).toFixed(2)}%→${(100 * ctl.c1 / Math.max(ctl.i1, 1)).toFixed(2)}%`);
  if (t.n < 10) console.log('  ⚠ fewer than 10 treated pages: treat this as a hint, not a result');
}
