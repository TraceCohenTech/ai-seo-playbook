#!/usr/bin/env node

/**
 * Query Gap Miner
 *
 * The retroactive keyword discovery engine. Scans every query your site
 * appears for in GSC and surfaces the ones with real search demand but
 * no dedicated page — you're showing up at position 15+ because Google
 * thinks your site is relevant, but no single page targets that query.
 *
 * These are your highest-ROI content opportunities: Google is already
 * telling you what to write about.
 *
 * Usage:
 *   node scripts/query-gap-miner.mjs --site sc-domain:example.com --dir ./content
 *   node scripts/query-gap-miner.mjs --site sc-domain:example.com --dir ./content --min-impressions 50 --top 30
 */

import { google } from 'googleapis';
import { parseArgs } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const { values: args } = parseArgs({
  options: {
    site: { type: 'string' },
    dir: { type: 'string' },
    'min-impressions': { type: 'string', default: '80' },
    'min-position': { type: 'string', default: '15' },
    top: { type: 'string', default: '25' },
    output: { type: 'string' },
    days: { type: 'string', default: '60' },
  },
});

if (!args.site) {
  console.error('Usage: node scripts/query-gap-miner.mjs --site sc-domain:example.com [--dir ./content]');
  process.exit(1);
}

const MIN_IMPRESSIONS = parseInt(args['min-impressions']);
const MIN_POSITION = parseInt(args['min-position']);
const TOP_N = parseInt(args.top);
const DAYS = parseInt(args.days);

const EXCLUDE_PATTERNS = [
  /near me/i,
  /jailbreak/i,
  /login/i,
  /sign ?in/i,
];

async function getAuth() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  return auth.getClient();
}

async function getQueryData(auth, site) {
  const searchconsole = google.searchconsole({ version: 'v1', auth });
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - DAYS);

  const allRows = [];
  let startRow = 0;
  const BATCH = 5000;

  while (true) {
    const res = await searchconsole.searchanalytics.query({
      siteUrl: site,
      requestBody: {
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
        dimensions: ['query'],
        rowLimit: BATCH,
        startRow,
        dataState: 'all',
      },
    });

    const rows = res.data.rows || [];
    allRows.push(...rows);

    if (rows.length < BATCH) break;
    startRow += BATCH;
  }

  return allRows.map(row => ({
    query: row.keys[0],
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: Math.round(row.ctr * 10000) / 100,
    position: Math.round(row.position * 10) / 10,
  }));
}

async function getExistingTopics(dir) {
  if (!dir) return new Set();

  const topics = new Set();

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await walk(fullPath);
      } else if (['.mdx', '.md', '.tsx', '.jsx'].includes(extname(entry.name))) {
        const slug = entry.name.replace(/\.(mdx|md|tsx|jsx)$/, '');
        const words = slug.split(/[-_]/).filter(w => w.length > 2);
        words.forEach(w => topics.add(w.toLowerCase()));

        try {
          const content = await readFile(fullPath, 'utf-8');
          const titleMatch = content.match(/title:\s*['"]?(.*?)['"]?\s*$/m);
          if (titleMatch) {
            titleMatch[1].toLowerCase().split(/\s+/).filter(w => w.length > 3)
              .forEach(w => topics.add(w));
          }
        } catch {}
      }
    }
  }

  await walk(dir);
  return topics;
}

function isExcluded(query) {
  return EXCLUDE_PATTERNS.some(p => p.test(query));
}

function hasDedicatedPage(query, existingTopics) {
  if (existingTopics.size === 0) return false;

  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (queryWords.length === 0) return false;

  const matchCount = queryWords.filter(w => existingTopics.has(w)).length;
  return matchCount >= queryWords.length * 0.8;
}

function classifyOpportunity(query) {
  if (/\d{4}/.test(query)) return 'TIME-SENSITIVE';
  if (/^(what|how|why|when|where|who|is|are|can|do|does)\b/i.test(query)) return 'QUESTION';
  if (/\bvs\b|versus|compared?\b|comparison/i.test(query)) return 'COMPARISON';
  if (/\bbest\b|top\b|ranking|rated/i.test(query)) return 'RANKING';
  if (/\bprice|cost|salary|worth|valuation|revenue/i.test(query)) return 'DATA-DRIVEN';
  return 'INFORMATIONAL';
}

async function main() {
  const auth = await getAuth();

  console.log(`Fetching query data for ${args.site} (last ${DAYS} days)...`);
  const queries = await getQueryData(auth, args.site);
  console.log(`Total queries: ${queries.length}`);

  let existingTopics = new Set();
  if (args.dir) {
    console.log(`Scanning existing content in ${args.dir}...`);
    existingTopics = await getExistingTopics(args.dir);
    console.log(`Found ${existingTopics.size} topic keywords in existing content`);
  }

  const gaps = queries
    .filter(q => q.impressions >= MIN_IMPRESSIONS)
    .filter(q => q.position >= MIN_POSITION)
    .filter(q => !isExcluded(q.query))
    .filter(q => !hasDedicatedPage(q.query, existingTopics))
    .map(q => ({
      ...q,
      type: classifyOpportunity(q.query),
      score: Math.round(q.impressions * (1 / q.position) * 100),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N);

  console.log('\n=== QUERY GAP MINER ===\n');
  console.log(`Queries with ≥${MIN_IMPRESSIONS} impressions at position ≥${MIN_POSITION}:`);
  console.log(`Found ${gaps.length} content gaps\n`);

  if (gaps.length > 0) {
    console.log('--- CONTENT OPPORTUNITIES (highest ROI first) ---\n');
    for (const g of gaps) {
      console.log(`  [${g.type}] "${g.query}"`);
      console.log(`    ${g.impressions.toLocaleString()} impr | pos ${g.position} | ${g.clicks} clicks | score ${g.score}`);
      console.log();
    }

    const byType = {};
    for (const g of gaps) {
      byType[g.type] = (byType[g.type] || 0) + 1;
    }
    console.log('\n--- BY TYPE ---');
    for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${type}: ${count}`);
    }
  }

  if (args.output) {
    const { writeFile } = await import('node:fs/promises');
    const report = {
      generated: new Date().toISOString(),
      config: { minImpressions: MIN_IMPRESSIONS, minPosition: MIN_POSITION, days: DAYS },
      totalQueries: queries.length,
      gaps,
    };
    await writeFile(args.output, JSON.stringify(report, null, 2));
    console.log(`\nReport saved to ${args.output}`);
  }
}

main().catch(console.error);
