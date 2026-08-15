#!/usr/bin/env node

/**
 * GSC Title Rewrite Candidate Finder
 *
 * Pulls per-page query data from Google Search Console and identifies
 * pages with high rewrite potential: ranking in position 4–20 with
 * significant impressions but low CTR.
 *
 * Usage:
 *   node scripts/gsc-rewrite-candidates.mjs --site sc-domain:example.com
 *
 * Prerequisites:
 *   - Google Cloud project with Search Console API enabled
 *   - Application Default Credentials configured:
 *     gcloud auth application-default login --scopes=https://www.googleapis.com/auth/webmasters.readonly
 *
 * Output:
 *   Ranked list of rewrite candidates with their top queries,
 *   current title issues, and estimated opportunity.
 */

import { google } from 'googleapis';
import { readFileSync, writeFileSync } from 'fs';

const DEFAULTS = {
  site: null,
  minImpressions: 1000,
  maxCtr: 0.02,
  minPosition: 4,
  maxPosition: 20,
  days: 28,
  output: 'rewrite-candidates.json',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { ...DEFAULTS };

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const val = args[i + 1];
    if (key === 'site') config.site = val;
    else if (key === 'min-impressions') config.minImpressions = Number(val);
    else if (key === 'max-ctr') config.maxCtr = Number(val);
    else if (key === 'min-position') config.minPosition = Number(val);
    else if (key === 'max-position') config.maxPosition = Number(val);
    else if (key === 'days') config.days = Number(val);
    else if (key === 'output') config.output = val;
  }

  if (!config.site) {
    console.error('Usage: node gsc-rewrite-candidates.mjs --site sc-domain:example.com');
    console.error('\nOptions:');
    console.error('  --site              GSC property (required). e.g. sc-domain:example.com');
    console.error('  --min-impressions   Minimum impressions to qualify (default: 1000)');
    console.error('  --max-ctr           Maximum CTR to qualify as rewrite candidate (default: 0.02)');
    console.error('  --min-position      Minimum avg position (default: 4)');
    console.error('  --max-position      Maximum avg position (default: 20)');
    console.error('  --days              Lookback period in days (default: 28)');
    console.error('  --output            Output file path (default: rewrite-candidates.json)');
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

  console.log(`\nFetching page-level data for ${config.site}`);
  console.log(`Period: ${startDate} → ${endDate}\n`);

  // Step 1: Get all pages with their aggregate metrics
  const pageRes = await searchconsole.searchanalytics.query({
    siteUrl: config.site,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['page'],
      rowLimit: 5000,
      dataState: 'final',
    },
  });

  const pages = (pageRes.data.rows || [])
    .filter(r =>
      r.impressions >= config.minImpressions &&
      r.ctr <= config.maxCtr &&
      r.position >= config.minPosition &&
      r.position <= config.maxPosition
    )
    .sort((a, b) => b.impressions - a.impressions);

  console.log(`Found ${pages.length} rewrite candidates\n`);

  if (pages.length === 0) {
    console.log('No candidates found. Try adjusting --min-impressions or --max-ctr.');
    process.exit(0);
  }

  // Step 2: For each candidate, pull top queries
  const candidates = [];

  for (const page of pages) {
    const url = page.keys[0];
    console.log(`  Fetching queries for: ${url}`);

    const queryRes = await searchconsole.searchanalytics.query({
      siteUrl: config.site,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['query'],
        dimensionFilterGroups: [{
          filters: [{ dimension: 'page', expression: url, operator: 'equals' }],
        }],
        rowLimit: 20,
        dataState: 'final',
      },
    });

    const queries = (queryRes.data.rows || []).map(r => ({
      query: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: Math.round(r.ctr * 10000) / 100,
      position: Math.round(r.position * 10) / 10,
    }));

    // Classify query intent
    const intents = classifyQueries(queries);

    candidates.push({
      url,
      clicks: page.clicks,
      impressions: page.impressions,
      ctr: Math.round(page.ctr * 10000) / 100,
      position: Math.round(page.position * 10) / 10,
      rewriteScore: scoreRewritePotential(page, queries),
      topQueries: queries.slice(0, 10),
      queryIntents: intents,
      diagnosis: diagnose(page, queries, intents),
    });

    // Rate limiting: GSC API has quotas
    await new Promise(r => setTimeout(r, 200));
  }

  candidates.sort((a, b) => b.rewriteScore - a.rewriteScore);

  // Output
  writeFileSync(config.output, JSON.stringify(candidates, null, 2));
  console.log(`\nWrote ${candidates.length} candidates to ${config.output}\n`);

  // Print summary
  console.log('Top 15 rewrite candidates:\n');
  console.log('Score  Impr      CTR    Pos   URL');
  console.log('─'.repeat(80));

  for (const c of candidates.slice(0, 15)) {
    const score = String(c.rewriteScore).padStart(5);
    const impr = String(c.impressions.toLocaleString()).padStart(9);
    const ctr = `${c.ctr}%`.padStart(6);
    const pos = String(c.position).padStart(5);
    const url = c.url.replace(/^https?:\/\/[^/]+/, '');
    console.log(`${score}  ${impr}  ${ctr}  ${pos}   ${url}`);
    if (c.diagnosis) {
      console.log(`       → ${c.diagnosis}`);
    }
  }

  console.log(`\nFull results: ${config.output}`);
}

function scoreRewritePotential(page, queries) {
  let score = 0;

  // High impressions with low CTR = biggest opportunity
  score += Math.log10(page.impressions) * 20;

  // Position 4-10 has more rewrite potential than 10-20
  if (page.position <= 10) score += 30;
  else if (page.position <= 15) score += 15;

  // Very low CTR is a stronger signal
  if (page.ctr < 0.005) score += 20;
  else if (page.ctr < 0.01) score += 10;

  // Check for AI-overview dominated queries (machine-phrased)
  const aiQueries = queries.filter(q => isAiQuery(q.query));
  const aiRatio = queries.length > 0 ? aiQueries.length / queries.length : 0;

  // If >50% AI queries, rewriting won't help — lower the score
  if (aiRatio > 0.5) score -= 40;

  return Math.round(score);
}

function isAiQuery(query) {
  // Machine-phrased queries from AI assistants
  const signals = [
    /^\w{3,} \d{1,2} \d{4} /,         // Date-prefixed: "july 28 2026 ..."
    /latest$/i,                         // Ends with "latest"
    /\b(yes|no|true|false)\b/i,        // Boolean fragments
    query.split(' ').length > 12,       // Very long natural language
    /\d{4}.*\d{4}/,                    // Multiple years in one query
  ];
  return signals.filter(s => typeof s === 'boolean' ? s : s.test(query)).length >= 2;
}

function classifyQueries(queries) {
  const intents = { informational: 0, comparison: 0, transactional: 0, navigational: 0, ai_grounding: 0 };

  for (const q of queries) {
    const query = q.query.toLowerCase();
    if (isAiQuery(query)) intents.ai_grounding++;
    else if (/\bvs\b|compare|best|top \d|ranked|alternative/.test(query)) intents.comparison++;
    else if (/\bbuy\b|pricing|cost|how to get|sign up|free trial/.test(query)) intents.transactional++;
    else if (/\b(what|how|why|when|is |are |does )\b/.test(query)) intents.informational++;
    else intents.navigational++;
  }

  return intents;
}

function diagnose(page, queries, intents) {
  const total = Object.values(intents).reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  const aiRatio = intents.ai_grounding / total;
  if (aiRatio > 0.5) {
    return `⚠ ${Math.round(aiRatio * 100)}% AI-grounding queries — title rewrite unlikely to help. This is GEO traffic.`;
  }

  if (intents.comparison > intents.informational) {
    return 'Comparison intent dominant — consider adding "[X] vs [Y]" or "Best [X]" to the title.';
  }

  if (page.ctr === 0 && page.impressions > 50000) {
    return 'Zero clicks at 50K+ impressions — likely AI Overview or featured snippet fully answering the query.';
  }

  if (page.position <= 5 && page.ctr < 0.01) {
    return 'Top-5 position but <1% CTR — title may be answering the query. Tease, don\'t tell.';
  }

  return null;
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
