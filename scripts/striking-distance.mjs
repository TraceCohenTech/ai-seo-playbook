#!/usr/bin/env node

/**
 * Striking Distance Finder
 *
 * Finds pages ranking position 5-20 with real impressions — the "almost
 * on page 1" pages where a small nudge (deeper content, better headers,
 * an FAQ section, more internal links) can produce outsized click gains.
 *
 * Clicks jump non-linearly when you cross from position 11 to 10 (page 2
 * to page 1), and again from position 4 to 3 (below to above the fold).
 * These are the cheapest wins in SEO.
 *
 * Usage:
 *   node scripts/striking-distance.mjs --site sc-domain:example.com
 *   node scripts/striking-distance.mjs --site sc-domain:example.com --min-pos 5 --max-pos 20
 */

import { google } from 'googleapis';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    site: { type: 'string' },
    'min-pos': { type: 'string', default: '5' },
    'max-pos': { type: 'string', default: '20' },
    'min-impressions': { type: 'string', default: '200' },
    days: { type: 'string', default: '28' },
    output: { type: 'string' },
  },
});

if (!args.site) {
  console.error('Usage: node scripts/striking-distance.mjs --site sc-domain:example.com');
  process.exit(1);
}

const MIN_POS = parseFloat(args['min-pos']);
const MAX_POS = parseFloat(args['max-pos']);
const MIN_IMPR = parseInt(args['min-impressions']);
const DAYS = parseInt(args.days);

const EXPECTED_CTR = {
  3: 8.0, 4: 5.0, 5: 3.5, 6: 2.5, 7: 2.0, 8: 1.5, 9: 1.2, 10: 1.0,
  11: 0.8, 12: 0.6, 13: 0.5, 14: 0.4, 15: 0.3, 16: 0.25, 17: 0.2, 18: 0.18, 19: 0.15, 20: 0.12,
};

async function getAuth() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  return auth.getClient();
}

async function getPageQueryData(auth, site) {
  const searchconsole = google.searchconsole({ version: 'v1', auth });
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - DAYS);

  const res = await searchconsole.searchanalytics.query({
    siteUrl: site,
    requestBody: {
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      dimensions: ['page', 'query'],
      rowLimit: 10000,
      dataState: 'all',
    },
  });

  return (res.data.rows || []).map(row => ({
    page: row.keys[0],
    query: row.keys[1],
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: Math.round(row.ctr * 10000) / 100,
    position: Math.round(row.position * 10) / 10,
  }));
}

function estimateClickGain(currentPos, impressions) {
  const targetPos = currentPos > 10 ? 8 : Math.max(3, currentPos - 2);
  const currentExpectedCtr = EXPECTED_CTR[Math.round(currentPos)] || 0.5;
  const targetExpectedCtr = EXPECTED_CTR[targetPos] || 5.0;
  const currentClicks = impressions * (currentExpectedCtr / 100);
  const projectedClicks = impressions * (targetExpectedCtr / 100);
  return {
    targetPosition: targetPos,
    currentEstClicks: Math.round(currentClicks),
    projectedClicks: Math.round(projectedClicks),
    clickGain: Math.round(projectedClicks - currentClicks),
  };
}

function suggestAction(entry) {
  const actions = [];

  if (entry.position > 10) {
    actions.push('Add depth: expand the section that matches this query, add data/examples');
    actions.push('Build internal links: point 3-5 related pages to this one');
  }

  if (entry.position >= 5 && entry.position <= 10) {
    actions.push('Add an FAQ section answering related questions');
    actions.push('Update with fresh data — trigger lastmod freshness signal');
  }

  if (entry.ctr < (EXPECTED_CTR[Math.round(entry.position)] || 1)) {
    actions.push('Rewrite title to better match this query\'s intent');
  }

  return actions;
}

async function main() {
  const auth = await getAuth();

  console.log(`Fetching page+query data for ${args.site} (last ${DAYS} days)...`);
  const data = await getPageQueryData(auth, args.site);
  console.log(`Got ${data.length} page+query combinations`);

  const pageMap = new Map();
  for (const row of data) {
    if (row.position < MIN_POS || row.position > MAX_POS) continue;
    if (row.impressions < MIN_IMPR) continue;

    const key = row.page;
    if (!pageMap.has(key)) {
      pageMap.set(key, { page: row.page, queries: [], totalImpressions: 0, totalClicks: 0 });
    }
    const entry = pageMap.get(key);
    entry.queries.push(row);
    entry.totalImpressions += row.impressions;
    entry.totalClicks += row.clicks;
  }

  const results = [];
  for (const [, entry] of pageMap) {
    const bestQuery = entry.queries.sort((a, b) => b.impressions - a.impressions)[0];
    const gain = estimateClickGain(bestQuery.position, entry.totalImpressions);

    results.push({
      page: entry.page,
      topQuery: bestQuery.query,
      position: bestQuery.position,
      impressions: entry.totalImpressions,
      clicks: entry.totalClicks,
      ctr: entry.totalImpressions > 0 ? Math.round((entry.totalClicks / entry.totalImpressions) * 10000) / 100 : 0,
      queryCount: entry.queries.length,
      ...gain,
      actions: suggestAction(bestQuery),
    });
  }

  results.sort((a, b) => b.clickGain - a.clickGain);

  console.log('\n=== STRIKING DISTANCE OPPORTUNITIES ===\n');
  console.log(`Pages ranking position ${MIN_POS}-${MAX_POS} with ≥${MIN_IMPR} impressions:`);
  console.log(`Found ${results.length} opportunities\n`);

  if (results.length > 0) {
    const totalGain = results.reduce((s, r) => s + r.clickGain, 0);
    console.log(`Estimated total click gain if all improved: +${totalGain.toLocaleString()} clicks\n`);

    console.log('--- TOP OPPORTUNITIES ---\n');
    for (const r of results.slice(0, 20)) {
      console.log(`  ${r.page}`);
      console.log(`    Top query: "${r.topQuery}" (pos ${r.position})`);
      console.log(`    ${r.impressions.toLocaleString()} impr | ${r.clicks} clicks | ${r.queryCount} queries`);
      console.log(`    If improved to pos ${r.targetPosition}: +${r.clickGain} clicks/period`);
      for (const a of r.actions) {
        console.log(`    → ${a}`);
      }
      console.log();
    }
  }

  if (args.output) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(args.output, JSON.stringify({
      generated: new Date().toISOString(),
      config: { minPos: MIN_POS, maxPos: MAX_POS, minImpressions: MIN_IMPR, days: DAYS },
      totalOpportunities: results.length,
      estimatedTotalClickGain: results.reduce((s, r) => s + r.clickGain, 0),
      opportunities: results,
    }, null, 2));
    console.log(`Report saved to ${args.output}`);
  }
}

main().catch(console.error);
