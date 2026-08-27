#!/usr/bin/env node

/**
 * Rewrite Measurer
 *
 * Tracks the before/after impact of title rewrites. Takes a baseline
 * snapshot, then compares against current performance to measure whether
 * your rewrites actually worked.
 *
 * Two modes:
 *   1. BASELINE: Save a snapshot of current performance for specific pages
 *   2. MEASURE: Compare current performance against a saved baseline
 *
 * Usage:
 *   # Step 1: Take a baseline BEFORE making rewrites
 *   node scripts/rewrite-measurer.mjs baseline --site sc-domain:example.com --pages /blog/post-1,/blog/post-2
 *
 *   # Step 2: Wait 2-4 weeks for GSC data to accumulate
 *
 *   # Step 3: Measure the impact
 *   node scripts/rewrite-measurer.mjs measure --site sc-domain:example.com --baseline rewrite-baseline.json
 */

import { google } from 'googleapis';
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';

const mode = process.argv[2];

if (!['baseline', 'measure'].includes(mode)) {
  console.error('Usage:');
  console.error('  node scripts/rewrite-measurer.mjs baseline --site SITE --pages /path1,/path2');
  console.error('  node scripts/rewrite-measurer.mjs measure --site SITE --baseline file.json');
  process.exit(1);
}

const { values: args } = parseArgs({
  args: process.argv.slice(3),
  options: {
    site: { type: 'string' },
    pages: { type: 'string' },
    baseline: { type: 'string' },
    days: { type: 'string', default: '28' },
    output: { type: 'string' },
  },
});

if (!args.site) {
  console.error('--site is required');
  process.exit(1);
}

const DAYS = parseInt(args.days);

async function getAuth() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  return auth.getClient();
}

async function getPageStats(auth, site, pages) {
  const searchconsole = google.searchconsole({ version: 'v1', auth });
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - DAYS);

  const results = [];

  for (const pagePath of pages) {
    const url = pagePath.startsWith('http') ? pagePath : `https://${site.replace('sc-domain:', '')}${pagePath}`;

    const res = await searchconsole.searchanalytics.query({
      siteUrl: site,
      requestBody: {
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
        dimensions: ['page'],
        dimensionFilterGroups: [{
          filters: [{ dimension: 'page', operator: 'equals', expression: url }],
        }],
        rowLimit: 1,
      },
    });

    const row = (res.data.rows || [])[0];
    results.push({
      page: pagePath,
      url,
      clicks: row?.clicks || 0,
      impressions: row?.impressions || 0,
      ctr: row ? Math.round(row.ctr * 10000) / 100 : 0,
      position: row ? Math.round(row.position * 10) / 10 : 0,
    });
  }

  return results;
}

async function runBaseline() {
  if (!args.pages) {
    console.error('--pages is required for baseline mode (comma-separated paths)');
    process.exit(1);
  }

  const pages = args.pages.split(',').map(p => p.trim());
  const auth = await getAuth();

  console.log(`Taking baseline for ${pages.length} pages (last ${DAYS} days)...\n`);
  const stats = await getPageStats(auth, args.site, pages);

  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - DAYS);

  const baseline = {
    created: new Date().toISOString(),
    site: args.site,
    window: {
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      days: DAYS,
    },
    pages: stats,
  };

  const outputFile = args.output || 'rewrite-baseline.json';
  await writeFile(outputFile, JSON.stringify(baseline, null, 2));

  console.log('--- BASELINE SNAPSHOT ---\n');
  console.log(`${'Page'.padEnd(55)} ${'Impr'.padStart(8)} ${'Clicks'.padStart(8)} ${'CTR%'.padStart(7)} ${'Pos'.padStart(6)}`);
  for (const s of stats) {
    console.log(`${s.page.slice(0, 53).padEnd(55)} ${String(s.impressions).padStart(8)} ${String(s.clicks).padStart(8)} ${String(s.ctr).padStart(7)} ${String(s.position).padStart(6)}`);
  }

  const totals = stats.reduce((a, s) => ({ i: a.i + s.impressions, c: a.c + s.clicks }), { i: 0, c: 0 });
  console.log(`\nTotal: ${totals.i.toLocaleString()} impressions, ${totals.c.toLocaleString()} clicks, ${totals.i > 0 ? (100 * totals.c / totals.i).toFixed(2) : 0}% CTR`);
  console.log(`\nBaseline saved to ${outputFile}`);
  console.log('Now make your title rewrites, wait 2-4 weeks, then run:');
  console.log(`  node scripts/rewrite-measurer.mjs measure --site ${args.site} --baseline ${outputFile}`);
}

async function runMeasure() {
  if (!args.baseline) {
    console.error('--baseline is required for measure mode');
    process.exit(1);
  }

  const baselineData = JSON.parse(await readFile(args.baseline, 'utf-8'));
  const pages = baselineData.pages.map(p => p.page);
  const auth = await getAuth();

  console.log(`Measuring ${pages.length} pages against baseline from ${baselineData.window.startDate}...\n`);
  const current = await getPageStats(auth, args.site, pages);

  const comparisons = [];

  console.log('--- REWRITE IMPACT ---\n');
  console.log(`${'Page'.padEnd(45)} ${'Impr'.padStart(10)} ${'Clicks'.padStart(10)} ${'CTR'.padStart(10)} ${'Pos'.padStart(8)} ${'Verdict'.padStart(10)}`);

  for (const curr of current) {
    const base = baselineData.pages.find(p => p.page === curr.page);
    if (!base) continue;

    const ctrChange = curr.ctr - base.ctr;
    const clickChange = curr.clicks - base.clicks;
    const posChange = base.position - curr.position;

    let verdict = 'NEUTRAL';
    if (ctrChange > 0.5 && clickChange > 0) verdict = 'WIN';
    else if (ctrChange > 0.2) verdict = 'SLIGHT WIN';
    else if (ctrChange < -0.5) verdict = 'REGRESSED';

    const comp = {
      page: curr.page,
      before: base,
      after: curr,
      changes: {
        impressions: base.impressions > 0 ? Math.round((curr.impressions - base.impressions) / base.impressions * 100) : 0,
        clicks: clickChange,
        ctr: Math.round(ctrChange * 100) / 100,
        position: Math.round(posChange * 10) / 10,
      },
      verdict,
    };
    comparisons.push(comp);

    const imprStr = `${curr.impressions} (${comp.changes.impressions >= 0 ? '+' : ''}${comp.changes.impressions}%)`;
    const clickStr = `${curr.clicks} (${clickChange >= 0 ? '+' : ''}${clickChange})`;
    const ctrStr = `${curr.ctr}% (${ctrChange >= 0 ? '+' : ''}${ctrChange.toFixed(2)})`;
    const posStr = `${curr.position} (${posChange >= 0 ? '+' : ''}${posChange.toFixed(1)})`;

    console.log(`${curr.page.slice(0, 43).padEnd(45)} ${imprStr.padStart(10)} ${clickStr.padStart(10)} ${ctrStr.padStart(10)} ${posStr.padStart(8)} ${verdict.padStart(10)}`);
  }

  const wins = comparisons.filter(c => c.verdict === 'WIN' || c.verdict === 'SLIGHT WIN').length;
  const regressed = comparisons.filter(c => c.verdict === 'REGRESSED').length;

  console.log(`\n--- SUMMARY ---`);
  console.log(`  Wins:       ${wins}/${comparisons.length}`);
  console.log(`  Neutral:    ${comparisons.length - wins - regressed}/${comparisons.length}`);
  console.log(`  Regressed:  ${regressed}/${comparisons.length}`);

  const totalClickChange = comparisons.reduce((s, c) => s + c.changes.clicks, 0);
  console.log(`  Net clicks: ${totalClickChange >= 0 ? '+' : ''}${totalClickChange}`);

  if (args.output) {
    await writeFile(args.output, JSON.stringify({
      generated: new Date().toISOString(),
      baseline: baselineData.window,
      comparisons,
      summary: { total: comparisons.length, wins, regressed, netClicks: totalClickChange },
    }, null, 2));
    console.log(`\nReport saved to ${args.output}`);
  }
}

if (mode === 'baseline') {
  runBaseline().catch(console.error);
} else {
  runMeasure().catch(console.error);
}
