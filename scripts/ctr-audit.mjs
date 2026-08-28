#!/usr/bin/env node

/**
 * CTR Audit — Wasted Impression Scorer
 *
 * Pulls page-level GSC data and scores every page by "wasted impressions" —
 * the gap between expected clicks (based on position) and actual clicks.
 * Outputs a tiered priority list (High/Med/Low) for title rewrite batches.
 *
 * Usage:
 *   node scripts/ctr-audit.mjs --site sc-domain:example.com
 *
 * This is the tool behind the "CTR rescue" strategy: identify the 20-50
 * pages where a title rewrite will recover the most clicks, batch-rewrite
 * them in a single day, then measure impact 2-4 weeks later.
 *
 * Prerequisites:
 *   - Google Cloud project with Search Console API enabled
 *   - Application Default Credentials configured
 */

import { google } from 'googleapis';
import { writeFileSync } from 'fs';

const DEFAULTS = {
  site: null,
  days: 28,
  minImpressions: 500,
  output: 'ctr-audit.json',
};

// Expected CTR by position (industry averages for organic results)
const EXPECTED_CTR = {
  1: 0.30, 2: 0.15, 3: 0.10, 4: 0.07, 5: 0.05,
  6: 0.04, 7: 0.03, 8: 0.025, 9: 0.02, 10: 0.015,
  11: 0.01, 12: 0.008, 13: 0.007, 14: 0.006, 15: 0.005,
  16: 0.004, 17: 0.003, 18: 0.003, 19: 0.002, 20: 0.002,
};

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { ...DEFAULTS };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const val = args[i + 1];
    if (key === 'site') config.site = val;
    else if (key === 'days') config.days = Number(val);
    else if (key === 'min-impressions') config.minImpressions = Number(val);
    else if (key === 'output') config.output = val;
  }
  if (!config.site) {
    console.error('Usage: node ctr-audit.mjs --site sc-domain:example.com');
    console.error('\nOptions:');
    console.error('  --site              GSC property (required)');
    console.error('  --days              Lookback period (default: 28)');
    console.error('  --min-impressions   Minimum impressions to include (default: 500)');
    console.error('  --output            Output file path (default: ctr-audit.json)');
    process.exit(1);
  }
  return config;
}

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

function getExpectedCtr(position) {
  const rounded = Math.min(20, Math.max(1, Math.round(position)));
  return EXPECTED_CTR[rounded] || 0.002;
}

function tierPage(wastedImpressions, ctr, expectedCtr) {
  const ctrGap = expectedCtr - ctr;
  if (wastedImpressions >= 500 && ctrGap > 0.02) return 'HIGH';
  if (wastedImpressions >= 200 && ctrGap > 0.01) return 'MEDIUM';
  if (wastedImpressions >= 50) return 'LOW';
  return 'SKIP';
}

async function main() {
  const config = parseArgs();
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  const sc = google.searchconsole({ version: 'v1', auth });

  const startDate = dateStr(config.days);
  const endDate = dateStr(1);

  console.log(`\nCTR Audit for ${config.site}`);
  console.log(`Period: ${startDate} → ${endDate}\n`);

  const res = await sc.searchanalytics.query({
    siteUrl: config.site,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['page'],
      rowLimit: 5000,
      dataState: 'final',
    },
  });

  const pages = (res.data.rows || [])
    .filter(r => r.impressions >= config.minImpressions)
    .map(r => {
      const expectedCtr = getExpectedCtr(r.position);
      const expectedClicks = Math.round(r.impressions * expectedCtr);
      const wastedImpressions = Math.max(0, expectedClicks - r.clicks);
      const ctr = r.ctr;
      const tier = tierPage(wastedImpressions, ctr, expectedCtr);

      return {
        url: r.keys[0],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: Math.round(ctr * 10000) / 100,
        position: Math.round(r.position * 10) / 10,
        expectedCtr: Math.round(expectedCtr * 10000) / 100,
        expectedClicks,
        wastedImpressions,
        tier,
      };
    })
    .filter(p => p.tier !== 'SKIP')
    .sort((a, b) => b.wastedImpressions - a.wastedImpressions);

  const tiers = { HIGH: [], MEDIUM: [], LOW: [] };
  for (const p of pages) tiers[p.tier].push(p);

  const output = {
    generatedAt: new Date().toISOString(),
    site: config.site,
    period: { startDate, endDate },
    summary: {
      totalPages: pages.length,
      high: tiers.HIGH.length,
      medium: tiers.MEDIUM.length,
      low: tiers.LOW.length,
      totalWastedImpressions: pages.reduce((s, p) => s + p.wastedImpressions, 0),
    },
    pages,
  };

  writeFileSync(config.output, JSON.stringify(output, null, 2));

  // Print summary
  console.log('═'.repeat(70));
  console.log(' CTR AUDIT RESULTS');
  console.log('═'.repeat(70));
  console.log(`\n  Total candidates:       ${pages.length}`);
  console.log(`  HIGH priority:          ${tiers.HIGH.length}`);
  console.log(`  MEDIUM priority:        ${tiers.MEDIUM.length}`);
  console.log(`  LOW priority:           ${tiers.LOW.length}`);
  console.log(`  Total wasted clicks:    ${output.summary.totalWastedImpressions.toLocaleString()}\n`);

  for (const tier of ['HIGH', 'MEDIUM', 'LOW']) {
    const items = tiers[tier];
    if (items.length === 0) continue;

    console.log(`\n  ${tier} (${items.length}):`);
    console.log('  Wasted   Impr       CTR    Exp CTR  Pos   URL');
    console.log('  ' + '─'.repeat(68));

    for (const p of items.slice(0, 15)) {
      const wasted = String(p.wastedImpressions).padStart(6);
      const impr = String(p.impressions.toLocaleString()).padStart(9);
      const ctr = `${p.ctr}%`.padStart(6);
      const expCtr = `${p.expectedCtr}%`.padStart(7);
      const pos = String(p.position).padStart(5);
      const url = p.url.replace(/^https?:\/\/[^/]+/, '');
      console.log(`  ${wasted}  ${impr}  ${ctr}  ${expCtr}  ${pos}   ${url}`);
    }
    if (items.length > 15) console.log(`  ... and ${items.length - 15} more`);
  }

  console.log(`\n  Full audit: ${config.output}\n`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
