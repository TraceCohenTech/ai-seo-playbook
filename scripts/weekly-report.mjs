#!/usr/bin/env node
/**
 * Weekly SEO Performance Report
 *
 * Pulls Search Console data and writes a weekly report: week-over-week totals, top pages,
 * trending and new queries, dropping pages, CTR triage (title rewrite candidates) and
 * queries you already rank 1-3 for.
 *
 * Windows are anchored on the LAST DATE WITH FINAL DATA (not "yesterday"): GSC's final data
 * lags 2-3 days, and a week ending yesterday would be short, producing false drops.
 * "This week" = the 7 days ending on that date; "last week" = the 7 days before it.
 *
 * Usage:
 *   node scripts/weekly-report.mjs --site sc-domain:example.com [--output weekly-seo-report.json]
 *
 * Options:
 *   --site     Search Console property (required): sc-domain:example.com or https://www.example.com/
 *   --output   Output JSON path (default: weekly-seo-report.json)
 *   --help     Show this help
 *
 * Output (JSON):
 *   period             { startDate, endDate, previousStartDate, previousEndDate } for this/last week
 *   summary            thisWeek / lastWeek totals, `changes` (% change, or null when last week was 0)
 *                      and `changesFormatted` ("+9.8%" or "n/a"; use these in issue text, never "+null%")
 *   topPages           top 50 pages by clicks over 28 days (URL variants such as a trailing slash are summed)
 *   trending           queries this week vs their weekly average over the prior 3 weeks, ranked by
 *                      impressions gained. Queries with no prior impressions have `new: true` and no growthPct.
 *   dropping           pages whose clicks fell >= 30% between the two halves of the 28 days. Both halves are
 *                      fetched in full, so `absentInRecent: true` means the page really had no data.
 *   ctrTriage          ALL pages ranked by impressions with >= 1000 impressions, CTR < 2%, position 3-20
 *   topRankingQueries  queries at average position <= 3 with >= 100 impressions this week
 *
 * Exit codes: 0 report written, 1 error.
 *
 * Designed to run weekly via GitHub Actions (.github/workflows/weekly-seo-report.yml).
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';
import { gscClient, queryAll } from '../lib/gsc.mjs';
import { lastDataDate, shiftDay, windowEnding, sumByPage, round, pct } from '../lib/gsc-rows.mjs';

export function pctChange(old, cur) {
  if (!old) return null;
  return round(((cur - old) / old) * 100, 1);
}
export function fmtChange(p) {
  if (p == null || !Number.isFinite(p)) return 'n/a';
  return p >= 0 ? `+${p}%` : `${p}%`;
}

/** All windows, anchored on the last final-data date. */
export function windows(end) {
  const thisWeek = windowEnding(end, 7);
  const lastWeek = windowEnding(shiftDay(end, -7), 7);
  return {
    thisWeek, lastWeek,
    last28: windowEnding(end, 28),
    prior3Weeks: { startDate: shiftDay(end, -27), endDate: shiftDay(end, -7) },
    firstHalf: { startDate: shiftDay(end, -27), endDate: shiftDay(end, -14) },
    secondHalf: windowEnding(end, 14),
  };
}

/** Totals from rows with dimensions ['date'] that fall inside a window. */
export function totals(dateRows, { startDate, endDate }) {
  let clicks = 0, impressions = 0, pw = 0;
  for (const r of dateRows) {
    const d = r.keys[0];
    if (d < startDate || d > endDate) continue;
    clicks += r.clicks; impressions += r.impressions; pw += r.position * r.impressions;
  }
  return { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: impressions ? pw / impressions : 0 };
}

export function summarize(dateRows, w) {
  const a = totals(dateRows, w.thisWeek), b = totals(dateRows, w.lastWeek);
  const view = (t) => ({ clicks: t.clicks, impressions: t.impressions, ctr: pct(t.ctr), position: round(t.position, 1) });
  const changes = {
    clicks: pctChange(b.clicks, a.clicks),
    impressions: pctChange(b.impressions, a.impressions),
    ctr: pctChange(b.ctr, a.ctr),
  };
  return {
    thisWeek: view(a), lastWeek: view(b), changes,
    changesFormatted: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, fmtChange(v)])),
  };
}

/**
 * Queries this week vs their weekly average over the prior 3 weeks. Ranked by impressions
 * gained (finite for new queries too). New queries get `new: true` and no growthPct.
 */
export function trendingQueries(thisRows, priorRows, { minImpressions = 50, minGrowthPct = 100, priorWeeks = 3, top = 20 } = {}) {
  const prior = new Map(priorRows.map((r) => [r.keys[0], r]));
  const out = [];
  for (const r of thisRows) {
    if (r.impressions < minImpressions) continue;
    const priorWeekly = (prior.get(r.keys[0])?.impressions || 0) / priorWeeks;
    const base = { query: r.keys[0], impressions: r.impressions, clicks: r.clicks, ctr: pct(r.ctr), position: round(r.position, 1), priorWeeklyImpressions: round(priorWeekly, 1), impressionDelta: round(r.impressions - priorWeekly, 1) };
    if (priorWeekly === 0) { out.push({ ...base, new: true }); continue; }
    const growthPct = round(((r.impressions - priorWeekly) / priorWeekly) * 100, 0);
    if (growthPct >= minGrowthPct) out.push({ ...base, new: false, growthPct });
  }
  return out.sort((a, b) => b.impressionDelta - a.impressionDelta || a.query.localeCompare(b.query)).slice(0, top);
}

/** firstHalf/secondHalf: Map<path, agg> from sumByPage over COMPLETE page lists. */
export function droppingPages(firstHalf, secondHalf, { minClicks = 5, minDropPct = 30, top = 15 } = {}) {
  const out = [];
  for (const [path, r] of firstHalf) {
    if (r.clicks < minClicks) continue;
    const recent = secondHalf.get(path);
    const recentClicks = recent?.clicks || 0;
    const dropPct = round(((r.clicks - recentClicks) / r.clicks) * 100, 0);
    if (dropPct >= minDropPct) out.push({ page: path, priorClicks: r.clicks, recentClicks, dropPct, absentInRecent: !recent });
  }
  return out.sort((a, b) => b.dropPct - a.dropPct || b.priorClicks - a.priorClicks).slice(0, top);
}

const pageView = (r) => ({ page: r.page, clicks: r.clicks, impressions: r.impressions, ctr: pct(r.ctr), position: round(r.position, 1), variantCount: r.variantCount });

/** Title-rewrite triage over ALL pages (not just the top pages by clicks), ranked by impressions. */
export function ctrTriage(pages, { minImpressions = 1000, maxCtr = 0.02, minPosition = 3, maxPosition = 20, top = 15 } = {}) {
  return [...pages.values()]
    .filter((r) => r.impressions >= minImpressions && r.ctr < maxCtr && r.position >= minPosition && r.position <= maxPosition)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, top)
    .map(pageView);
}

export function topRankingQueries(rows, { maxPosition = 3, minImpressions = 100, top = 20 } = {}) {
  return rows.filter((r) => r.position <= maxPosition && r.impressions >= minImpressions)
    .sort((a, b) => b.impressions - a.impressions).slice(0, top)
    .map((r) => ({ query: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: pct(r.ctr), position: round(r.position, 1) }));
}

export async function buildReport(sc, { site, today = new Date(), now = new Date(), log = () => {} }) {
  const end = await lastDataDate(sc, site, { dataState: 'final', today });
  const w = windows(end);
  const q = (win, dimensions) => queryAll(sc, site, { ...win, dimensions, dataState: 'final' });
  log(`Last final-data date: ${end}. Week: ${w.thisWeek.startDate} -> ${w.thisWeek.endDate}`);

  const dateRows = await q({ startDate: w.lastWeek.startDate, endDate: end }, ['date']);
  const pages28 = sumByPage(await q(w.last28, ['page']));
  const thisQueries = await q(w.thisWeek, ['query']);
  const priorQueries = await q(w.prior3Weeks, ['query']);
  const firstHalf = sumByPage(await q(w.firstHalf, ['page']));
  const secondHalf = sumByPage(await q(w.secondHalf, ['page']));

  return {
    generated: now.toISOString(),
    site,
    period: { ...w.thisWeek, previousStartDate: w.lastWeek.startDate, previousEndDate: w.lastWeek.endDate },
    lastFinalDataDate: end,
    summary: summarize(dateRows, w),
    topPages: [...pages28.values()].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 50).map(pageView),
    trending: trendingQueries(thisQueries, priorQueries),
    dropping: droppingPages(firstHalf, secondHalf),
    ctrTriage: ctrTriage(pages28),
    topRankingQueries: topRankingQueries(thisQueries),
  };
}

function print(report, output) {
  const s = report.summary;
  console.log('\n' + '='.repeat(60));
  console.log(` WEEKLY SEO REPORT  ${report.period.startDate} -> ${report.period.endDate}`);
  console.log('='.repeat(60));
  console.log(`\n  Clicks:      ${s.thisWeek.clicks.toLocaleString()} (${s.changesFormatted.clicks})`);
  console.log(`  Impressions: ${s.thisWeek.impressions.toLocaleString()} (${s.changesFormatted.impressions})`);
  console.log(`  CTR:         ${s.thisWeek.ctr}% (${s.changesFormatted.ctr})`);
  console.log(`  Avg Pos:     ${s.thisWeek.position}`);
  if (report.trending.length) {
    console.log('\n  TRENDING QUERIES (vs prior 3-week weekly average):');
    for (const t of report.trending.slice(0, 10)) console.log(`    ${String(t.impressions).padStart(6)} impr  ${t.new ? 'NEW ' : `+${t.growthPct}%`.padEnd(4)}  "${t.query}"`);
  }
  if (report.dropping.length) {
    console.log('\n  DROPPING PAGES (>= 30% click decline, last 14d vs prior 14d):');
    for (const d of report.dropping.slice(0, 5)) console.log(`    -${d.dropPct}%  ${d.page}${d.absentInRecent ? '  (no data in recent 14d)' : ''}`);
  }
  if (report.ctrTriage.length) {
    console.log('\n  TITLE REWRITE CANDIDATES (all pages, by impressions):');
    for (const c of report.ctrTriage.slice(0, 5)) console.log(`    ${c.impressions.toLocaleString().padStart(8)} impr  ${c.ctr}% CTR  pos ${c.position}  ${c.page}`);
  }
  console.log(`\n  Full report: ${output}\n`);
}

async function main() {
  const args = cli(import.meta.url, {
    site: { type: 'string', required: true },
    output: { type: 'string', default: 'weekly-seo-report.json' },
  });
  const sc = await gscClient();
  console.log(`\nGenerating weekly SEO report for ${args.site}`);
  const report = await buildReport(sc, { site: args.site, log: console.log });
  writeFileSync(args.output, JSON.stringify(report, null, 2));
  print(report, args.output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(fail);
