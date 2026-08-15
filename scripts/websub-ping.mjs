#!/usr/bin/env node

/**
 * WebSub Ping
 *
 * Notifies Google's PubSubHubbub hub that your feeds have changed,
 * triggering an immediate crawl instead of waiting for Google's
 * regular polling schedule.
 *
 * Run this after every publish — whether it's a blog post, a news
 * article, or a sitemap update. It's the difference between Google
 * discovering your content in minutes vs. hours.
 *
 * Usage:
 *   node scripts/websub-ping.mjs --feeds https://example.com/sitemap.xml,https://example.com/feed.xml
 *   node scripts/websub-ping.mjs --feeds https://example.com/news-sitemap.xml
 *
 * Add to your build script:
 *   "postbuild": "node scripts/websub-ping.mjs --feeds https://example.com/sitemap.xml"
 */

import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    feeds: { type: 'string' },
  },
});

if (!args.feeds) {
  console.error('Usage: node scripts/websub-ping.mjs --feeds URL1,URL2');
  console.error('Example: node scripts/websub-ping.mjs --feeds https://example.com/sitemap.xml,https://example.com/feed.xml');
  process.exit(1);
}

const HUB_URL = 'https://pubsubhubbub.appspot.com/';
const feeds = args.feeds.split(',').map(f => f.trim());

console.log(`Pinging Google WebSub hub for ${feeds.length} feed(s)...\n`);

for (const feedUrl of feeds) {
  try {
    const res = await fetch(HUB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `hub.mode=publish&hub.url=${encodeURIComponent(feedUrl)}`,
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 204 || res.ok) {
      console.log(`  OK  ${feedUrl}`);
    } else {
      console.log(`  FAIL ${feedUrl} — HTTP ${res.status}`);
    }
  } catch (err) {
    console.log(`  ERR  ${feedUrl} — ${err.message}`);
  }
}

console.log('\nDone. Google will re-crawl these feeds shortly.');
console.log('Tip: add this to your postbuild script for automatic pings on every deploy.');
