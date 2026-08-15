#!/usr/bin/env node

/**
 * Redirect Checker
 *
 * Compares your sitemap URLs against GSC to find pages that are
 * submitting redirects (301/302/308) instead of 200s. Google will
 * eventually drop these from the index and your sitemap validation
 * will fail.
 *
 * Usage:
 *   node scripts/redirect-checker.mjs --site sc-domain:example.com --sitemap https://example.com/sitemap.xml
 *   node scripts/redirect-checker.mjs --site sc-domain:example.com --dir ./content
 */

import { google } from 'googleapis';
import { parseArgs } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const { values: args } = parseArgs({
  options: {
    site: { type: 'string' },
    sitemap: { type: 'string' },
    dir: { type: 'string' },
    'base-url': { type: 'string', default: 'https://example.com' },
    output: { type: 'string' },
  },
});

if (!args.site) {
  console.error('Usage: node scripts/redirect-checker.mjs --site sc-domain:example.com [--sitemap URL | --dir PATH]');
  process.exit(1);
}

async function getAuth() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  return auth.getClient();
}

async function getUrlsFromSitemap(sitemapUrl) {
  const res = await fetch(sitemapUrl);
  const xml = await res.text();
  const urls = [];
  const locRegex = /<loc>(.*?)<\/loc>/g;
  let match;
  while ((match = locRegex.exec(xml)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

async function getUrlsFromDir(dir, baseUrl) {
  const urls = [];

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (['.mdx', '.md', '.tsx', '.jsx'].includes(extname(entry.name))) {
        const slug = entry.name.replace(/\.(mdx|md|tsx|jsx)$/, '');
        const relativePath = fullPath.replace(dir, '').replace(/\\/g, '/');
        const urlPath = relativePath.replace(/\.(mdx|md|tsx|jsx)$/, '').replace(/\/index$/, '');
        urls.push(`${baseUrl}${urlPath}`);
      }
    }
  }

  await walk(dir);
  return urls;
}

async function checkUrlStatus(url) {
  try {
    const res = await fetch(url, { redirect: 'manual' });
    return {
      url,
      status: res.status,
      location: res.headers.get('location'),
      isRedirect: res.status >= 300 && res.status < 400,
    };
  } catch (err) {
    return { url, status: 0, error: err.message, isRedirect: false };
  }
}

async function getGscIndexStatus(auth, site) {
  const searchconsole = google.searchconsole({ version: 'v1', auth });

  try {
    const res = await searchconsole.urlInspection.index.inspect({
      requestBody: { inspectionUrl: site, siteUrl: site },
    });
    return res.data;
  } catch {
    return null;
  }
}

async function main() {
  let urls = [];

  if (args.sitemap) {
    console.log(`Fetching URLs from sitemap: ${args.sitemap}`);
    urls = await getUrlsFromSitemap(args.sitemap);
  } else if (args.dir) {
    console.log(`Scanning directory: ${args.dir}`);
    urls = await getUrlsFromDir(args.dir, args['base-url']);
  } else {
    console.error('Provide either --sitemap URL or --dir PATH');
    process.exit(1);
  }

  console.log(`Found ${urls.length} URLs to check\n`);

  const results = [];
  const batchSize = 10;

  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(checkUrlStatus));
    results.push(...batchResults);

    const checked = Math.min(i + batchSize, urls.length);
    process.stderr.write(`\rChecked ${checked}/${urls.length} URLs`);
  }
  console.log('\n');

  const redirects = results.filter(r => r.isRedirect);
  const errors = results.filter(r => r.status === 0);
  const notFound = results.filter(r => r.status === 404);

  console.log('=== REDIRECT CHECKER RESULTS ===\n');
  console.log(`Total URLs checked: ${results.length}`);
  console.log(`  200 OK:        ${results.filter(r => r.status === 200).length}`);
  console.log(`  Redirects:     ${redirects.length}`);
  console.log(`  404 Not Found: ${notFound.length}`);
  console.log(`  Errors:        ${errors.length}`);

  if (redirects.length > 0) {
    console.log('\n--- REDIRECTS (remove from sitemap or fix) ---\n');
    for (const r of redirects) {
      console.log(`  ${r.status} ${r.url}`);
      console.log(`    → ${r.location}`);
    }
    console.log('\n  ACTION: These URLs are submitting redirects to Google.');
    console.log('  Your sitemap should only contain URLs that return 200.');
    console.log('  Either update the sitemap to use the redirect target,');
    console.log('  or fix the redirect so the original URL serves content.');
  }

  if (notFound.length > 0) {
    console.log('\n--- 404 NOT FOUND (remove from sitemap) ---\n');
    for (const r of notFound) {
      console.log(`  ${r.url}`);
    }
  }

  if (args.output) {
    const { writeFile } = await import('node:fs/promises');
    const report = {
      generated: new Date().toISOString(),
      totalChecked: results.length,
      redirects: redirects.map(r => ({ url: r.url, status: r.status, target: r.location })),
      notFound: notFound.map(r => r.url),
      errors: errors.map(r => ({ url: r.url, error: r.error })),
    };
    await writeFile(args.output, JSON.stringify(report, null, 2));
    console.log(`\nReport saved to ${args.output}`);
  }
}

main().catch(console.error);
