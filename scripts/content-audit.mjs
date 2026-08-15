#!/usr/bin/env node

/**
 * Content Audit Scorer
 *
 * Scores every page on your site into action buckets:
 *   KILL    — delete + 301 redirect (thin, duplicate, or harmful)
 *   MERGE   — consolidate with a stronger page on the same topic
 *   UPDATE  — rewrite title/content to improve ranking
 *   PROMOTE — already performing, boost with internal links
 *   KEEP    — healthy, no action needed
 *
 * Usage:
 *   node scripts/content-audit.mjs --site sc-domain:example.com --dir ./content
 *
 * Combines GSC performance data with on-page content analysis.
 */

import { google } from 'googleapis';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, extname, basename, dirname } from 'path';

const DEFAULTS = {
  site: null,
  dir: './content',
  ext: null,
  days: 28,
  output: 'content-audit.json',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { ...DEFAULTS };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const val = args[i + 1];
    if (key === 'site') config.site = val;
    else if (key === 'dir') config.dir = val;
    else if (key === 'ext') config.ext = val.startsWith('.') ? val : `.${val}`;
    else if (key === 'days') config.days = Number(val);
    else if (key === 'output') config.output = val;
  }
  if (!config.site) {
    console.error('Usage: node content-audit.mjs --site sc-domain:example.com --dir ./content');
    process.exit(1);
  }
  return config;
}

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

function walkDir(dir, ext) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walkDir(full, ext));
    else if (!ext || extname(full) === ext) files.push(full);
  }
  return files;
}

function extractSlug(filePath) {
  const dir = basename(dirname(filePath));
  const file = basename(filePath, extname(filePath));
  if (file === 'page') return dir;
  return file;
}

function analyzeContent(content) {
  const text = content
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/import\s.+/g, '')
    .replace(/export\s.+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const words = text.split(/\s+/).filter(w => w.length > 1);
  const wordCount = words.length;

  // Check for thin content
  const isThin = wordCount < 300;

  // Check for template phrases (AI fingerprints)
  const templatePhrases = [
    /the (?:short|quick) answer/gi,
    /longer answer is (?:more )?interesting/gi,
    /let's (?:dive|dig|break|unpack)/gi,
    /it's worth noting/gi,
    /what to watch:/gi,
    /bottom line:/gi,
    /only time will tell/gi,
  ];

  let templateCount = 0;
  for (const pattern of templatePhrases) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    if (matches) templateCount += matches.length;
  }

  // Check for external links
  const externalLinks = (content.match(/href="https?:\/\/(?!example\.com)[^"]+"/g) || []).length;

  // Check for schema markup
  const hasSchema = /application\/ld\+json|jsonLd|articleSchema|faqSchema/.test(content);

  // Check for images
  const imageCount = (content.match(/<img |<Image |next\/image/g) || []).length;

  return {
    wordCount,
    isThin,
    templateCount,
    externalLinks,
    hasSchema,
    imageCount,
  };
}

async function main() {
  const config = parseArgs();
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  const sc = google.searchconsole({ version: 'v1', auth });

  const startDate = dateStr(config.days);
  const endDate = dateStr(1);

  // Get GSC page data
  console.log(`\nFetching GSC data for ${config.site}...`);
  const gscRes = await sc.searchanalytics.query({
    siteUrl: config.site,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['page'],
      rowLimit: 5000,
      dataState: 'final',
    },
  });

  const gscPages = new Map();
  for (const row of gscRes.data.rows || []) {
    const url = row.keys[0];
    const slug = url.split('/').filter(Boolean).pop();
    gscPages.set(slug, {
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    });
  }

  // Scan content files
  const files = walkDir(config.dir, config.ext);
  console.log(`Scanning ${files.length} content files...\n`);

  const results = [];
  const buckets = { KILL: 0, MERGE: 0, UPDATE: 0, PROMOTE: 0, KEEP: 0 };

  for (const file of files) {
    const slug = extractSlug(file);
    const content = readFileSync(file, 'utf-8');
    const analysis = analyzeContent(content);
    const gsc = gscPages.get(slug) || { clicks: 0, impressions: 0, ctr: 0, position: 0 };

    const bucket = classify(gsc, analysis);
    const reasons = getReasons(gsc, analysis, bucket);

    buckets[bucket]++;
    results.push({
      slug,
      file,
      bucket,
      reasons,
      gsc: {
        clicks: gsc.clicks,
        impressions: gsc.impressions,
        ctr: Math.round(gsc.ctr * 10000) / 100,
        position: Math.round(gsc.position * 10) / 10,
      },
      content: analysis,
    });
  }

  results.sort((a, b) => {
    const order = { KILL: 0, MERGE: 1, UPDATE: 2, PROMOTE: 3, KEEP: 4 };
    return (order[a.bucket] - order[b.bucket]) || (b.gsc.impressions - a.gsc.impressions);
  });

  writeFileSync(config.output, JSON.stringify(results, null, 2));

  // Report
  console.log('═'.repeat(60));
  console.log(' CONTENT AUDIT RESULTS');
  console.log('═'.repeat(60));
  console.log(`\n  Total pages:  ${files.length}`);
  console.log(`  KILL:         ${buckets.KILL}`);
  console.log(`  MERGE:        ${buckets.MERGE}`);
  console.log(`  UPDATE:       ${buckets.UPDATE}`);
  console.log(`  PROMOTE:      ${buckets.PROMOTE}`);
  console.log(`  KEEP:         ${buckets.KEEP}`);

  for (const bucket of ['KILL', 'MERGE', 'UPDATE', 'PROMOTE']) {
    const items = results.filter(r => r.bucket === bucket);
    if (items.length > 0) {
      console.log(`\n  ${bucket} (${items.length}):`);
      for (const item of items.slice(0, 10)) {
        console.log(`    ${item.slug}`);
        for (const reason of item.reasons) {
          console.log(`      → ${reason}`);
        }
      }
      if (items.length > 10) console.log(`    ... and ${items.length - 10} more`);
    }
  }

  console.log(`\n  Full audit: ${config.output}\n`);
}

function classify(gsc, analysis) {
  // KILL: thin content with no traffic
  if (analysis.isThin && gsc.clicks === 0 && gsc.impressions < 50) return 'KILL';

  // KILL: heavy template fingerprints with no traffic
  if (analysis.templateCount >= 3 && gsc.clicks === 0) return 'KILL';

  // MERGE: low traffic, likely cannibalized (heuristic — use cannibalization-detector for definitive answer)
  if (gsc.impressions > 100 && gsc.impressions < 500 && gsc.ctr < 0.005) return 'MERGE';

  // UPDATE: good impressions, bad CTR
  if (gsc.impressions >= 1000 && gsc.ctr < 0.02 && gsc.position >= 4 && gsc.position <= 20) return 'UPDATE';

  // PROMOTE: good traffic, deserves more internal links
  if (gsc.clicks >= 10 && gsc.ctr >= 0.01) return 'PROMOTE';

  return 'KEEP';
}

function getReasons(gsc, analysis, bucket) {
  const reasons = [];

  if (analysis.isThin) reasons.push(`Thin content: ${analysis.wordCount} words`);
  if (analysis.templateCount >= 2) reasons.push(`${analysis.templateCount} template phrases detected`);
  if (analysis.externalLinks === 0) reasons.push('No external links (citation gap)');
  if (!analysis.hasSchema) reasons.push('Missing structured data / schema');
  if (analysis.imageCount === 0) reasons.push('No images');
  if (gsc.clicks === 0 && gsc.impressions > 0) reasons.push(`${gsc.impressions} impressions, 0 clicks`);
  if (bucket === 'UPDATE') reasons.push(`Title rewrite candidate: pos ${Math.round(gsc.position * 10) / 10}, ${Math.round(gsc.ctr * 10000) / 100}% CTR`);
  if (bucket === 'PROMOTE') reasons.push(`High performer: ${gsc.clicks} clicks. Boost with internal links.`);

  return reasons;
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
