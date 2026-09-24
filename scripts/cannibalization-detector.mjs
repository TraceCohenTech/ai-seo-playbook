#!/usr/bin/env node
/**
 * Cannibalization Detector
 *
 * Finds queries where two or more of your pages rank at CLOSE positions and NO page wins most
 * of the clicks: the pattern where pages may be splitting a query between them. Several URLs
 * ranking for one query is normal (Google often shows two results from one site), so the
 * script only flags the ambiguous cases and labels every one REVIEW. It never recommends a
 * redirect: whether to merge, differentiate, or leave pages alone is an editorial decision.
 *
 * Skipped by design:
 *   - brand queries (any query containing a --brand term)
 *   - queries the homepage ranks for (the root URL '/', or the prefix of a URL-prefix property)
 *   - URL variants of one page (trailing slash, www/bare host, #fragments) are SUMMED into one
 *     page first, so they never look like two competing pages
 *
 * Usage:
 *   node scripts/cannibalization-detector.mjs --site sc-domain:example.com
 *   node scripts/cannibalization-detector.mjs --site sc-domain:example.com --brand "example capital,examplecap"
 *   node scripts/cannibalization-detector.mjs --site sc-domain:example.com --query "acme pricing,acme cost"
 *   node scripts/cannibalization-detector.mjs --site sc-domain:example.com --page /blog/acme-pricing
 *
 * Checking a new page's target queries (config/vertical-expansion.json): pass them with
 * --query; every query containing one of the terms (case-insensitive) is checked.
 *
 * Options:
 *   --site               Search Console property (required)
 *   --days               Window length in days, ending on the last final-data date (default 28)
 *   --min-impressions    Minimum impressions for a page to count as ranking for a query (default 50)
 *   --max-position-gap   Pages count as "close" when within this many positions of the best page (default 3)
 *   --winner-share       If one page has at least this share of the query's clicks it wins, and the
 *                        query is not flagged (default 0.6)
 *   --brand              Comma-separated brand terms; queries containing any are excluded
 *   --include-machine    Keep machine-shaped / zero-click agent queries (default: skip them)
 *   --query              Comma-separated terms; only check queries containing one of them
 *   --page               Comma-separated paths or URLs; only report clusters that include one of them
 *   --output             Output JSON path (default cannibal-clusters.json)
 *   --top                Clusters to print (default 20)
 *
 * Output (JSON): { generated, site, period, config, stats, clusters: [{ query, action: "REVIEW",
 *   pages: [{ page, position, clicks, impressions, clickShare }], totalImpressions, totalClicks,
 *   positionSpread, topClickShare, reason }] }, sorted by totalImpressions.
 *
 * Exit codes: 0 finished (with or without clusters), 1 error.
 */
import { isHumanQuery, isZeroClickAgent } from '../lib/query-classifier.mjs';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';
import { gscClient, queryAll } from '../lib/gsc.mjs';
import { lastDataDate, windowEnding, sumByPageQuery, normPath, propertyPathPrefix, round } from '../lib/gsc-rows.mjs';

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * rows: GSC rows with dimensions ['query','page'].
 * Returns { clusters, stats }.
 */
export function findClusters(rows, {
  minImpressions = 50, maxPositionGap = 3, winnerShare = 0.6,
  brand = [], queries = [], pages = [], root = '/', includeMachine = false,
} = {}) {
  const brandTerms = brand.map((b) => b.toLowerCase());
  const queryTerms = queries.map((q) => q.toLowerCase());
  const pageFilter = new Set(pages.map(normPath));
  const stats = { queriesSeen: 0, excludedMachine: 0, excludedBrand: 0, excludedHomepage: 0, singlePage: 0, notClose: 0, clearWinner: 0, flagged: 0 };

  const byQuery = new Map();
  for (const e of sumByPageQuery(rows, { queryIdx: 0, pageIdx: 1 }).values()) {
    (byQuery.get(e.query) || byQuery.set(e.query, []).get(e.query)).push(e);
  }

  const clusters = [];
  for (const [query, all] of byQuery) {
    const q = query.toLowerCase();
    if (queryTerms.length && !queryTerms.some((t) => q.includes(t))) continue;
    stats.queriesSeen++;
    // AI-agent / scraper queries (lib/query-classifier.mjs) don't reflect a human choosing between your
    // pages; one 0-click agent query was the top "cannibalization" hit on a real site.
    if (!includeMachine) {
      const tot = all.reduce((m, p) => ({ impressions: m.impressions + p.impressions, clicks: m.clicks + p.clicks, pw: m.pw + p.position * p.impressions }), { impressions: 0, clicks: 0, pw: 0 });
      if (!isHumanQuery(query) || isZeroClickAgent({ impressions: tot.impressions, clicks: tot.clicks, position: tot.impressions ? tot.pw / tot.impressions : 99 })) { stats.excludedMachine++; continue; }
    }
    if (brandTerms.some((b) => q.includes(b))) { stats.excludedBrand++; continue; }
    if (all.some((p) => p.page === root)) { stats.excludedHomepage++; continue; }

    const ranking = all.filter((p) => p.impressions >= minImpressions).sort((a, b) => a.position - b.position);
    if (ranking.length < 2) { stats.singlePage++; continue; }
    const best = ranking[0].position;
    const close = ranking.filter((p) => p.position - best <= maxPositionGap);
    if (close.length < 2) { stats.notClose++; continue; }

    const totalClicks = all.reduce((s, p) => s + p.clicks, 0);
    const topClicks = Math.max(...all.map((p) => p.clicks));
    const topClickShare = totalClicks > 0 ? topClicks / totalClicks : 0;
    if (totalClicks > 0 && topClickShare >= winnerShare) { stats.clearWinner++; continue; }
    if (pageFilter.size && !close.some((p) => pageFilter.has(p.page))) continue;

    stats.flagged++;
    clusters.push({
      query,
      action: 'REVIEW',
      pages: close.map((p) => ({
        page: p.page, position: round(p.position, 1), clicks: p.clicks, impressions: p.impressions,
        clickShare: totalClicks > 0 ? round(p.clicks / totalClicks, 2) : 0,
      })),
      totalImpressions: all.reduce((s, p) => s + p.impressions, 0),
      totalClicks,
      positionSpread: round(close[close.length - 1].position - best, 1),
      topClickShare: round(topClickShare, 2),
      reason: totalClicks === 0
        ? `${close.length} pages within ${maxPositionGap} positions and no clicks at all`
        : `${close.length} pages within ${maxPositionGap} positions; no page has ${Math.round(winnerShare * 100)}% of clicks`,
    });
  }
  clusters.sort((a, b) => b.totalImpressions - a.totalImpressions || a.query.localeCompare(b.query));
  return { clusters, stats };
}

export async function buildReport(sc, opts) {
  const { site, days = 28, today = new Date(), now = new Date() } = opts;
  const end = await lastDataDate(sc, site, { dataState: 'final', today });
  const period = windowEnding(end, days);
  // Paginated past the 25K-row API cap.
  const rows = await queryAll(sc, site, { ...period, dimensions: ['query', 'page'], dataState: 'final' });
  const config = {
    minImpressions: opts.minImpressions ?? 50, maxPositionGap: opts.maxPositionGap ?? 3, winnerShare: opts.winnerShare ?? 0.6,
    brand: opts.brand || [], queries: opts.queries || [], pages: opts.pages || [],
    root: propertyPathPrefix(site) || '/', includeMachine: !!opts.includeMachine,
  };
  const { clusters, stats } = findClusters(rows, config);
  return { generated: now.toISOString(), site, period, config, stats: { rowsFetched: rows.length, ...stats }, clusters };
}

async function main() {
  const a = cli(import.meta.url, {
    site: { type: 'string', required: true },
    days: { type: 'string', default: '28' },
    'min-impressions': { type: 'string', default: '50' },
    'max-position-gap': { type: 'string', default: '3' },
    'winner-share': { type: 'string', default: '0.6' },
    brand: { type: 'string' },
    query: { type: 'string' },
    page: { type: 'string' },
    output: { type: 'string', default: 'cannibal-clusters.json' },
    top: { type: 'string', default: '20' },
    'include-machine': { type: 'boolean', default: false },
  });
  const sc = await gscClient();
  const report = await buildReport(sc, {
    site: a.site, days: Number(a.days), minImpressions: Number(a['min-impressions']),
    maxPositionGap: Number(a['max-position-gap']), winnerShare: Number(a['winner-share']),
    brand: list(a.brand), queries: list(a.query), pages: list(a.page), includeMachine: a['include-machine'],
  });
  writeFileSync(a.output, JSON.stringify(report, null, 2));

  const { stats, clusters } = report;
  console.log(`\nCannibalization scan for ${a.site}, ${report.period.startDate} -> ${report.period.endDate}`);
  console.log(`${stats.rowsFetched} query/page rows; ${stats.queriesSeen} queries checked; skipped ${stats.excludedMachine} machine-shaped, ${stats.excludedBrand} brand, ${stats.excludedHomepage} homepage, ${stats.clearWinner} with a clear winner.`);
  console.log(`${clusters.length} queries to REVIEW (close positions, no page winning most clicks):\n`);
  for (const c of clusters.slice(0, Number(a.top))) {
    console.log(`  REVIEW  "${c.query}"  ${c.totalImpressions.toLocaleString()} impr, ${c.totalClicks} clicks`);
    for (const p of c.pages) console.log(`          pos ${String(p.position).padEnd(5)} ${String(p.clicks).padStart(5)} clicks (${Math.round(p.clickShare * 100)}%)  ${p.page}`);
  }
  console.log('\nREVIEW means: compare intent and content of these pages. Options include differentiating them,');
  console.log('linking between them, or merging; none is automatic. Never redirect the homepage.');
  console.log(`\nFull results: ${a.output}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(fail);
