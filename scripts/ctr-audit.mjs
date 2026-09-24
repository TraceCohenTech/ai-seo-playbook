#!/usr/bin/env node
/**
 * CTR Audit: click-gap scorer
 *
 * Scores every page by its CLICK GAP: expected clicks (from a CTR-by-position curve) minus
 * actual clicks. Pages are tiered HIGH / MEDIUM / LOW as a review queue for title and snippet
 * work. The curve is a heuristic, so the gap is an estimate for ranking pages, not a forecast.
 *
 * Expected CTR is computed per query and then weighted by impressions, because a page's
 * average position blends many queries (a page at "position 6" may be #1 for one query and
 * #40 for another). Pages without query rows fall back to their average position.
 *
 * The curve (lib/ctr.mjs):
 *   --curve auto     (default) fit from this site's own query rows (median CTR by rounded
 *                    position) when there is enough data, else config/ctr-curve.json
 *   --curve fit      fit or fail
 *   --curve default  config/ctr-curve.json (illustrative defaults)
 *   --curve <file>   your own curve JSON, same shape as config/ctr-curve.json
 *
 * Usage:
 *   node scripts/ctr-audit.mjs --site sc-domain:example.com [--days 28] [--min-impressions 500] [--output ctr-audit.json]
 *
 * Options:
 *   --site              Search Console property (required)
 *   --days              Window length, ending on the last final-data date (default 28)
 *   --min-impressions   Minimum page impressions to include (default 500)
 *   --curve             auto | fit | default | path (default auto)
 *   --output            Output JSON path (default ctr-audit.json)
 *
 * Output (JSON): { generatedAt, site, period, curve, summary, pages: [{ url, clicks, impressions,
 *   ctr, position, expectedCtr, expectedClicks, clickGap, tier, variantCount }] }.
 *   ctr/expectedCtr are percentages. clickGap = expectedClicks - clicks (rounded).
 *
 * Exit codes: 0 audit written, 1 error.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';
import { gscClient, queryAll } from '../lib/gsc.mjs';
import { lastDataDate, windowEnding, sumByPage, sumByPageQuery, round, pct } from '../lib/gsc-rows.mjs';
import { resolveCurve, expectedCtr, describeCurve } from '../lib/ctr.mjs';

/** Heuristic tiers on the click gap and the CTR gap (fractions). */
export function tierPage(clickGap, ctr, expCtr) {
  const ctrGap = expCtr - ctr;
  if (clickGap >= 500 && ctrGap > 0.02) return 'HIGH';
  if (clickGap >= 200 && ctrGap > 0.01) return 'MEDIUM';
  if (clickGap >= 50) return 'LOW';
  return 'SKIP';
}

/**
 * pages: Map<path, agg> (sumByPage). pageQueries: Map from sumByPageQuery.
 * Returns scored pages (all tiers except SKIP), sorted by clickGap.
 */
export function scorePages(pages, pageQueries, curve, { minImpressions = 500 } = {}) {
  const byPage = new Map();
  for (const e of pageQueries.values()) {
    const b = byPage.get(e.page) || { impr: 0, exp: 0 };
    b.impr += e.impressions; b.exp += e.impressions * expectedCtr(curve, e.position);
    byPage.set(e.page, b);
  }
  const out = [];
  for (const p of pages.values()) {
    if (p.impressions < minImpressions) continue;
    const q = byPage.get(p.page);
    const expCtr = q && q.impr > 0 ? q.exp / q.impr : expectedCtr(curve, p.position);
    const expectedClicks = p.impressions * expCtr;
    const clickGap = Math.round(expectedClicks - p.clicks);
    const tier = tierPage(clickGap, p.ctr, expCtr);
    if (tier === 'SKIP') continue;
    out.push({
      url: p.page, clicks: p.clicks, impressions: p.impressions, ctr: pct(p.ctr), position: round(p.position, 1),
      expectedCtr: pct(expCtr), expectedClicks: Math.round(expectedClicks), clickGap, tier,
      expectedFrom: q ? 'queries' : 'page-position', variantCount: p.variantCount,
    });
  }
  return out.sort((a, b) => b.clickGap - a.clickGap || a.url.localeCompare(b.url));
}

export async function buildReport(sc, { site, days = 28, minImpressions = 500, curve: curveMode = 'auto', today = new Date(), now = new Date() }) {
  const end = await lastDataDate(sc, site, { dataState: 'final', today });
  const period = windowEnding(end, days);
  const pageRows = await queryAll(sc, site, { ...period, dimensions: ['page'], dataState: 'final' });
  const pqRows = await queryAll(sc, site, { ...period, dimensions: ['page', 'query'], dataState: 'final' });
  const pageQueries = sumByPageQuery(pqRows);
  const curve = resolveCurve(curveMode, [...pageQueries.values()]);
  const pages = scorePages(sumByPage(pageRows), pageQueries, curve, { minImpressions });
  const count = (t) => pages.filter((p) => p.tier === t).length;
  return {
    generatedAt: now.toISOString(),
    site,
    period,
    curve: describeCurve(curve),
    summary: {
      totalPages: pages.length, high: count('HIGH'), medium: count('MEDIUM'), low: count('LOW'),
      totalClickGap: pages.reduce((s, p) => s + p.clickGap, 0),
    },
    pages,
  };
}

async function main() {
  const a = cli(import.meta.url, {
    site: { type: 'string', required: true },
    days: { type: 'string', default: '28' },
    'min-impressions': { type: 'string', default: '500' },
    curve: { type: 'string', default: 'auto' },
    output: { type: 'string', default: 'ctr-audit.json' },
  });
  const sc = await gscClient();
  const out = await buildReport(sc, { site: a.site, days: Number(a.days), minImpressions: Number(a['min-impressions']), curve: a.curve });
  writeFileSync(a.output, JSON.stringify(out, null, 2));

  console.log(`\nCTR audit for ${a.site}, ${out.period.startDate} -> ${out.period.endDate}`);
  console.log(`Curve: ${out.curve.source} (${out.curve.label}). ${out.curve.note}`);
  console.log(`\n  Candidates: ${out.summary.totalPages}  HIGH ${out.summary.high}  MEDIUM ${out.summary.medium}  LOW ${out.summary.low}`);
  console.log(`  Total click gap (expected - actual, heuristic): ${out.summary.totalClickGap.toLocaleString()}\n`);
  for (const tier of ['HIGH', 'MEDIUM', 'LOW']) {
    const items = out.pages.filter((p) => p.tier === tier);
    if (!items.length) continue;
    console.log(`\n  ${tier} (${items.length}):`);
    console.log('  Gap      Impr       CTR    Exp CTR  Pos   URL');
    for (const p of items.slice(0, 15)) {
      console.log(`  ${String(p.clickGap).padStart(6)}  ${p.impressions.toLocaleString().padStart(9)}  ${`${p.ctr}%`.padStart(6)}  ${`${p.expectedCtr}%`.padStart(7)}  ${String(p.position).padStart(5)}   ${p.url}`);
    }
    if (items.length > 15) console.log(`  ... and ${items.length - 15} more`);
  }
  console.log(`\n  Full audit: ${a.output}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(fail);
