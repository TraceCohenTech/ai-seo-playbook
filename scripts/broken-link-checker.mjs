#!/usr/bin/env node

/**
 * Broken Link Checker
 *
 * Scans your content files for all outbound links (internal and external)
 * and checks each one for 404s, timeouts, and redirect chains. Broken
 * links hurt SEO (wasted link equity) and user trust.
 *
 * Run weekly. Fix internal 404s immediately; external broken links should
 * be replaced or removed.
 *
 * Usage:
 *   node scripts/broken-link-checker.mjs --dir ./content
 *   node scripts/broken-link-checker.mjs --dir ./content --external-only
 *   node scripts/broken-link-checker.mjs --dir ./content --internal-only --base-url https://example.com
 */

import { parseArgs } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string' },
    'base-url': { type: 'string' },
    'external-only': { type: 'boolean', default: false },
    'internal-only': { type: 'boolean', default: false },
    'concurrency': { type: 'string', default: '10' },
    output: { type: 'string' },
  },
});

if (!args.dir) {
  console.error('Usage: node scripts/broken-link-checker.mjs --dir ./content');
  process.exit(1);
}

const CONCURRENCY = parseInt(args.concurrency);
const TIMEOUT_MS = 15000;

async function extractLinks(dir) {
  const links = new Map();

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        await walk(fullPath);
      } else if (['.mdx', '.md', '.tsx', '.jsx', '.html'].includes(extname(entry.name))) {
        const content = await readFile(fullPath, 'utf-8');
        const hrefRegex = /href=["']([^"'#]+?)["']/g;
        const mdLinkRegex = /\[.*?\]\(([^)#]+?)\)/g;

        for (const regex of [hrefRegex, mdLinkRegex]) {
          let match;
          while ((match = regex.exec(content)) !== null) {
            const url = match[1].trim();
            if (url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('javascript:')) continue;
            if (!links.has(url)) {
              links.set(url, []);
            }
            links.get(url).push(fullPath);
          }
        }
      }
    }
  }

  await walk(dir);
  return links;
}

async function checkUrl(url, baseUrl) {
  const fullUrl = url.startsWith('http') ? url : `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
  const isInternal = fullUrl.startsWith(baseUrl);

  try {
    const res = await fetch(fullUrl, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SEO-Link-Checker/1.0)',
      },
    });

    return {
      url,
      fullUrl,
      status: res.status,
      isInternal,
      redirected: res.redirected,
      finalUrl: res.url !== fullUrl ? res.url : null,
      ok: res.ok,
    };
  } catch (err) {
    return {
      url,
      fullUrl,
      status: 0,
      isInternal,
      error: err.name === 'TimeoutError' ? 'TIMEOUT' : err.message,
      ok: false,
    };
  }
}

async function main() {
  console.log(`Scanning ${args.dir} for links...`);
  const links = await extractLinks(args.dir);

  let urlsToCheck = [...links.keys()];

  if (args['external-only']) {
    urlsToCheck = urlsToCheck.filter(u => u.startsWith('http'));
  } else if (args['internal-only']) {
    if (!args['base-url']) {
      console.error('--base-url is required when using --internal-only (e.g. --base-url https://yoursite.com)');
      process.exit(1);
    }
    urlsToCheck = urlsToCheck.filter(u => !u.startsWith('http') || u.startsWith(args['base-url']));
  }

  console.log(`Found ${urlsToCheck.length} unique URLs to check\n`);

  const results = [];
  for (let i = 0; i < urlsToCheck.length; i += CONCURRENCY) {
    const batch = urlsToCheck.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(url => checkUrl(url, args['base-url']))
    );
    results.push(...batchResults);
    process.stderr.write(`\rChecked ${Math.min(i + CONCURRENCY, urlsToCheck.length)}/${urlsToCheck.length}`);
  }
  console.log('\n');

  const broken = results.filter(r => !r.ok);
  const redirected = results.filter(r => r.ok && r.redirected);

  console.log('=== BROKEN LINK REPORT ===\n');
  console.log(`Total links checked: ${results.length}`);
  console.log(`  OK:          ${results.filter(r => r.ok && !r.redirected).length}`);
  console.log(`  Redirected:  ${redirected.length}`);
  console.log(`  Broken:      ${broken.length}`);

  if (broken.length > 0) {
    console.log('\n--- BROKEN LINKS ---\n');
    for (const b of broken) {
      const sources = links.get(b.url) || [];
      console.log(`  ${b.status || 'ERR'} ${b.url}`);
      if (b.error) console.log(`      Error: ${b.error}`);
      console.log(`      Found in: ${sources.slice(0, 3).join(', ')}${sources.length > 3 ? ` (+${sources.length - 3} more)` : ''}`);
    }
  }

  if (redirected.length > 0) {
    console.log('\n--- REDIRECTED LINKS (update to final URL) ---\n');
    for (const r of redirected.slice(0, 20)) {
      console.log(`  ${r.url}`);
      console.log(`    → ${r.finalUrl}`);
    }
    if (redirected.length > 20) {
      console.log(`  ... and ${redirected.length - 20} more`);
    }
  }

  if (args.output) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(args.output, JSON.stringify({
      generated: new Date().toISOString(),
      totalChecked: results.length,
      broken: broken.map(b => ({ url: b.url, status: b.status, error: b.error, sources: links.get(b.url) })),
      redirected: redirected.map(r => ({ url: r.url, finalUrl: r.finalUrl })),
    }, null, 2));
    console.log(`\nReport saved to ${args.output}`);
  }

  process.exit(broken.length > 0 ? 1 : 0);
}

main().catch(console.error);
