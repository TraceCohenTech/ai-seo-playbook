#!/usr/bin/env node

/**
 * Weekly SEO Performance Report
 *
 * Pulls comprehensive GSC data and generates an actionable weekly report
 * with opportunity lenses: query monopolies, news waves, dropping pages,
 * and title rewrite candidates.
 *
 * Usage:
 *   node scripts/weekly-report.mjs --site sc-domain:example.com
 *
 * Designed to run as a Sunday morning cron job via GitHub Actions
 * or a local scheduler. See .github/workflows/weekly-seo-report.yml.
 */

import { google } from 'googleapis';
import { writeFileSync } from 'fs';

const DEFAULTS = {
  site: null,
  output: 'weekly-seo-report.json',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { ...DEFAULTS };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const val = args[i + 1];
    if (key === 'site') config.site = val;
    else if (key === 'output') config.output = val;
  }
  if (!config.site) {
    console.error('Usage: node weekly-report.mjs --site sc-domain:example.com');
    process.exit(1);
  }
  return config;
}

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

async function query(sc, site, opts) {
  const res = await sc.searchanalytics.query({
    siteUrl: site,
    requestBody: { dataState: 'final', ...opts },
  });
  return res.data.rows || [];
}

async function main() {
  const config = parseArgs();
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  const sc = google.searchconsole({ version: 'v1', auth });

  // Date ranges
  const thisWeek = { startDate: dateStr(7), endDate: dateStr(1) };
  const lastWeek = { startDate: dateStr(14), endDate: dateStr(8) };
  const last28 = { startDate: dateStr(28), endDate: dateStr(1) };

  console.log(`\nGenerating weekly SEO report for ${config.site}`);
  console.log(`Week: ${thisWeek.startDate} → ${thisWeek.endDate}\n`);

  // 1. Sitewide summary (this week vs last week)
  console.log('Fetching sitewide totals...');
  const [thisTotal] = await query(sc, config.site, { ...thisWeek, rowLimit: 1 });
  const [lastTotal] = await query(sc, config.site, { ...lastWeek, rowLimit: 1 });

  const summary = {
    thisWeek: {
      clicks: thisTotal?.clicks || 0,
      impressions: thisTotal?.impressions || 0,
      ctr: Math.round((thisTotal?.ctr || 0) * 10000) / 100,
      position: Math.round((thisTotal?.position || 0) * 10) / 10,
    },
    lastWeek: {
      clicks: lastTotal?.clicks || 0,
      impressions: lastTotal?.impressions || 0,
      ctr: Math.round((lastTotal?.ctr || 0) * 10000) / 100,
      position: Math.round((lastTotal?.position || 0) * 10) / 10,
    },
    changes: {
      clicks: pctChange(lastTotal?.clicks, thisTotal?.clicks),
      impressions: pctChange(lastTotal?.impressions, thisTotal?.impressions),
      ctr: pctChange(lastTotal?.ctr, thisTotal?.ctr),
    },
  };

  // 2. Top 50 pages by clicks (28d)
  console.log('Fetching top pages...');
  const topPages = await query(sc, config.site, {
    ...last28,
    dimensions: ['page'],
    rowLimit: 50,
  });

  // 3. Trending queries (this week vs last 3 weeks)
  console.log('Fetching trending queries...');
  const thisWeekQueries = await query(sc, config.site, {
    ...thisWeek,
    dimensions: ['query'],
    rowLimit: 500,
  });
  const priorQueries = await query(sc, config.site, {
    startDate: dateStr(28),
    endDate: dateStr(8),
    dimensions: ['query'],
    rowLimit: 500,
  });

  const priorMap = new Map(priorQueries.map(r => [r.keys[0], r]));
  const trending = thisWeekQueries
    .filter(r => r.impressions >= 50)
    .map(r => {
      const prior = priorMap.get(r.keys[0]);
      const priorAvgImpr = prior ? prior.impressions / 3 : 0;
      const growth = priorAvgImpr > 0
        ? (r.impressions - priorAvgImpr) / priorAvgImpr
        : Infinity;
      return { query: r.keys[0], ...r, priorAvgImpr: Math.round(priorAvgImpr), growth };
    })
    .filter(r => r.growth > 1) // >100% growth
    .sort((a, b) => b.growth - a.growth)
    .slice(0, 20);

  // 4. Dropping pages (28d: compare first 14d vs last 14d)
  console.log('Fetching dropping pages...');
  const firstHalf = await query(sc, config.site, {
    startDate: dateStr(28), endDate: dateStr(15),
    dimensions: ['page'], rowLimit: 200,
  });
  const secondHalf = await query(sc, config.site, {
    startDate: dateStr(14), endDate: dateStr(1),
    dimensions: ['page'], rowLimit: 200,
  });

  const secondMap = new Map(secondHalf.map(r => [r.keys[0], r]));
  const dropping = firstHalf
    .filter(r => r.clicks >= 5)
    .map(r => {
      const recent = secondMap.get(r.keys[0]);
      const recentClicks = recent?.clicks || 0;
      const drop = (r.clicks - recentClicks) / r.clicks;
      return {
        page: r.keys[0],
        priorClicks: r.clicks,
        recentClicks,
        dropPct: Math.round(drop * 100),
      };
    })
    .filter(r => r.dropPct >= 30)
    .sort((a, b) => b.dropPct - a.dropPct)
    .slice(0, 15);

  // 5. CTR triage (low-CTR pages with high impressions = title rewrite candidates)
  console.log('Identifying CTR triage candidates...');
  const ctrTriage = topPages
    .filter(r =>
      r.impressions >= 1000 &&
      r.ctr < 0.02 &&
      r.position >= 3 &&
      r.position <= 20
    )
    .map(r => ({
      page: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: Math.round(r.ctr * 10000) / 100,
      position: Math.round(r.position * 10) / 10,
    }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 15);

  // 6. Query monopolies (queries where we get >80% of shown impressions is unknowable,
  // but we can find queries where we rank #1-3 with high impressions)
  const monopolies = thisWeekQueries
    .filter(r => r.position <= 3 && r.impressions >= 100)
    .map(r => ({
      query: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: Math.round(r.ctr * 10000) / 100,
      position: Math.round(r.position * 10) / 10,
    }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 20);

  // Compile report
  const report = {
    generated: new Date().toISOString(),
    site: config.site,
    period: thisWeek,
    summary,
    topPages: topPages.slice(0, 50).map(r => ({
      page: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: Math.round(r.ctr * 10000) / 100,
      position: Math.round(r.position * 10) / 10,
    })),
    trending,
    dropping,
    ctrTriage,
    monopolies,
  };

  writeFileSync(config.output, JSON.stringify(report, null, 2));

  // Print summary
  console.log('\n' + '═'.repeat(60));
  console.log(' WEEKLY SEO REPORT');
  console.log('═'.repeat(60));

  console.log(`\n  Clicks:      ${summary.thisWeek.clicks.toLocaleString()} (${fmtChange(summary.changes.clicks)})`);
  console.log(`  Impressions: ${summary.thisWeek.impressions.toLocaleString()} (${fmtChange(summary.changes.impressions)})`);
  console.log(`  CTR:         ${summary.thisWeek.ctr}% (${fmtChange(summary.changes.ctr)})`);
  console.log(`  Avg Pos:     ${summary.thisWeek.position}`);

  if (trending.length > 0) {
    console.log('\n  TRENDING QUERIES (>100% growth vs prior 3-wk avg):');
    for (const t of trending.slice(0, 10)) {
      console.log(`    ${t.impressions.toLocaleString().padStart(6)} impr  "${t.query}"`);
    }
  }

  if (dropping.length > 0) {
    console.log('\n  DROPPING PAGES (>30% click decline):');
    for (const d of dropping.slice(0, 5)) {
      console.log(`    -${d.dropPct}%  ${shorten(d.page)}`);
    }
  }

  if (ctrTriage.length > 0) {
    console.log('\n  TITLE REWRITE CANDIDATES:');
    for (const c of ctrTriage.slice(0, 5)) {
      console.log(`    ${c.impressions.toLocaleString().padStart(8)} impr  ${c.ctr}% CTR  pos ${c.position}  ${shorten(c.page)}`);
    }
  }

  console.log(`\n  Full report: ${config.output}\n`);
}

function pctChange(old, cur) {
  if (!old || old === 0) return null;
  return Math.round(((cur - old) / old) * 1000) / 10;
}

function fmtChange(pct) {
  if (pct === null) return 'n/a';
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

function shorten(url) {
  return url.replace(/^https?:\/\/[^/]+/, '');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
