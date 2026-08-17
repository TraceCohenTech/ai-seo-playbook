#!/usr/bin/env node

/**
 * Refresh Tracker
 *
 * Identifies pages that are still getting search impressions but haven't
 * been updated recently. These are refresh candidates — updating them
 * with fresh data triggers a lastmod signal that tells Google the page
 * is still relevant.
 *
 * The "refresh drip" strategy: instead of publishing new content daily,
 * update your best-performing existing pages with current data. A refreshed
 * page with authority beats a new page every time.
 *
 * Usage:
 *   node scripts/refresh-tracker.mjs --site sc-domain:example.com --dir ./content
 *   node scripts/refresh-tracker.mjs --site sc-domain:example.com --dir ./content --stale-days 30
 */

import { google } from 'googleapis';
import { parseArgs } from 'node:util';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const { values: args } = parseArgs({
  options: {
    site: { type: 'string' },
    dir: { type: 'string' },
    'stale-days': { type: 'string', default: '30' },
    'min-impressions': { type: 'string', default: '100' },
    output: { type: 'string' },
  },
});

if (!args.site || !args.dir) {
  console.error('Usage: node scripts/refresh-tracker.mjs --site sc-domain:example.com --dir ./content');
  process.exit(1);
}

const STALE_DAYS = parseInt(args['stale-days']);
const MIN_IMPRESSIONS = parseInt(args['min-impressions']);

async function getAuth() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  return auth.getClient();
}

async function getGscData(auth, site) {
  const searchconsole = google.searchconsole({ version: 'v1', auth });
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 28);

  const res = await searchconsole.searchanalytics.query({
    siteUrl: site,
    requestBody: {
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      dimensions: ['page'],
      rowLimit: 5000,
    },
  });

  return (res.data.rows || []).map(row => ({
    page: row.keys[0],
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: Math.round(row.ctr * 10000) / 100,
    position: Math.round(row.position * 10) / 10,
  }));
}

async function getContentFiles(dir) {
  const files = [];

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await walk(fullPath);
      } else if (['.mdx', '.md', '.tsx', '.jsx'].includes(extname(entry.name))) {
        const fileStat = await stat(fullPath);
        const content = await readFile(fullPath, 'utf-8');

        let lastUpdated = null;
        const lastUpdatedMatch = content.match(/lastUpdated:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?/);
        const dateMatch = content.match(/date:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?/);

        if (lastUpdatedMatch) {
          lastUpdated = new Date(lastUpdatedMatch[1]);
        } else if (dateMatch) {
          lastUpdated = new Date(dateMatch[1]);
        } else {
          lastUpdated = fileStat.mtime;
        }

        const slug = entry.name.replace(/\.(mdx|md|tsx|jsx)$/, '');

        files.push({
          path: fullPath,
          slug,
          lastUpdated,
          daysSinceUpdate: Math.floor((Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24)),
        });
      }
    }
  }

  await walk(dir);
  return files;
}

function matchPageToFile(pageUrl, files) {
  const urlSlug = pageUrl.split('/').pop().replace(/\/$/, '');
  return files.find(f => f.slug === urlSlug || pageUrl.includes(f.slug));
}

async function main() {
  const auth = await getAuth();
  console.log('Fetching GSC data...');
  const gscData = await getGscData(auth, args.site);
  console.log(`Got performance data for ${gscData.length} pages`);

  console.log(`\nScanning content directory: ${args.dir}`);
  const files = await getContentFiles(args.dir);
  console.log(`Found ${files.length} content files`);

  const refreshCandidates = [];
  const healthyPages = [];
  const unknownPages = [];

  for (const page of gscData) {
    if (page.impressions < MIN_IMPRESSIONS) continue;

    const file = matchPageToFile(page.page, files);

    if (!file) {
      unknownPages.push(page);
      continue;
    }

    const entry = {
      url: page.page,
      file: file.path,
      impressions: page.impressions,
      clicks: page.clicks,
      ctr: page.ctr,
      position: page.position,
      lastUpdated: file.lastUpdated.toISOString().split('T')[0],
      daysSinceUpdate: file.daysSinceUpdate,
    };

    if (file.daysSinceUpdate >= STALE_DAYS) {
      entry.urgency = file.daysSinceUpdate >= STALE_DAYS * 2 ? 'CRITICAL' : 'HIGH';
      entry.reason = getRefreshReason(entry);
      refreshCandidates.push(entry);
    } else {
      healthyPages.push(entry);
    }
  }

  refreshCandidates.sort((a, b) => {
    const urgencyOrder = { CRITICAL: 0, HIGH: 1 };
    if (urgencyOrder[a.urgency] !== urgencyOrder[b.urgency]) {
      return urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
    }
    return b.impressions - a.impressions;
  });

  console.log('\n=== REFRESH TRACKER ===\n');
  console.log(`Stale threshold: ${STALE_DAYS} days`);
  console.log(`Min impressions: ${MIN_IMPRESSIONS}\n`);
  console.log(`Refresh candidates:  ${refreshCandidates.length}`);
  console.log(`Healthy pages:       ${healthyPages.length}`);
  console.log(`Unmatched GSC pages: ${unknownPages.length}`);

  if (refreshCandidates.length > 0) {
    console.log('\n--- REFRESH CANDIDATES ---\n');
    for (const c of refreshCandidates) {
      console.log(`  [${c.urgency}] ${c.url}`);
      console.log(`    ${c.impressions.toLocaleString()} impr | ${c.clicks} clicks | pos ${c.position}`);
      console.log(`    Last updated: ${c.lastUpdated} (${c.daysSinceUpdate} days ago)`);
      console.log(`    ${c.reason}\n`);
    }
  }

  if (args.output) {
    const { writeFile } = await import('node:fs/promises');
    const report = {
      generated: new Date().toISOString(),
      config: { staleDays: STALE_DAYS, minImpressions: MIN_IMPRESSIONS },
      refreshCandidates,
      healthyCount: healthyPages.length,
      unmatchedCount: unknownPages.length,
    };
    await writeFile(args.output, JSON.stringify(report, null, 2));
    console.log(`\nReport saved to ${args.output}`);
  }
}

function getRefreshReason(entry) {
  const reasons = [];

  if (entry.daysSinceUpdate >= 60) {
    reasons.push('Content is significantly outdated — Google may be deprioritizing for freshness');
  }

  if (entry.impressions > 5000 && entry.ctr < 0.5) {
    reasons.push('High impressions but very low CTR — title may need refreshing alongside content');
  }

  if (entry.position >= 4 && entry.position <= 10) {
    reasons.push('Ranking on page 1 — a refresh could push to top 3');
  }

  if (entry.position > 10 && entry.position <= 20) {
    reasons.push('Page 2 — a content refresh with updated data could break back to page 1');
  }

  if (reasons.length === 0) {
    reasons.push('Page is stale and still getting traffic — refresh to maintain ranking');
  }

  return reasons.join('. ');
}

main().catch(console.error);
