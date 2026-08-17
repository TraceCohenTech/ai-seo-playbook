#!/usr/bin/env node

/**
 * AI Citation Tracker
 *
 * Checks whether your site's pages are being cited by AI search engines
 * (Perplexity, ChatGPT search, etc.) by searching for your domain across
 * key queries.
 *
 * This is the newest, hardest-to-track SEO metric. AI citations don't
 * show up in GSC — you have to actively search for them. This script
 * automates that process.
 *
 * Usage:
 *   node scripts/ai-citation-tracker.mjs --domain yoursite.com --queries queries.txt
 *   node scripts/ai-citation-tracker.mjs --domain yoursite.com --site sc-domain:yoursite.com
 *   node scripts/ai-citation-tracker.mjs --domain yoursite.com --queries queries.txt --output citations.json
 *
 * Query sources (pick one):
 *   --queries   A text file with one search query per line
 *   --site      Pull your top queries from GSC automatically
 *
 * Note: This script searches via Perplexity's public search. For comprehensive
 * tracking across ChatGPT/Claude/Gemini, consider supplementing with manual
 * checks on each platform weekly.
 */

import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { google } from 'googleapis';

const { values: args } = parseArgs({
  options: {
    domain: { type: 'string' },
    queries: { type: 'string' },
    site: { type: 'string' },
    'top-n': { type: 'string', default: '30' },
    output: { type: 'string' },
  },
});

if (!args.domain) {
  console.error('Usage: node scripts/ai-citation-tracker.mjs --domain yoursite.com [--queries file.txt | --site sc-domain:yoursite.com]');
  process.exit(1);
}

if (!args.queries && !args.site) {
  console.error('Provide either --queries (text file) or --site (GSC property) for query source');
  process.exit(1);
}

const TOP_N = parseInt(args['top-n']);

async function getQueriesFromFile(filePath) {
  const content = await readFile(filePath, 'utf-8');
  return content.split('\n').map(q => q.trim()).filter(q => q.length > 0 && !q.startsWith('#'));
}

async function getQueriesFromGsc(site) {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  const sc = google.searchconsole({ version: 'v1', auth });

  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 28);

  const res = await sc.searchanalytics.query({
    siteUrl: site,
    requestBody: {
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      dimensions: ['query'],
      rowLimit: TOP_N,
    },
  });

  return (res.data.rows || []).map(r => r.keys[0]);
}

async function checkPerplexity(query, domain) {
  const searchUrl = `https://www.perplexity.ai/search?q=${encodeURIComponent(query)}`;

  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });

    const html = await res.text();
    const domainMentioned = html.includes(domain);
    const domainLinked = html.includes(`href`) && html.includes(domain);

    return {
      query,
      platform: 'perplexity',
      cited: domainMentioned,
      linked: domainLinked,
      url: searchUrl,
    };
  } catch (err) {
    return {
      query,
      platform: 'perplexity',
      cited: false,
      error: err.message,
    };
  }
}

async function checkGoogle(query, domain) {
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query + ' site:' + domain)}`;

  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(15000),
    });

    const html = await res.text();
    const hasAiOverview = html.includes('ai-overview') || html.includes('AI Overview');

    return {
      query,
      platform: 'google',
      hasAiOverview,
    };
  } catch {
    return { query, platform: 'google', hasAiOverview: false };
  }
}

async function main() {
  console.log(`AI Citation Tracker — ${args.domain}\n`);

  const queries = args.queries
    ? await getQueriesFromFile(args.queries)
    : await getQueriesFromGsc(args.site);

  console.log(`Checking ${queries.length} queries for AI citations...\n`);

  const results = [];
  const batchSize = 3;

  for (let i = 0; i < queries.length; i += batchSize) {
    const batch = queries.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(q => checkPerplexity(q, args.domain))
    );
    results.push(...batchResults);
    process.stderr.write(`\rChecked ${Math.min(i + batchSize, queries.length)}/${queries.length}`);

    if (i + batchSize < queries.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  console.log('\n');

  const cited = results.filter(r => r.cited);
  const notCited = results.filter(r => !r.cited && !r.error);
  const errors = results.filter(r => r.error);

  console.log('═'.repeat(60));
  console.log(' AI CITATION REPORT');
  console.log('═'.repeat(60));

  console.log(`\n  Domain:         ${args.domain}`);
  console.log(`  Queries tested: ${results.length}`);
  console.log(`  Cited:          ${cited.length} (${Math.round(cited.length / results.length * 100)}%)`);
  console.log(`  Not cited:      ${notCited.length}`);
  if (errors.length > 0) {
    console.log(`  Errors:         ${errors.length}`);
  }

  if (cited.length > 0) {
    console.log('\n── CITED QUERIES ──\n');
    for (const r of cited) {
      console.log(`  ✓ "${r.query}"${r.linked ? ' (linked)' : ' (mentioned)'}`);
    }
  }

  if (notCited.length > 0) {
    console.log('\n── NOT CITED (AEO optimization opportunities) ──\n');
    for (const r of notCited.slice(0, 20)) {
      console.log(`  ✗ "${r.query}"`);
    }
    console.log('\n  To improve citation rate:');
    console.log('  1. Add quick-answer blocks at page top (2-3 sentences, lead with number)');
    console.log('  2. Increase factual density to 3+ stats per 1K words');
    console.log('  3. Add FAQPage + Dataset schema');
    console.log('  4. Ensure entity clarity — name the who/what behind every claim');
  }

  if (args.output) {
    const report = {
      generated: new Date().toISOString(),
      domain: args.domain,
      summary: {
        queriesTested: results.length,
        cited: cited.length,
        citationRate: Math.round(cited.length / results.length * 100),
      },
      cited: cited.map(r => ({ query: r.query, linked: r.linked })),
      notCited: notCited.map(r => r.query),
    };
    await writeFile(args.output, JSON.stringify(report, null, 2));
    console.log(`\nReport saved to ${args.output}`);
  }

  console.log('');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
