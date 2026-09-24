#!/usr/bin/env node

/**
 * Redirect Checker
 *
 * Fetches every URL in your sitemap (or every route derived from a content
 * directory) without following redirects, and reports URLs that do not
 * return 200: redirects (301/302/303/307/308), 404/410, other HTTP errors,
 * and network failures. A sitemap should list only canonical URLs that
 * return 200, so each redirect or 404 listed here is a sitemap entry to
 * REVIEW (point it at the final URL, or drop it).
 *
 * Sitemap mode follows <sitemapindex> files recursively, decodes XML
 * entities such as &amp; in <loc>, and reads gzipped sitemaps.
 *
 * Directory mode maps files to routes:
 *   - Next.js App Router: `app/blog/foo/page.tsx` -> `/blog/foo`. Route groups
 *     `(group)` are dropped; `_private` folders, `@slot` parallel routes and
 *     dynamic segments like `[slug]` are skipped (they have no fixed URL).
 *     A tree is treated as App Router when it contains any `page.*` file,
 *     and then only `page.*` files are routes.
 *   - Content folders and the Pages Router: `blog/foo.md` -> `/blog/foo`,
 *     `blog/index.mdx` -> `/blog`. Files starting with `_` and `api/` are skipped.
 *
 * Usage:
 *   node scripts/redirect-checker.mjs --sitemap https://example.com/sitemap.xml
 *   node scripts/redirect-checker.mjs --dir ./src/app --base-url https://example.com
 *   node scripts/redirect-checker.mjs --sitemap https://example.com/sitemap.xml --output redirects.json
 *
 * Options:
 *   --sitemap URL       Sitemap or sitemap index to check.
 *   --dir PATH          Content or app directory to derive routes from (needs --base-url).
 *   --base-url URL      Site origin used with --dir, e.g. https://example.com.
 *   --concurrency N     Parallel requests (default 5).
 *   --timeout MS        Per-request timeout in milliseconds (default 15000).
 *   --output FILE       Write the JSON report to FILE.
 *   --help              Show this help.
 *
 * Output: a console summary, plus with --output a JSON report with
 * `redirects` (url, status, location, finalUrl, finalStatus, hops),
 * `notFound`, `httpErrors`, `fetchErrors` and `skippedRoutes`.
 *
 * Exit codes:
 *   0  every URL returned 200
 *   2  findings: at least one redirect, 404/410 or other non-200 status
 *   1  error: bad usage, the sitemap could not be read, or a URL could not be fetched
 */

import { readdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';

// ---------- sitemap parsing ----------

export function decodeXmlEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Parse sitemap XML into { isIndex, locs }. */
export function parseSitemap(xml) {
  const isIndex = /<(?:\w+:)?sitemapindex[\s>]/i.test(xml);
  const locs = [];
  const re = /<(?:\w+:)?loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/(?:\w+:)?loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) locs.push(decodeXmlEntities(m[1].trim()));
  return { isIndex, locs };
}

async function fetchText(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'ai-seo-playbook-redirect-checker/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8');
}

/** Collect page URLs from a sitemap, following sitemap indexes. Throws on any fetch failure. */
export async function collectSitemapUrls(sitemapUrl, { timeoutMs = 15000, maxDepth = 3 } = {}) {
  const seen = new Set();
  const urls = [];
  async function visit(url, depth) {
    if (seen.has(url)) return;
    seen.add(url);
    const { isIndex, locs } = parseSitemap(await fetchText(url, timeoutMs));
    if (isIndex) {
      if (depth >= maxDepth) throw new Error(`Sitemap index nesting deeper than ${maxDepth} at ${url}`);
      for (const loc of locs) await visit(loc, depth + 1);
    } else {
      urls.push(...locs);
    }
  }
  await visit(sitemapUrl, 0);
  return [...new Set(urls)];
}

// ---------- directory -> routes ----------

const CONTENT_EXT = new Set(['.md', '.mdx', '.tsx', '.jsx', '.js', '.html']);
const PAGE_RE = /^page\.(tsx|jsx|js|mdx|md)$/;

async function listFiles(dir) {
  const out = [];
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (CONTENT_EXT.has(extname(e.name))) out.push(full);
    }
  }
  await walk(dir);
  return out.sort();
}

/**
 * Map one file (relative to the scanned dir, posix separators) to a route.
 * Returns { route } or { skip: reason }.
 */
export function fileToRoute(relPath, { appRouter }) {
  const parts = relPath.split('/');
  const file = parts.pop();
  if (appRouter) {
    if (!PAGE_RE.test(file)) return { skip: 'not a page file' };
    const segs = [];
    for (const p of parts) {
      if (/^\(.*\)$/.test(p)) continue; // route group
      if (p.startsWith('_')) return { skip: 'private folder' };
      if (p.startsWith('@')) return { skip: 'parallel route slot' };
      if (/^\[.*\]$/.test(p)) return { skip: `dynamic segment ${p}` };
      segs.push(p);
    }
    return { route: '/' + segs.join('/') };
  }
  const base = file.replace(/\.[^.]+$/, '');
  if (base.startsWith('_') || parts[0] === 'api') return { skip: 'not a public route' };
  if (parts.some((p) => /^\[.*\]$/.test(p)) || /^\[.*\]$/.test(base)) return { skip: 'dynamic segment' };
  const segs = base === 'index' ? parts : [...parts, base];
  return { route: '/' + segs.join('/') };
}

export async function routesFromDir(dir) {
  const files = await listFiles(dir);
  const rels = files.map((f) => relative(dir, f).split(sep).join('/'));
  const appRouter = rels.some((r) => PAGE_RE.test(r.split('/').pop()));
  const routes = [];
  const skipped = [];
  for (const rel of rels) {
    const r = fileToRoute(rel, { appRouter });
    if (r.route) routes.push({ file: rel, route: r.route });
    else if (appRouter ? PAGE_RE.test(rel.split('/').pop()) : true) skipped.push({ file: rel, reason: r.skip });
  }
  return { appRouter, routes, skipped };
}

export function joinBase(baseUrl, route) {
  return baseUrl.replace(/\/+$/, '') + (route === '/' ? '/' : route);
}

// ---------- status checks ----------

/** Fetch without following redirects; follow up to maxHops manually to report the chain. */
export async function checkUrlStatus(url, { timeoutMs = 15000, maxHops = 5 } = {}) {
  const get = (u) => fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'ai-seo-playbook-redirect-checker/1.0' } });
  let res;
  try {
    res = await get(url);
    await res.body?.cancel();
  } catch (err) {
    return { url, status: 0, error: err.name === 'TimeoutError' ? 'TIMEOUT' : (err.cause?.code || err.message) };
  }
  const result = { url, status: res.status };
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    result.location = loc ? new URL(loc, url).href : null;
    let cur = result.location;
    let hops = 1;
    let finalStatus = null;
    while (cur && hops <= maxHops) {
      try {
        const r = await get(cur);
        await r.body?.cancel();
        finalStatus = r.status;
        if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
          cur = new URL(r.headers.get('location'), cur).href;
          hops++;
          continue;
        }
      } catch (err) {
        finalStatus = 0;
      }
      break;
    }
    Object.assign(result, { finalUrl: cur, finalStatus, hops });
  }
  return result;
}

export async function mapLimit(items, limit, fn, onProgress) {
  const out = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
      onProgress?.(++done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function classify(results) {
  return {
    ok: results.filter((r) => r.status === 200),
    redirects: results.filter((r) => r.status >= 300 && r.status < 400),
    notFound: results.filter((r) => r.status === 404 || r.status === 410),
    httpErrors: results.filter((r) => r.status !== 200 && r.status !== 0 && !(r.status >= 300 && r.status < 400) && r.status !== 404 && r.status !== 410),
    fetchErrors: results.filter((r) => r.status === 0),
  };
}

async function main() {
  const args = cli(import.meta.url, {
    sitemap: { type: 'string' },
    dir: { type: 'string' },
    'base-url': { type: 'string' },
    concurrency: { type: 'string', default: '5' },
    timeout: { type: 'string', default: '15000' },
    output: { type: 'string' },
  });
  const concurrency = Math.max(1, parseInt(args.concurrency, 10) || 5);
  const timeoutMs = Math.max(1000, parseInt(args.timeout, 10) || 15000);

  let urls = [];
  let skippedRoutes = [];
  if (args.sitemap) {
    console.log(`Reading sitemap: ${args.sitemap}`);
    urls = await collectSitemapUrls(args.sitemap, { timeoutMs });
  } else if (args.dir) {
    if (!args['base-url']) {
      console.error('Error: --base-url is required with --dir (e.g. --base-url https://example.com).');
      process.exit(1);
    }
    console.log(`Scanning directory: ${args.dir}`);
    const { appRouter, routes, skipped } = await routesFromDir(args.dir);
    console.log(`  Layout: ${appRouter ? 'Next.js App Router (page.* files)' : 'content files / Pages Router'}`);
    urls = [...new Set(routes.map((r) => joinBase(args['base-url'], r.route)))];
    skippedRoutes = skipped;
  } else {
    console.error('Error: provide --sitemap URL or --dir PATH. Run with --help for usage.');
    process.exit(1);
  }

  console.log(`Found ${urls.length} URLs to check\n`);
  const results = await mapLimit(urls, concurrency, (u) => checkUrlStatus(u, { timeoutMs }),
    (d, n) => process.stderr.write(`\rChecked ${d}/${n} URLs`));
  if (urls.length) process.stderr.write('\n');

  const c = classify(results);
  console.log('=== REDIRECT CHECKER RESULTS ===\n');
  console.log(`Total URLs checked: ${results.length}`);
  console.log(`  200 OK:          ${c.ok.length}`);
  console.log(`  Redirects:       ${c.redirects.length}`);
  console.log(`  404/410:         ${c.notFound.length}`);
  console.log(`  Other non-200:   ${c.httpErrors.length}`);
  console.log(`  Fetch errors:    ${c.fetchErrors.length}`);
  if (skippedRoutes.length) console.log(`  Skipped routes:  ${skippedRoutes.length} (dynamic, private or slot routes; see report)`);

  if (c.redirects.length) {
    console.log('\n--- REDIRECTS (REVIEW: list the final URL in the sitemap, or fix the redirect) ---\n');
    for (const r of c.redirects) {
      console.log(`  ${r.status} ${r.url}`);
      console.log(`    -> ${r.location ?? '(no Location header)'}${r.finalStatus != null ? `  [final ${r.finalStatus} after ${r.hops} hop(s)]` : ''}`);
    }
  }
  if (c.notFound.length) {
    console.log('\n--- 404/410 (REVIEW: remove from the sitemap or restore the page) ---\n');
    for (const r of c.notFound) console.log(`  ${r.status} ${r.url}`);
  }
  if (c.httpErrors.length) {
    console.log('\n--- OTHER NON-200 ---\n');
    for (const r of c.httpErrors) console.log(`  ${r.status} ${r.url}`);
  }
  if (c.fetchErrors.length) {
    console.log('\n--- FETCH ERRORS (not checked) ---\n');
    for (const r of c.fetchErrors) console.log(`  ${r.url}  ${r.error}`);
  }

  if (args.output) {
    const report = {
      generated: new Date().toISOString(),
      source: args.sitemap ? { sitemap: args.sitemap } : { dir: args.dir, baseUrl: args['base-url'] },
      totalChecked: results.length,
      ok: c.ok.length,
      redirects: c.redirects.map((r) => ({ url: r.url, status: r.status, location: r.location, finalUrl: r.finalUrl, finalStatus: r.finalStatus, hops: r.hops })),
      notFound: c.notFound.map((r) => ({ url: r.url, status: r.status })),
      httpErrors: c.httpErrors.map((r) => ({ url: r.url, status: r.status })),
      fetchErrors: c.fetchErrors.map((r) => ({ url: r.url, error: r.error })),
      skippedRoutes,
    };
    await writeFile(args.output, JSON.stringify(report, null, 2) + '\n');
    console.log(`\nReport saved to ${args.output}`);
  }

  if (c.fetchErrors.length) process.exit(1);
  process.exit(c.redirects.length || c.notFound.length || c.httpErrors.length ? 2 : 0);
}

function isMain() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isMain()) main().catch(fail);
