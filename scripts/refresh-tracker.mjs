#!/usr/bin/env node
/**
 * Refresh Tracker
 *
 * Lists pages that still earn search impressions but whose content has not been updated for a
 * while: candidates to review for outdated facts. Whether a refresh helps rankings depends on
 * the page and query; this script only finds the stale ones with demand.
 *
 * Matching files to URLs is by EXACT PATH:
 *   - App Router `app/blog/foo/page.tsx` -> `/blog/foo` (the slug is the parent directory;
 *     route groups are dropped; dynamic `[slug]` routes cannot be matched and are skipped)
 *   - Markdown/MDX -> path relative to --dir, prefixed with --url-prefix
 *     (e.g. --dir content/blog --url-prefix /blog maps content/blog/foo.md to /blog/foo)
 *   - URL variants (trailing slash, www, #fragments) are normalised and their metrics summed.
 * When no --url-prefix is given and a URL has no exact match, a file is accepted only if its
 * slug equals the URL's LAST path segment exactly and no other file has that slug (match
 * "slug-unique"). Substring matching is never used.
 *
 * Last-updated date: frontmatter/metadata lastUpdated, updated, dateModified, modified, then
 * date/datePublished; otherwise the file mtime (unreliable after a git clone; reported as
 * dateSource "mtime").
 *
 * Usage:
 *   node scripts/refresh-tracker.mjs --site sc-domain:example.com --dir ./app
 *   node scripts/refresh-tracker.mjs --site sc-domain:example.com --dir ./content/blog --url-prefix /blog --stale-days 60
 *
 * Options:
 *   --site              Search Console property (required)
 *   --dir               Content directory to scan (required)
 *   --url-prefix        URL path prefix for Markdown files under --dir (default none)
 *   --stale-days        Days since update to count as stale (default 30)
 *   --min-impressions   Minimum page impressions over the window (default 100)
 *   --days              Window, ending on the last final-data date (default 28)
 *   --output            Optional output JSON path
 *
 * Output (JSON): { generated, config, period, refreshCandidates: [{ url, file, match, impressions,
 *   clicks, ctr, position, lastUpdated, dateSource, daysSinceUpdate, urgency, reason }],
 *   healthyCount, unmatched: [paths], skippedDynamicRoutes }
 *
 * Exit codes: 0 finished, 1 error.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';
import { gscClient, queryAll } from '../lib/gsc.mjs';
import { lastDataDate, windowEnding, sumByPage, normPath, toDay, round, pct } from '../lib/gsc-rows.mjs';
import { scanContent } from '../lib/content-routes.mjs';

/** files: scanContent output. Returns a matcher(urlOrPath) -> { file, match } | null. */
export function makeMatcher(files, { allowSlugFallback = true } = {}) {
  const byRoute = new Map(), bySlug = new Map();
  for (const f of files) {
    if (!f.route) continue;
    byRoute.set(f.route, f);
    if (f.slug) bySlug.set(f.slug, bySlug.has(f.slug) ? null : f); // null marks an ambiguous slug
  }
  return (url) => {
    const path = normPath(url).replace(/\?.*$/, '');
    if (byRoute.has(path)) return { file: byRoute.get(path), match: 'exact' };
    if (!allowSlugFallback) return null;
    const last = path.split('/').pop();
    const f = last ? bySlug.get(last) : null;
    return f ? { file: f, match: 'slug-unique' } : null;
  };
}

export function fileDate(f) {
  if (f.updated) return { date: f.updated.date, source: f.updated.field };
  return { date: toDay(f.mtime), source: 'mtime' };
}

export function refreshReason(e) {
  const r = [];
  if (e.impressions > 5000 && e.ctr < 0.5) r.push('High impressions with CTR under 0.5%: review the title alongside the content');
  if (e.position >= 4 && e.position <= 10) r.push('On page one: check facts, dates and examples are current');
  if (e.position > 10 && e.position <= 20) r.push('Page two: check whether the content still fully answers its main queries');
  if (!r.length) r.push('Stale and still getting impressions: review for outdated information');
  return r.join('. ');
}

/** pages: Map from sumByPage. files: scanContent output. now: Date. */
export function classify(pages, files, { staleDays = 30, minImpressions = 100, urlPrefix = '', now = new Date() } = {}) {
  const match = makeMatcher(files, { allowSlugFallback: !urlPrefix });
  const refreshCandidates = [], unmatched = [];
  let healthy = 0;
  for (const p of pages.values()) {
    if (p.impressions < minImpressions) continue;
    const m = match(p.page);
    if (!m) { unmatched.push(p.page); continue; }
    const d = fileDate(m.file);
    const daysSinceUpdate = Math.floor((now.getTime() - Date.parse(`${d.date}T00:00:00Z`)) / 864e5);
    const e = {
      url: p.page, file: m.file.rel, match: m.match, impressions: p.impressions, clicks: p.clicks,
      ctr: pct(p.ctr), position: round(p.position, 1), lastUpdated: d.date, dateSource: d.source, daysSinceUpdate,
    };
    if (daysSinceUpdate < staleDays) { healthy++; continue; }
    e.urgency = daysSinceUpdate >= staleDays * 2 ? 'CRITICAL' : 'HIGH';
    e.reason = refreshReason(e);
    refreshCandidates.push(e);
  }
  const order = { CRITICAL: 0, HIGH: 1 };
  refreshCandidates.sort((a, b) => order[a.urgency] - order[b.urgency] || b.impressions - a.impressions);
  return { refreshCandidates, healthyCount: healthy, unmatched: unmatched.sort() };
}

export async function buildReport(sc, { site, dir, urlPrefix = '', staleDays = 30, minImpressions = 100, days = 28, today = new Date(), now = new Date() }) {
  const end = await lastDataDate(sc, site, { dataState: 'final', today });
  const period = windowEnding(end, days);
  const pages = sumByPage(await queryAll(sc, site, { ...period, dimensions: ['page'], dataState: 'final' }));
  const files = await scanContent(dir, { urlPrefix });
  const res = classify(pages, files, { staleDays, minImpressions, urlPrefix, now });
  return {
    generated: now.toISOString(),
    config: { staleDays, minImpressions, urlPrefix, days },
    period,
    ...res,
    skippedDynamicRoutes: files.filter((f) => !f.route).map((f) => f.rel),
  };
}

async function main() {
  const a = cli(import.meta.url, {
    site: { type: 'string', required: true },
    dir: { type: 'string', required: true },
    'url-prefix': { type: 'string', default: '' },
    'stale-days': { type: 'string', default: '30' },
    'min-impressions': { type: 'string', default: '100' },
    days: { type: 'string', default: '28' },
    output: { type: 'string' },
  });
  const sc = await gscClient();
  const r = await buildReport(sc, {
    site: a.site, dir: a.dir, urlPrefix: a['url-prefix'], staleDays: Number(a['stale-days']),
    minImpressions: Number(a['min-impressions']), days: Number(a.days),
  });
  console.log(`\nRefresh tracker: ${a.site}, ${r.period.startDate} -> ${r.period.endDate}; stale = ${r.config.staleDays}+ days`);
  console.log(`Refresh candidates: ${r.refreshCandidates.length}   Healthy: ${r.healthyCount}   Unmatched URLs: ${r.unmatched.length}`);
  for (const c of r.refreshCandidates) {
    console.log(`\n  [${c.urgency}] ${c.url}  (${c.file}, match ${c.match})`);
    console.log(`    ${c.impressions.toLocaleString()} impr | ${c.clicks} clicks | pos ${c.position}`);
    console.log(`    Last updated ${c.lastUpdated} via ${c.dateSource} (${c.daysSinceUpdate} days ago)`);
    console.log(`    ${c.reason}`);
  }
  if (r.skippedDynamicRoutes.length) console.log(`\nSkipped ${r.skippedDynamicRoutes.length} dynamic route file(s) that cannot map to one URL.`);
  if (a.output) { writeFileSync(a.output, JSON.stringify(r, null, 2)); console.log(`\nReport saved to ${a.output}`); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(fail);
