#!/usr/bin/env node

/**
 * Content Audit
 *
 * Joins Search Console page data with on-page content analysis and sorts every content
 * file into an action bucket. Buckets are heuristics for a human to review, not actions
 * to apply automatically:
 *   KILL     candidate for removal / redirect / noindex. Only when ALL guards hold: thin,
 *            at least --min-age-days old, URL mapped, zero clicks and < --max-impressions
 *            impressions in the window, and the GSC join looks healthy (see joinStats).
 *   REVIEW   thin but too new or traffic unknown; heavy template phrasing with no clicks;
 *            or 100-500 impressions at < 0.5% CTR (check for cannibalization).
 *   UPDATE   1,000+ impressions, CTR < 2%, average position 4-20: title/snippet rewrite candidate.
 *   PROMOTE  10+ clicks and CTR >= 1%: worth more internal links.
 *   KEEP     everything else.
 *
 * Files are mapped to URL paths relative to --dir (App Router aware: blog/foo/page.tsx →
 * /blog/foo, (groups) dropped), optionally under --url-prefix, and joined to GSC rows by
 * FULL path. Dynamic routes ([slug]) cannot be mapped and get gscStatus "unmapped".
 * A mapped page with no GSC rows gets gscStatus "no-rows" (0 clicks / 0 impressions,
 * position null), never position 0.
 *
 * Usage:
 *   node scripts/content-audit.mjs --site sc-domain:example.com --dir ./src/app
 *   node scripts/content-audit.mjs --site sc-domain:example.com --dir ./content/posts --url-prefix /posts
 *   node scripts/content-audit.mjs --site https://example.com/ --dir ./content --rows gsc-pages.json
 *
 * Options:
 *   --site <property>        Search Console property, e.g. sc-domain:example.com (required).
 *   --dir <path>             Content directory (required).
 *   --ext <list>             Comma-separated extensions (default: .md,.mdx,.tsx,.jsx,.html).
 *                            Dot-directories, node_modules and binary files are skipped.
 *   --url-prefix <path>      Prefix for URL paths derived from --dir (default: none).
 *   --base-url <url>         Site origin, used to keep only GSC rows for this host and to tell
 *                            internal from external absolute links. Default: derived from --site.
 *   --days <n>               GSC window length in days, ending 3 days ago (default: 28).
 *   --min-words <n>          Thin threshold in visible words (default: 300).
 *   --min-age-days <n>       Minimum page age for KILL (default: 90). Age from a content date,
 *                            else file mtime.
 *   --max-impressions <n>    "Near-zero traffic" ceiling for KILL (default: 50).
 *   --config <file>          Template phrase config (default: config/anti-ai-rules.json).
 *   --rows <file>            Read GSC rows ([{ keys: [pageUrl], clicks, impressions, ctr, position }])
 *                            from a JSON file instead of calling the API (offline / testing).
 *   --output <file>          JSON report (default: content-audit.json).
 *
 * Output (JSON): { generated, site, window, joinStats, buckets, pages: [{ path, file, bucket, reasons,
 *   gscStatus, gsc, ageDays, ageSource, content }] }
 *
 * Exit codes: 0 success, 1 error.
 */

import { writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';
import { gscClient, queryAll, isoDay, daysAgo } from '../lib/gsc.mjs';
import { walkContentFiles, readTextFile, parseExts, extractVisibleText, countWords, pageAge, extractLinkTargets, urlPathForFile, normalizePath } from './thin-content-detector.mjs';
import { loadPhrases, compilePhrases, findPhrases, DEFAULT_CONFIG } from './template-detector.mjs';

/** Derive the site host from --base-url or the GSC property. Returns { host, domainProperty }. */
export function siteHost(site, baseUrl) {
  if (baseUrl) return { host: new URL(baseUrl).hostname.toLowerCase(), domainProperty: false };
  if (site.startsWith('sc-domain:')) return { host: site.slice(10).toLowerCase(), domainProperty: true };
  return { host: new URL(site).hostname.toLowerCase(), domainProperty: false };
}

const bare = (h) => h.replace(/^www\./, '');

/** Is `host` part of this site? www. is ignored; a domain property also covers subdomains. */
export function isInternalHost(host, site) {
  const h = bare(host.toLowerCase());
  const s = bare(site.host);
  return h === s || (site.domainProperty && h.endsWith(`.${s}`));
}

/** Count absolute links to other hosts. */
export function countExternalLinks(content, site) {
  let n = 0;
  for (const url of extractLinkTargets(content)) {
    if (!/^https?:\/\//i.test(url)) continue;
    try { if (!isInternalHost(new URL(url).hostname, site)) n++; } catch { /* malformed */ }
  }
  return n;
}

/**
 * Index GSC page rows by normalised path, keeping rows for this site's host only
 * (exact host, ignoring www.). Duplicate paths (http/https, trailing slash) are merged.
 */
export function indexGscRows(rows, site) {
  const map = new Map();
  for (const row of rows) {
    let u;
    try { u = new URL(row.keys[0]); } catch { continue; }
    if (bare(u.hostname.toLowerCase()) !== bare(site.host)) continue;
    const path = normalizePath(u.pathname);
    const prev = map.get(path);
    if (!prev) { map.set(path, { clicks: row.clicks, impressions: row.impressions, position: row.position }); continue; }
    const imp = prev.impressions + row.impressions;
    prev.position = imp ? (prev.position * prev.impressions + row.position * row.impressions) / imp : prev.position;
    prev.clicks += row.clicks;
    prev.impressions = imp;
  }
  for (const v of map.values()) v.ctr = v.impressions ? v.clicks / v.impressions : 0;
  return map;
}

/** On-page analysis. */
export function analyzeContent(content, ext, { site, compiledPhrases, minWords = 300 }) {
  const text = extractVisibleText(content, ext);
  const wordCount = countWords(text);
  return {
    wordCount,
    isThin: wordCount < minWords,
    templateCount: findPhrases(text, compiledPhrases).length,
    externalLinks: countExternalLinks(content, site),
    hasSchema: /application\/ld\+json|["']@context["']|jsonLd/i.test(content),
    imageCount: (content.match(/<img\b|<Image\b|!\[[^\]]*\]\(/g) || []).length,
  };
}

/**
 * Pick a bucket. `gsc` is null unless gscStatus is "matched" or "no-rows".
 * guards: { oldEnough, joinHealthy, maxImpressions }
 */
export function classify(gscStatus, gsc, analysis, { oldEnough, joinHealthy, maxImpressions = 50 }) {
  const trafficKnown = gscStatus !== 'unmapped' && joinHealthy;
  const zeroTraffic = trafficKnown && gsc.clicks === 0 && gsc.impressions < maxImpressions;

  if (analysis.isThin && (zeroTraffic || !trafficKnown)) return zeroTraffic && oldEnough ? 'KILL' : 'REVIEW';
  if (analysis.templateCount >= 3 && (!trafficKnown || gsc.clicks === 0)) return 'REVIEW';
  if (gscStatus !== 'matched') return 'KEEP';
  if (gsc.impressions > 100 && gsc.impressions < 500 && gsc.ctr < 0.005) return 'REVIEW';
  if (gsc.impressions >= 1000 && gsc.ctr < 0.02 && gsc.position >= 4 && gsc.position <= 20) return 'UPDATE';
  if (gsc.clicks >= 10 && gsc.ctr >= 0.01) return 'PROMOTE';
  return 'KEEP';
}

export function reasonsFor(gscStatus, gsc, analysis, bucket, { age, minAgeDays, joinHealthy }) {
  const r = [];
  if (analysis.isThin) r.push(`Thin content: ${analysis.wordCount} visible words`);
  if (bucket === 'KILL') r.push(`Guards passed: ${age.ageDays} days old (min ${minAgeDays}), ${gsc.clicks} clicks / ${gsc.impressions} impressions. Review before removing; prefer improving or merging`);
  if (bucket === 'REVIEW' && analysis.isThin) {
    if (gscStatus === 'unmapped') r.push('Dynamic route: URL unknown, so traffic unknown');
    else if (!joinHealthy) r.push('GSC join looks unhealthy (few files matched); traffic not trusted');
    else if (age.ageDays < minAgeDays) r.push(`Only ${age.ageDays} days old (min ${minAgeDays}); too new to judge`);
  }
  if (analysis.templateCount >= 2) r.push(`${analysis.templateCount} configured template phrases`);
  if (analysis.externalLinks === 0) r.push('No external links');
  if (!analysis.hasSchema) r.push('No structured data found in source');
  if (gscStatus === 'no-rows') r.push('No GSC rows in window (0 impressions)');
  if (gscStatus === 'matched' && gsc.clicks === 0 && gsc.impressions > 0) r.push(`${gsc.impressions} impressions, 0 clicks`);
  if (bucket === 'REVIEW' && gscStatus === 'matched' && gsc.impressions > 100 && gsc.impressions < 500 && gsc.ctr < 0.005) r.push('Low CTR at 100-500 impressions: check for cannibalization (cannibalization-detector.mjs)');
  if (bucket === 'UPDATE') r.push(`Title/snippet rewrite candidate: pos ${gsc.position.toFixed(1)}, ${(gsc.ctr * 100).toFixed(2)}% CTR`);
  if (bucket === 'PROMOTE') r.push(`${gsc.clicks} clicks: consider more internal links to it`);
  return r;
}

/** Run the audit over already-loaded files. Pure apart from pageAge's mtime fallback. */
export function audit({ files, dir, rows, site, urlPrefix = '', compiledPhrases, minWords = 300, minAgeDays = 90, maxImpressions = 50, now = new Date() }) {
  const gscIndex = indexGscRows(rows, site);
  const pages = [];
  for (const { file, content } of files) {
    const path = urlPathForFile(file, dir, urlPrefix);
    const analysis = analyzeContent(content, extname(file), { site, compiledPhrases, minWords });
    const age = pageAge(file, content, now);
    let gscStatus = 'unmapped';
    let gsc = null;
    if (path !== null) {
      gsc = gscIndex.get(path) || null;
      gscStatus = gsc ? 'matched' : 'no-rows';
      if (!gsc) gsc = { clicks: 0, impressions: 0, ctr: null, position: null };
    }
    pages.push({ path, file, gscStatus, gsc, analysis, age });
  }
  const mapped = pages.filter((p) => p.path !== null).length;
  const matched = pages.filter((p) => p.gscStatus === 'matched').length;
  // If almost nothing matched, the path mapping (or --url-prefix / --base-url) is probably wrong:
  // treating every page as zero-traffic would mass-label KILL. Refuse to trust the join.
  const joinHealthy = rows.length > 0 && mapped > 0 && matched / mapped >= 0.2;

  const buckets = { KILL: 0, REVIEW: 0, UPDATE: 0, PROMOTE: 0, KEEP: 0 };
  const out = pages.map((p) => {
    const bucket = classify(p.gscStatus, p.gsc, p.analysis, { oldEnough: p.age.ageDays >= minAgeDays, joinHealthy, maxImpressions });
    buckets[bucket]++;
    return {
      path: p.path,
      file: p.file,
      bucket,
      reasons: reasonsFor(p.gscStatus, p.gsc, p.analysis, bucket, { age: p.age, minAgeDays, joinHealthy }),
      gscStatus: p.gscStatus,
      gsc: p.gsc && {
        clicks: p.gsc.clicks,
        impressions: p.gsc.impressions,
        ctrPct: p.gsc.ctr === null ? null : Math.round(p.gsc.ctr * 10000) / 100,
        position: p.gsc.position === null ? null : Math.round(p.gsc.position * 10) / 10,
      },
      ageDays: p.age.ageDays,
      ageSource: p.age.ageSource,
      content: p.analysis,
    };
  });
  const order = { KILL: 0, REVIEW: 1, UPDATE: 2, PROMOTE: 3, KEEP: 4 };
  out.sort((a, b) => order[a.bucket] - order[b.bucket] || (b.gsc?.impressions ?? -1) - (a.gsc?.impressions ?? -1) || a.file.localeCompare(b.file));
  return { joinStats: { files: pages.length, mapped, matched, gscRows: rows.length, healthy: joinHealthy }, buckets, pages: out };
}

async function main() {
  const args = cli(import.meta.url, {
    site: { type: 'string', required: true },
    dir: { type: 'string', required: true },
    ext: { type: 'string' },
    'url-prefix': { type: 'string', default: '' },
    'base-url': { type: 'string' },
    days: { type: 'string', default: '28' },
    'min-words': { type: 'string', default: '300' },
    'min-age-days': { type: 'string', default: '90' },
    'max-impressions': { type: 'string', default: '50' },
    config: { type: 'string', default: DEFAULT_CONFIG },
    rows: { type: 'string' },
    output: { type: 'string', default: 'content-audit.json' },
  });
  const num = (k) => { const v = Number(args[k]); if (!Number.isFinite(v)) throw new Error(`--${k} must be a number`); return v; };
  const days = num('days');
  const site = siteHost(args.site, args['base-url']);
  const compiledPhrases = compilePhrases(loadPhrases(args.config));

  const endDate = isoDay(daysAgo(3));
  const startDate = isoDay(daysAgo(3 + days - 1));
  let rows;
  if (args.rows) {
    rows = JSON.parse(readFileSync(args.rows, 'utf8'));
    console.log(`\nUsing ${rows.length} GSC rows from ${args.rows}`);
  } else {
    console.log(`\nFetching GSC page data for ${args.site} (${startDate} to ${endDate})...`);
    rows = await queryAll(await gscClient(), args.site, { startDate, endDate, dimensions: ['page'] });
  }

  const files = [];
  for (const file of walkContentFiles(args.dir, parseExts(args.ext))) {
    const content = readTextFile(file);
    if (content !== null) files.push({ file, content });
  }
  console.log(`Scanning ${files.length} content files...\n`);

  const r = audit({ files, dir: args.dir, rows, site, urlPrefix: args['url-prefix'], compiledPhrases, minWords: num('min-words'), minAgeDays: num('min-age-days'), maxImpressions: num('max-impressions') });
  const report = { generated: new Date().toISOString(), site: args.site, window: args.rows ? { source: 'rows-file' } : { startDate, endDate }, ...r };
  writeFileSync(args.output, JSON.stringify(report, null, 2) + '\n');

  console.log('═'.repeat(60));
  console.log(' CONTENT AUDIT RESULTS');
  console.log('═'.repeat(60));
  console.log(`\n  Files: ${r.joinStats.files}   mapped to URLs: ${r.joinStats.mapped}   matched GSC rows: ${r.joinStats.matched}`);
  if (!r.joinStats.healthy) {
    console.log('  WARNING: under 20% of mapped files matched a GSC row. Check --dir, --url-prefix and --base-url.');
    console.log('           Traffic is treated as unknown, so nothing is labelled KILL.');
  }
  for (const b of Object.keys(r.buckets)) console.log(`  ${b.padEnd(8)} ${r.buckets[b]}`);
  for (const bucket of ['KILL', 'REVIEW', 'UPDATE', 'PROMOTE']) {
    const items = r.pages.filter((p) => p.bucket === bucket);
    if (!items.length) continue;
    console.log(`\n  ${bucket} (${items.length}):`);
    for (const item of items.slice(0, 10)) {
      console.log(`    ${item.path ?? item.file}`);
      for (const reason of item.reasons) console.log(`      → ${reason}`);
    }
    if (items.length > 10) console.log(`    ... and ${items.length - 10} more`);
  }
  console.log(`\n  Full audit: ${args.output}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) main().catch(fail);
