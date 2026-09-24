#!/usr/bin/env node

/**
 * Internal Link Orphan Finder
 *
 * Builds the internal link graph between content files and reports pages with zero
 * (orphans) or one inbound internal link, and pages with no outbound internal links.
 *
 * Why it matters: a page nobody links to gets no internal link signals and is hard for
 * readers to reach. Google can still discover and crawl it through your sitemap or external
 * links, so an orphan can still be found and indexed; it is under-supported. Add links from
 * related pages.
 *
 * Links recognised: href="…" / href='…' / href={"…"} (JSX and HTML), Markdown [text](url)
 * and reference definitions [id]: url. Relative links (./other, ../x) resolve against the
 * linking page's URL; absolute URLs count when their host matches --base. Template-literal
 * hrefs with ${...} and links rendered from data are not visible in source.
 *
 * Limits: only files under --dir are scanned. Links in shared navigation, layouts,
 * related-post widgets or a CMS are not seen, so check a flagged page on the live site.
 * Dynamic routes ([slug]) have no fixed URL and are listed separately, not as orphans.
 *
 * Pages are keyed by URL path derived from the file path relative to --dir (App Router aware:
 * blog/foo/page.tsx → /blog/foo; posts/foo.md → /posts/foo), under --url-prefix. A link that
 * matches no path exactly falls back to the last path segment, but only when that segment
 * identifies exactly one page.
 *
 * Usage:
 *   node scripts/orphan-finder.mjs --dir ./src/app --base https://example.com
 *   node scripts/orphan-finder.mjs --dir ./content/posts --url-prefix /posts --output orphan-pages.json
 *
 * Options:
 *   --dir <path>          Directory to scan (required).
 *   --ext <list>          Comma-separated extensions (default: .md,.mdx,.tsx,.jsx,.html).
 *                         Dot-directories, node_modules and binary files are skipped.
 *   --base <url>          Site origin, so absolute links to it count as internal (e.g. https://example.com).
 *   --url-prefix <path>   URL prefix for paths derived from --dir (default: none).
 *   --output <file>       Write the JSON report.
 *
 * Output (JSON): { generated, directory, totalPages, orphanPages, lowLinkPages, deadEndPages,
 *   orphans: [{ file, path, inboundLinks, outboundLinks }], lowLink: [...], deadEnds: [...],
 *   dynamicRoutes: [file] }
 *
 * Exit codes: 0 success (findings are not an error), 1 error.
 */

import { writeFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';
import { walkContentFiles, readTextFile, parseExts, extractLinkTargets, urlPathForFile, normalizePath } from './thin-content-detector.mjs';

/** Resolve a link target to an internal path, or null if external / not a page link. */
export function resolveInternal(url, fromPath, baseHosts = []) {
  const u = url.trim();
  if (!u || u.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(u)) return null;
  let path;
  if (/^https?:\/\//i.test(u) || u.startsWith('//')) {
    let parsed;
    try { parsed = new URL(u.startsWith('//') ? `https:${u}` : u); } catch { return null; }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (!baseHosts.includes(host)) return null;
    path = parsed.pathname;
  } else if (u.startsWith('/')) {
    path = u;
  } else {
    // Relative: resolve against the linking page's URL treated as a directory-less document.
    path = new URL(u, `https://x${fromPath}`).pathname;
  }
  path = normalizePath(path);
  if (/\.(png|jpe?g|gif|webp|svg|pdf|css|js|ico|xml|txt|zip)$/i.test(path)) return null;
  return path.replace(/\.(mdx?|html?)$/i, '');
}

/**
 * Build the link graph. `pages` = [{ file, path, content }] (path null for dynamic routes).
 * Returns per-page inbound/outbound counts (each source counted once per target).
 */
export function buildGraph(pages, { base = '' } = {}) {
  const baseHosts = [];
  if (base) { try { baseHosts.push(new URL(base).hostname.toLowerCase().replace(/^www\./, '')); } catch { /* ignore */ } }
  const byPath = new Map();
  const bySlug = new Map();
  for (const p of pages) {
    if (p.path === null) continue;
    byPath.set(p.path, p);
    const slug = p.path.split('/').filter(Boolean).pop() ?? '';
    bySlug.set(slug, bySlug.has(slug) ? null : p); // null = ambiguous
  }
  const inbound = new Map(pages.map((p) => [p.file, 0]));
  const outbound = new Map(pages.map((p) => [p.file, 0]));
  for (const src of pages) {
    const fromPath = src.path ?? '/';
    const targets = new Set();
    for (const link of extractLinkTargets(src.content)) {
      const path = resolveInternal(link, fromPath, baseHosts);
      if (!path) continue;
      let target = byPath.get(path);
      if (!target) target = bySlug.get(path.split('/').filter(Boolean).pop() ?? '') || null;
      if (target && target.file !== src.file) targets.add(target.file);
    }
    outbound.set(src.file, targets.size);
    for (const t of targets) inbound.set(t, inbound.get(t) + 1);
  }
  return pages.map((p) => ({ file: p.file, path: p.path, inboundLinks: inbound.get(p.file), outboundLinks: outbound.get(p.file) }));
}

export function summarize(nodes) {
  const staticNodes = nodes.filter((n) => n.path !== null);
  const byPath = (a, b) => a.path.localeCompare(b.path);
  return {
    totalPages: staticNodes.length,
    orphans: staticNodes.filter((n) => n.inboundLinks === 0).sort(byPath),
    lowLink: staticNodes.filter((n) => n.inboundLinks === 1).sort(byPath),
    deadEnds: staticNodes.filter((n) => n.outboundLinks === 0).sort(byPath),
    dynamicRoutes: nodes.filter((n) => n.path === null).map((n) => n.file).sort(),
  };
}

async function main() {
  const args = cli(import.meta.url, {
    dir: { type: 'string', required: true },
    ext: { type: 'string' },
    base: { type: 'string', default: '' },
    'url-prefix': { type: 'string', default: '' },
    output: { type: 'string' },
  });
  const pages = [];
  for (const file of walkContentFiles(args.dir, parseExts(args.ext))) {
    const content = readTextFile(file);
    if (content === null) continue;
    pages.push({ file, path: urlPathForFile(file, args.dir, args['url-prefix']), content });
  }
  if (pages.length === 0) throw new Error(`No content files found in ${args.dir}`);
  console.log(`\nScanning ${pages.length} files for internal links\n`);

  const s = summarize(buildGraph(pages, { base: args.base }));
  const pct = (n) => (s.totalPages ? Math.round((n / s.totalPages) * 100) : 0);

  console.log('═'.repeat(60));
  console.log(' INTERNAL LINK AUDIT');
  console.log('═'.repeat(60));
  console.log(`\n  Pages (static URLs):  ${s.totalPages}`);
  console.log(`  Orphans (0 inbound):  ${s.orphans.length} (${pct(s.orphans.length)}%)`);
  console.log(`  Low-link (1 inbound): ${s.lowLink.length}`);
  console.log(`  Dead ends (0 out):    ${s.deadEnds.length}`);
  if (s.dynamicRoutes.length) console.log(`  Dynamic routes:       ${s.dynamicRoutes.length} (not assessed; URLs come from data)`);

  if (s.orphans.length) {
    console.log('\n  ORPHANS (no inbound links from files under --dir):\n');
    for (const n of s.orphans) console.log(`    ${n.path}  (${n.outboundLinks} outbound)  ${n.file}`);
  }
  if (s.lowLink.length && s.lowLink.length <= 30) {
    console.log('\n  LOW-LINK (1 inbound link):\n');
    for (const n of s.lowLink) console.log(`    ${n.path}`);
  }
  if (s.orphans.length) {
    console.log('\n  Next steps: add links to each orphan from 2+ related pages (ideally ones with traffic).');
    console.log('  Check the live page first: navigation or widgets outside --dir may already link to it.');
  }

  if (args.output) {
    const report = {
      generated: new Date().toISOString(),
      directory: args.dir,
      totalPages: s.totalPages,
      orphanPages: s.orphans.length,
      lowLinkPages: s.lowLink.length,
      deadEndPages: s.deadEnds.length,
      orphans: s.orphans,
      lowLink: s.lowLink,
      deadEnds: s.deadEnds,
      dynamicRoutes: s.dynamicRoutes,
    };
    writeFileSync(args.output, JSON.stringify(report, null, 2) + '\n');
    console.log(`\n  Report saved to ${args.output}`);
  }
  console.log('');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) main().catch(fail);
