#!/usr/bin/env node
/**
 * Striking Distance Finder
 *
 * Finds page+query pairs ranking just off the top (default positions 5-20) with real
 * impressions: pages where improving the content that answers a query you already rank for
 * is a candidate for more clicks. Results are grouped by page.
 *
 * The "if improved" estimate is a HEURISTIC what-if: impressions x expected CTR at a target
 * position (8 for positions beyond 10, otherwise two positions higher, never above 3), minus the
 * page's ACTUAL clicks for those queries. Rankings are not guaranteed to move, impressions change
 * with position, and the curve is itself a heuristic, so treat gains as a ranking signal.
 *
 * Machine-shaped queries (lib/query-classifier.mjs: AI agents, scrapers, zero-click agent
 * patterns) are skipped by default because better content will not earn their clicks; pass
 * --include-machine to keep them.
 *
 * The curve (lib/ctr.mjs): --curve auto (default) fits a CTR-by-position curve from this site's
 * own query rows when there is enough data, else uses config/ctr-curve.json; also fit | default | <file>.
 *
 * Usage:
 *   node scripts/striking-distance.mjs --site sc-domain:example.com
 *   node scripts/striking-distance.mjs --site sc-domain:example.com --min-pos 5 --max-pos 20 --output striking.json
 *
 * Options:
 *   --site              Search Console property (required)
 *   --min-pos           Lowest average position to include (default 5)
 *   --max-pos           Highest average position to include (default 20)
 *   --min-impressions   Minimum impressions per page+query pair (default 200)
 *   --days              Window, ending on the last final-data date (default 28)
 *   --curve             auto | fit | default | path (default auto)
 *   --include-machine   Keep machine-shaped queries (default: skip them)
 *   --top               Pages to print (default 20)
 *   --output            Optional output JSON path
 *
 * Output (JSON): { generated, site, period, config, curve, totalOpportunities,
 *   estimatedTotalClickGain, opportunities: [{ page, topQuery, position, impressions, clicks, ctr,
 *   queryCount, targetPosition, projectedClicks, clickGain, actions }] }
 *
 * Exit codes: 0 finished, 1 error.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';
import { gscClient, queryAll } from '../lib/gsc.mjs';
import { lastDataDate, windowEnding, sumByPageQuery, round, pct } from '../lib/gsc-rows.mjs';
import { resolveCurve, expectedCtr, describeCurve } from '../lib/ctr.mjs';
import { isHumanQuery, isZeroClickAgent } from '../lib/query-classifier.mjs';

export const targetPosition = (pos) => (pos > 10 ? 8 : Math.max(3, Math.round(pos) - 2));

export function suggestActions(q, curve) {
  const actions = [];
  if (q.position > 10) {
    actions.push('Expand the section that answers this query; add specifics a searcher would look for');
    actions.push('Link to this page from related pages with descriptive anchor text');
  } else {
    actions.push('Answer related questions on the page (a short Q&A section)');
    actions.push('Update facts that are out of date; change lastmod only when the content materially changes');
  }
  if (q.ctr < expectedCtr(curve, q.position)) actions.push("CTR is below the curve for this position: review whether the title matches this query's intent");
  return actions;
}

/** pageQueries: Map from sumByPageQuery (variants already summed). */
export function findOpportunities(pageQueries, curve, { minPos = 5, maxPos = 20, minImpressions = 200, includeMachine = false } = {}) {
  const byPage = new Map();
  for (const q of pageQueries.values()) {
    if (q.position < minPos || q.position > maxPos || q.impressions < minImpressions) continue;
    if (!includeMachine && (!isHumanQuery(q.query) || isZeroClickAgent(q))) continue;
    (byPage.get(q.page) || byPage.set(q.page, []).get(q.page)).push(q);
  }
  const out = [];
  for (const [page, qs] of byPage) {
    qs.sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query));
    const impressions = qs.reduce((s, q) => s + q.impressions, 0);
    const clicks = qs.reduce((s, q) => s + q.clicks, 0);
    // Per query: projected clicks at its own target position vs the ACTUAL clicks it got.
    let projected = 0;
    for (const q of qs) projected += q.impressions * expectedCtr(curve, targetPosition(q.position));
    const top = qs[0];
    out.push({
      page, topQuery: top.query, position: round(top.position, 1), impressions, clicks,
      ctr: pct(impressions ? clicks / impressions : 0), queryCount: qs.length,
      targetPosition: targetPosition(top.position),
      projectedClicks: Math.round(projected),
      clickGain: Math.max(0, Math.round(projected - clicks)),
      actions: suggestActions(top, curve),
    });
  }
  return out.sort((a, b) => b.clickGain - a.clickGain || a.page.localeCompare(b.page));
}

export async function buildReport(sc, { site, days = 28, minPos = 5, maxPos = 20, minImpressions = 200, includeMachine = false, curve: curveMode = 'auto', today = new Date(), now = new Date() }) {
  const end = await lastDataDate(sc, site, { dataState: 'final', today });
  const period = windowEnding(end, days);
  const pageQueries = sumByPageQuery(await queryAll(sc, site, { ...period, dimensions: ['page', 'query'], dataState: 'final' }));
  const curve = resolveCurve(curveMode, [...pageQueries.values()]);
  const opportunities = findOpportunities(pageQueries, curve, { minPos, maxPos, minImpressions, includeMachine });
  return {
    generated: now.toISOString(), site, period,
    config: { minPos, maxPos, minImpressions, includeMachine, days },
    curve: describeCurve(curve),
    totalOpportunities: opportunities.length,
    estimatedTotalClickGain: opportunities.reduce((s, r) => s + r.clickGain, 0),
    opportunities,
  };
}

async function main() {
  const a = cli(import.meta.url, {
    site: { type: 'string', required: true },
    'min-pos': { type: 'string', default: '5' },
    'max-pos': { type: 'string', default: '20' },
    'min-impressions': { type: 'string', default: '200' },
    days: { type: 'string', default: '28' },
    curve: { type: 'string', default: 'auto' },
    'include-machine': { type: 'boolean', default: false },
    top: { type: 'string', default: '20' },
    output: { type: 'string' },
  });
  const sc = await gscClient();
  const r = await buildReport(sc, {
    site: a.site, days: Number(a.days), minPos: Number(a['min-pos']), maxPos: Number(a['max-pos']),
    minImpressions: Number(a['min-impressions']), includeMachine: a['include-machine'], curve: a.curve,
  });
  console.log(`\nStriking distance for ${a.site}, ${r.period.startDate} -> ${r.period.endDate}`);
  console.log(`Curve: ${r.curve.source} (${r.curve.label}). ${r.curve.note}`);
  console.log(`${r.totalOpportunities} pages with queries at position ${r.config.minPos}-${r.config.maxPos} and >= ${r.config.minImpressions} impressions`);
  console.log(`Heuristic what-if total if every query reached its target position: +${r.estimatedTotalClickGain.toLocaleString()} clicks\n`);
  for (const o of r.opportunities.slice(0, Number(a.top))) {
    console.log(`  ${o.page}`);
    console.log(`    Top query: "${o.topQuery}" (pos ${o.position}); ${o.impressions.toLocaleString()} impr, ${o.clicks} clicks, ${o.queryCount} queries`);
    console.log(`    What-if (heuristic): +${o.clickGain} clicks per ${r.config.days} days`);
    for (const x of o.actions) console.log(`    - ${x}`);
    console.log();
  }
  if (a.output) { writeFileSync(a.output, JSON.stringify(r, null, 2)); console.log(`Report saved to ${a.output}`); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(fail);
