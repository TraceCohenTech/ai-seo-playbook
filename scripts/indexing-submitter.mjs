#!/usr/bin/env node

/**
 * Indexing API Submitter
 *
 * Submits URLs directly to Google's Indexing API for immediate crawling.
 * This is faster than WebSub — Google typically processes these within
 * minutes. Originally designed for job posting pages, but works for
 * any content where speed matters.
 *
 * Requires: Google Cloud project with Indexing API enabled + service
 * account added as site owner in Search Console.
 *
 * Usage:
 *   node scripts/indexing-submitter.mjs --urls https://example.com/blog/breaking-news
 *   node scripts/indexing-submitter.mjs --file urls.txt
 *   node scripts/indexing-submitter.mjs --urls https://example.com/page1,https://example.com/page2 --type URL_DELETED
 *
 * The urls.txt file should have one URL per line (# comments allowed).
 *
 * Rate limit: 200 URLs per day per property.
 */

import { google } from 'googleapis';
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';

const { values: args } = parseArgs({
  options: {
    urls: { type: 'string' },
    file: { type: 'string' },
    type: { type: 'string', default: 'URL_UPDATED' },
    output: { type: 'string' },
  },
});

if (!args.urls && !args.file) {
  console.error('Usage:');
  console.error('  node scripts/indexing-submitter.mjs --urls URL1,URL2');
  console.error('  node scripts/indexing-submitter.mjs --file urls.txt');
  process.exit(1);
}

const VALID_TYPES = ['URL_UPDATED', 'URL_DELETED'];
if (!VALID_TYPES.includes(args.type)) {
  console.error(`--type must be one of: ${VALID_TYPES.join(', ')}`);
  process.exit(1);
}

async function getAuth() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/indexing'],
  });
  return auth.getClient();
}

async function getUrls() {
  if (args.file) {
    const content = await readFile(args.file, 'utf-8');
    return content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  }
  return args.urls.split(',').map(u => u.trim());
}

async function main() {
  const urls = await getUrls();
  const auth = await getAuth();

  console.log(`Submitting ${urls.length} URL(s) as ${args.type}...\n`);

  if (urls.length > 200) {
    console.warn(`Warning: Google allows 200 submissions per day. You have ${urls.length} URLs.`);
    console.warn('Only the first 200 will be submitted.\n');
  }

  const results = [];
  const batch = urls.slice(0, 200);

  for (const url of batch) {
    try {
      const res = await auth.request({
        url: 'https://indexing.googleapis.com/v3/urlNotifications:publish',
        method: 'POST',
        data: { url, type: args.type },
      });

      const status = res.data?.urlNotificationMetadata?.latestUpdate?.type || 'SUBMITTED';
      console.log(`  OK   ${url} → ${status}`);
      results.push({ url, status: 'OK', type: status });
    } catch (err) {
      const message = err.response?.data?.error?.message || err.message;
      console.log(`  FAIL ${url} → ${message}`);
      results.push({ url, status: 'FAIL', error: message });
    }
  }

  const ok = results.filter(r => r.status === 'OK').length;
  const failed = results.filter(r => r.status === 'FAIL').length;

  console.log(`\n--- SUMMARY ---`);
  console.log(`  Submitted: ${ok}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Remaining daily quota: ~${200 - ok}`);

  if (args.output) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(args.output, JSON.stringify({
      generated: new Date().toISOString(),
      type: args.type,
      results,
      summary: { submitted: ok, failed, quotaRemaining: 200 - ok },
    }, null, 2));
    console.log(`\nReport saved to ${args.output}`);
  }
}

main().catch(console.error);
