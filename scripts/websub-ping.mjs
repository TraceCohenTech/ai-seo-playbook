#!/usr/bin/env node

/**
 * WebSub Ping
 *
 * Sends a WebSub (formerly PubSubHubbub) "publish" notification for RSS or
 * Atom feeds that declare a hub, so subscribers of that hub (including
 * Google's feed fetchers, if they subscribe) learn that the feed changed.
 *
 * Scope and limits, stated plainly:
 *   - WebSub applies only to RSS/Atom feeds that declare `<link rel="hub">`
 *     (or an HTTP `Link: <…>; rel="hub"` header). The script fetches each feed,
 *     verifies it is RSS/Atom, reads the declared hub(s) and pings only those.
 *     Feeds without a hub declaration, and sitemaps, are refused.
 *   - It is not a sitemap ping. Google retired its sitemap ping endpoint in
 *     June 2023. Sitemaps are discovered through the `Sitemap:` line in
 *     robots.txt and through submission in Search Console; keep each <lastmod>
 *     accurate (the date the page content really changed).
 *   - A successful ping means the hub accepted the notification. It does not
 *     mean or guarantee that any search engine will crawl or index the feed's
 *     pages, or when.
 *
 * Usage:
 *   node scripts/websub-ping.mjs --feeds https://example.com/feed.xml
 *   node scripts/websub-ping.mjs --feeds https://example.com/feed.xml,https://example.com/atom.xml --dry-run
 *
 * Options:
 *   --feeds URL[,URL]   Comma-separated feed URLs (required).
 *   --dry-run           Verify feeds and hub declarations without pinging.
 *   --timeout MS        Per-request timeout in milliseconds (default 10000).
 *   --output FILE       Write a JSON report to FILE.
 *   --help              Show this help.
 *
 * The topic URL sent to the hub is the feed's declared `rel="self"` URL when
 * present (that is the URL subscribers know), otherwise the feed URL.
 *
 * Exit codes:
 *   0  every feed was verified and every declared hub accepted the ping (2xx)
 *   2  a feed was refused (not RSS/Atom, a sitemap, or no hub declared)
 *   1  error: bad usage, a feed could not be fetched, or a hub rejected the ping
 */

import { writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag);
  return m ? m[2].replace(/&amp;/g, '&') : null;
}

/** Inspect a feed body (+ optional Link header). Returns { kind, hubs, self }. */
export function inspectFeed(xml, linkHeader = '', feedUrl = undefined) {
  const head = xml.slice(0, 5000);
  let kind = 'unknown';
  if (/<(?:\w+:)?(urlset|sitemapindex)[\s>]/i.test(head)) kind = 'sitemap';
  else if (/<rss[\s>]/i.test(head) || /<rdf:RDF[\s>]/i.test(head)) kind = 'rss';
  else if (/<feed[\s>][^>]*http:\/\/www\.w3\.org\/2005\/Atom/i.test(head) || /<feed[\s>]/i.test(head)) kind = 'atom';

  const hubs = [];
  let self = null;
  for (const tag of xml.match(/<(?:atom:)?link\b[^>]*>/gi) || []) {
    const rel = (attr(tag, 'rel') || '').toLowerCase().split(/\s+/);
    const href = attr(tag, 'href');
    if (!href) continue;
    const abs = feedUrl ? new URL(href, feedUrl).href : href;
    if (rel.includes('hub')) hubs.push(abs);
    if (rel.includes('self') && !self) self = abs;
  }
  for (const part of (linkHeader || '').split(/,(?=\s*<)/)) {
    const m = /<([^>]+)>\s*;(.*)/.exec(part.trim());
    if (!m) continue;
    const rel = /rel\s*=\s*"?([^";]+)"?/i.exec(m[2])?.[1]?.toLowerCase().split(/\s+/) || [];
    const abs = feedUrl ? new URL(m[1], feedUrl).href : m[1];
    if (rel.includes('hub')) hubs.push(abs);
    if (rel.includes('self') && !self) self = abs;
  }
  return { kind, hubs: [...new Set(hubs)], self };
}

export async function processFeed(feedUrl, { dryRun = false, timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const out = { feed: feedUrl, status: null, kind: null, hubs: [], topic: null, pings: [] };
  let res;
  try {
    res = await fetchImpl(feedUrl, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'ai-seo-playbook-websub-ping/1.0' } });
  } catch (e) {
    return { ...out, status: 'error', reason: `could not fetch feed: ${e.cause?.code || e.message}` };
  }
  if (!res.ok) return { ...out, status: 'error', reason: `feed returned HTTP ${res.status}` };
  const info = inspectFeed(await res.text(), res.headers.get('link') || '', feedUrl);
  Object.assign(out, { kind: info.kind, hubs: info.hubs, topic: info.self || feedUrl });
  if (info.kind === 'sitemap') return { ...out, status: 'refused', reason: 'this is a sitemap, not a feed. WebSub does not apply to sitemaps; use robots.txt + Search Console submission with accurate <lastmod>.' };
  if (info.kind === 'unknown') return { ...out, status: 'refused', reason: 'not an RSS or Atom feed' };
  if (!info.hubs.length) return { ...out, status: 'refused', reason: 'feed does not declare <link rel="hub">; add one (and publish to that hub) before pinging' };
  if (dryRun) return { ...out, status: 'verified' };

  for (const hub of info.hubs) {
    try {
      const r = await fetchImpl(hub, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ 'hub.mode': 'publish', 'hub.url': out.topic }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      await r.body?.cancel();
      out.pings.push({ hub, httpStatus: r.status, ok: r.ok });
    } catch (e) {
      out.pings.push({ hub, httpStatus: 0, ok: false, error: e.cause?.code || e.message });
    }
  }
  out.status = out.pings.every((p) => p.ok) ? 'pinged' : 'error';
  if (out.status === 'error') out.reason = 'a hub rejected the ping or could not be reached';
  return out;
}

async function main() {
  const args = cli(import.meta.url, {
    feeds: { type: 'string', required: true },
    'dry-run': { type: 'boolean', default: false },
    timeout: { type: 'string', default: '10000' },
    output: { type: 'string' },
  });
  const timeoutMs = Math.max(1000, parseInt(args.timeout, 10) || 10000);
  const feeds = args.feeds.split(',').map((f) => f.trim()).filter(Boolean);

  console.log(`WebSub ${args['dry-run'] ? 'check (dry run)' : 'ping'} for ${feeds.length} feed(s)\n`);
  const results = [];
  for (const feed of feeds) {
    const r = await processFeed(feed, { dryRun: args['dry-run'], timeoutMs });
    results.push(r);
    const label = { pinged: 'OK     ', verified: 'VALID  ', refused: 'REFUSED', error: 'FAIL   ' }[r.status];
    console.log(`  ${label} ${feed}${r.kind ? ` [${r.kind}]` : ''}`);
    for (const p of r.pings) console.log(`          hub ${p.hub} -> ${p.httpStatus || p.error}`);
    if (r.status === 'verified') console.log(`          hub(s): ${r.hubs.join(', ')}; topic ${r.topic}`);
    if (r.reason) console.log(`          ${r.reason}`);
  }

  const n = (s) => results.filter((r) => r.status === s).length;
  console.log(`\nPinged: ${n('pinged')}  Verified: ${n('verified')}  Refused: ${n('refused')}  Failed: ${n('error')}`);
  console.log('A 2xx from a hub means the notification was accepted; it does not guarantee crawling or indexing.');

  if (args.output) {
    await writeFile(args.output, JSON.stringify({ generated: new Date().toISOString(), dryRun: args['dry-run'], results }, null, 2) + '\n');
    console.log(`Report saved to ${args.output}`);
  }
  if (n('error')) process.exit(1);
  process.exit(n('refused') ? 2 : 0);
}

function isMain() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isMain()) main().catch(fail);
