#!/usr/bin/env node
/**
 * Query Gap Miner
 *
 * Finds queries your site already appears for, with real impressions but a weak average
 * position (default 15+), where NO SINGLE existing page closely matches the query. These are
 * candidates for a dedicated page, or for expanding the closest page.
 *
 * Matching is per page. Each page is represented by its slug and title tokens (from --dir,
 * or, without --dir, the slugs of the URLs Search Console reports). A query is scored against
 * every page with IDF-weighted token coverage:
 *
 *   score(query, page) = sum of idf(t) for query tokens t found on the page
 *                        / sum of idf(t) over all query tokens
 *
 * with BM25's idf, idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5)), so rare, specific words count
 * for more than common ones, and a word that appears on no page counts the most. The page with
 * the highest score is reported as `closestPage` (with its token Jaccard similarity too). A
 * query is a gap when that best score is below --match-threshold. (The old version pooled every
 * word on the site into one bag, so on a large site almost any query looked covered.)
 *
 * Usage:
 *   node scripts/query-gap-miner.mjs --site sc-domain:example.com --dir ./app
 *   node scripts/query-gap-miner.mjs --site sc-domain:example.com --dir ./content/blog --url-prefix /blog --min-impressions 50 --top 30
 *
 * Options:
 *   --site              Search Console property (required)
 *   --dir               Content directory (App Router, Pages Router, Markdown/MDX); optional
 *   --url-prefix        URL prefix for Markdown files under --dir (default none)
 *   --min-impressions   Minimum query impressions (default 80)
 *   --min-position      Minimum average position (default 15)
 *   --match-threshold   Best-page score at or above which a query counts as covered (default 0.6)
 *   --days              Window, ending on the last final-data date (default 60)
 *   --top               Gaps to report (default 25)
 *   --output            Optional output JSON path
 *
 * Output (JSON): { generated, site, period, config, corpus: { source, pages }, totalQueries,
 *   eligibleQueries, coveredCount, gaps: [{ query, clicks, impressions, ctr, position, type,
 *   priority, closestPage: { page, title, score, jaccard } | null }] }
 *   priority = impressions / position, a heuristic ordering only.
 *
 * Exit codes: 0 finished, 1 error.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';
import { gscClient, queryAll } from '../lib/gsc.mjs';
import { lastDataDate, windowEnding, sumByPage, round, pct } from '../lib/gsc-rows.mjs';
import { scanContent } from '../lib/content-routes.mjs';

const STOP = new Set(('a an the of for to in on and or is are was be by with from at as it its this that what how why when where who ' +
  'which do does can vs versus your my our i you we').split(' '));
const EXCLUDE = [/near me/i, /jailbreak/i, /login/i, /sign ?in/i];

export function tokenize(s) {
  return [...new Set(String(s || '').toLowerCase().replace(/&amp;/g, ' ').split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)))];
}

/** docs: [{ page, title }]. Returns an index with per-page token sets and idf. */
export function buildIndex(docs) {
  const pages = docs.map((d) => ({ page: d.page, title: d.title || '', tokens: new Set([...tokenize(String(d.page).split('/').pop().replace(/[-_]/g, ' ')), ...tokenize(d.title)]) }));
  const df = new Map();
  for (const p of pages) for (const t of p.tokens) df.set(t, (df.get(t) || 0) + 1);
  const N = pages.length;
  const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
  return { pages, idf };
}

/** Best-matching page for a query: { page, title, score, jaccard } or null. */
export function closestPage(query, index) {
  const q = tokenize(query);
  if (!q.length || !index.pages.length) return null;
  const total = q.reduce((s, t) => s + index.idf(t), 0);
  let best = null;
  for (const p of index.pages) {
    const hit = q.filter((t) => p.tokens.has(t));
    const score = hit.reduce((s, t) => s + index.idf(t), 0) / total;
    const jaccard = hit.length / new Set([...q, ...p.tokens]).size;
    if (!best || score > best.score || (score === best.score && jaccard > best.jaccard)) best = { page: p.page, title: p.title, score, jaccard };
  }
  return best && { ...best, score: round(best.score, 2), jaccard: round(best.jaccard, 2) };
}

export function classifyOpportunity(query) {
  if (/\b20\d\d\b/.test(query)) return 'TIME-SENSITIVE';
  if (/^(what|how|why|when|where|who|is|are|can|do|does)\b/i.test(query)) return 'QUESTION';
  if (/\bvs\b|versus|compared?\b|comparison/i.test(query)) return 'COMPARISON';
  if (/\bbest\b|\btop\b|ranking|rated/i.test(query)) return 'RANKING';
  if (/\bprice|cost|salary|worth|valuation|revenue/i.test(query)) return 'DATA-DRIVEN';
  return 'INFORMATIONAL';
}

/** rows: GSC rows with dimensions ['query']. */
export function findGaps(rows, index, { minImpressions = 80, minPosition = 15, matchThreshold = 0.6, top = 25 } = {}) {
  const eligible = rows.filter((r) => r.impressions >= minImpressions && r.position >= minPosition && !EXCLUDE.some((p) => p.test(r.keys[0])));
  const gaps = [];
  let covered = 0;
  for (const r of eligible) {
    const cp = closestPage(r.keys[0], index);
    if (cp && cp.score >= matchThreshold) { covered++; continue; }
    gaps.push({
      query: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: pct(r.ctr), position: round(r.position, 1),
      type: classifyOpportunity(r.keys[0]), priority: round(r.impressions / r.position, 1), closestPage: cp,
    });
  }
  gaps.sort((a, b) => b.priority - a.priority || a.query.localeCompare(b.query));
  return { eligibleQueries: eligible.length, coveredCount: covered, gaps: gaps.slice(0, top) };
}

export async function buildReport(sc, { site, dir, urlPrefix = '', days = 60, minImpressions = 80, minPosition = 15, matchThreshold = 0.6, top = 25, today = new Date(), now = new Date() }) {
  const end = await lastDataDate(sc, site, { dataState: 'final', today });
  const period = windowEnding(end, days);
  const rows = await queryAll(sc, site, { ...period, dimensions: ['query'], dataState: 'final' });
  let docs, source;
  if (dir) {
    docs = (await scanContent(dir, { urlPrefix })).filter((f) => f.route).map((f) => ({ page: f.route, title: f.title }));
    source = 'files';
  } else {
    docs = [...sumByPage(await queryAll(sc, site, { ...period, dimensions: ['page'], dataState: 'final' })).keys()].map((page) => ({ page, title: '' }));
    source = 'gsc-urls (slugs only; pass --dir to include titles)';
  }
  const res = findGaps(rows, buildIndex(docs), { minImpressions, minPosition, matchThreshold, top });
  return {
    generated: now.toISOString(), site, period,
    config: { minImpressions, minPosition, matchThreshold, days, top },
    corpus: { source, pages: docs.length },
    totalQueries: rows.length,
    ...res,
  };
}

async function main() {
  const a = cli(import.meta.url, {
    site: { type: 'string', required: true },
    dir: { type: 'string' },
    'url-prefix': { type: 'string', default: '' },
    'min-impressions': { type: 'string', default: '80' },
    'min-position': { type: 'string', default: '15' },
    'match-threshold': { type: 'string', default: '0.6' },
    days: { type: 'string', default: '60' },
    top: { type: 'string', default: '25' },
    output: { type: 'string' },
  });
  const sc = await gscClient();
  const r = await buildReport(sc, {
    site: a.site, dir: a.dir, urlPrefix: a['url-prefix'], days: Number(a.days), minImpressions: Number(a['min-impressions']),
    minPosition: Number(a['min-position']), matchThreshold: Number(a['match-threshold']), top: Number(a.top),
  });
  console.log(`\nQuery gaps for ${a.site}, ${r.period.startDate} -> ${r.period.endDate}; corpus: ${r.corpus.pages} pages from ${r.corpus.source}`);
  console.log(`${r.eligibleQueries} queries with >= ${r.config.minImpressions} impressions at position >= ${r.config.minPosition}; ${r.coveredCount} matched an existing page (score >= ${r.config.matchThreshold}).\n`);
  for (const g of r.gaps) {
    console.log(`  [${g.type}] "${g.query}"  ${g.impressions.toLocaleString()} impr, pos ${g.position}, ${g.clicks} clicks`);
    console.log(g.closestPage ? `    closest page: ${g.closestPage.page} (score ${g.closestPage.score}, jaccard ${g.closestPage.jaccard})` : '    closest page: none');
  }
  if (a.output) { writeFileSync(a.output, JSON.stringify(r, null, 2)); console.log(`\nReport saved to ${a.output}`); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(fail);
