#!/usr/bin/env node

/**
 * Cannibalization Detector
 *
 * Finds pages on your site competing for the same queries in Google Search Console.
 * When multiple pages rank for the same query, they split authority and both rank
 * worse than one consolidated page would.
 *
 * Usage:
 *   node scripts/cannibalization-detector.mjs --site sc-domain:example.com
 *
 * Output:
 *   Clusters of pages competing for the same queries, ranked by wasted impressions.
 */

import { google } from 'googleapis';
import { writeFileSync } from 'fs';

const DEFAULTS = {
  site: null,
  minImpressions: 100,
  days: 28,
  output: 'cannibal-clusters.json',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { ...DEFAULTS };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const val = args[i + 1];
    if (key === 'site') config.site = val;
    else if (key === 'min-impressions') config.minImpressions = Number(val);
    else if (key === 'days') config.days = Number(val);
    else if (key === 'output') config.output = val;
  }
  if (!config.site) {
    console.error('Usage: node cannibalization-detector.mjs --site sc-domain:example.com');
    process.exit(1);
  }
  return config;
}

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

async function main() {
  const config = parseArgs();
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  const searchconsole = google.searchconsole({ version: 'v1', auth });

  const startDate = dateStr(config.days);
  const endDate = dateStr(1);

  console.log(`\nScanning ${config.site} for cannibalization clusters`);
  console.log(`Period: ${startDate} → ${endDate}\n`);

  // Pull query + page combinations
  const res = await searchconsole.searchanalytics.query({
    siteUrl: config.site,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['query', 'page'],
      rowLimit: 25000,
      dataState: 'final',
    },
  });

  const rows = res.data.rows || [];
  console.log(`Fetched ${rows.length} query-page combinations\n`);

  // Group by query
  const queryPages = new Map();
  for (const row of rows) {
    const [query, page] = row.keys;
    if (row.impressions < config.minImpressions) continue;

    if (!queryPages.has(query)) queryPages.set(query, []);
    queryPages.get(query).push({
      page,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    });
  }

  // Find queries with multiple competing pages
  const clusters = [];
  for (const [query, pages] of queryPages) {
    if (pages.length < 2) continue;

    pages.sort((a, b) => a.position - b.position);
    const totalImpressions = pages.reduce((s, p) => s + p.impressions, 0);
    const totalClicks = pages.reduce((s, p) => s + p.clicks, 0);

    // The "winner" is the page with the best position
    const winner = pages[0];
    const losers = pages.slice(1);

    // Estimate wasted potential: if the winner had all the impressions,
    // it would likely have a better position and higher CTR
    const wastedImpressions = losers.reduce((s, p) => s + p.impressions, 0);

    clusters.push({
      query,
      pageCount: pages.length,
      totalImpressions,
      totalClicks,
      wastedImpressions,
      winner: {
        page: winner.page,
        position: Math.round(winner.position * 10) / 10,
        clicks: winner.clicks,
        impressions: winner.impressions,
      },
      losers: losers.map(l => ({
        page: l.page,
        position: Math.round(l.position * 10) / 10,
        clicks: l.clicks,
        impressions: l.impressions,
      })),
      recommendation: recommend(winner, losers),
    });
  }

  clusters.sort((a, b) => b.wastedImpressions - a.wastedImpressions);

  writeFileSync(config.output, JSON.stringify(clusters, null, 2));

  // Print summary
  console.log(`Found ${clusters.length} cannibalization clusters\n`);
  console.log('Top 20 clusters by wasted impressions:\n');

  for (const c of clusters.slice(0, 20)) {
    console.log(`  Query: "${c.query}"`);
    console.log(`  Pages: ${c.pageCount} competing | Wasted: ${c.wastedImpressions.toLocaleString()} impressions`);
    console.log(`  Winner: ${shorten(c.winner.page)} (pos ${c.winner.position})`);
    for (const l of c.losers) {
      console.log(`  Loser:  ${shorten(l.page)} (pos ${l.position}) → 301 to winner`);
    }
    console.log(`  Action: ${c.recommendation}`);
    console.log('');
  }

  const totalWasted = clusters.reduce((s, c) => s + c.wastedImpressions, 0);
  console.log(`Total wasted impressions across all clusters: ${totalWasted.toLocaleString()}`);
  console.log(`Full results: ${config.output}\n`);
}

function shorten(url) {
  return url.replace(/^https?:\/\/[^/]+/, '');
}

function recommend(winner, losers) {
  if (losers.length === 1) {
    return `Consolidate: 301 ${shorten(losers[0].page)} → ${shorten(winner.page)}, merge best content.`;
  }
  return `Consolidate ${losers.length} pages: 301 all losers → ${shorten(winner.page)}, merge best content from each.`;
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
