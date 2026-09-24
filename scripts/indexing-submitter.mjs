#!/usr/bin/env node

/**
 * Indexing API Submitter (JobPosting and livestream pages ONLY)
 *
 * ************************************************************************
 *  POLICY: Google's Indexing API may be used ONLY for pages that contain
 *  JobPosting structured data, or BroadcastEvent embedded in a VideoObject
 *  (livestreams). Google's docs state that other uses are not supported,
 *  that usage is monitored, and that access can be revoked for misuse.
 *  https://developers.google.com/search/apis/indexing-api/v3/quickstart
 *  This script is NOT a general "fast indexing" tool. Do not wire it into
 *  a publish pipeline for articles, blog posts or landing pages.
 * ************************************************************************
 *
 * For every other page, the supported ways to get content discovered are:
 *   - an accurate XML sitemap (listed in robots.txt and submitted in Search
 *     Console) with a truthful <lastmod> for each URL;
 *   - internal links from pages Google already crawls (hubs, category pages,
 *     the homepage);
 *   - for a handful of important URLs, Search Console's URL Inspection tool
 *     -> "Request indexing" (manual; it is rate-limited).
 *
 * What the script does:
 *   URL_UPDATED  Fetches each URL and parses its JSON-LD. The URL is submitted
 *                only if the page has a JobPosting node, or a VideoObject whose
 *                `publication` is a BroadcastEvent. Anything else is REFUSED.
 *   URL_DELETED  Submitted only if the URL now returns 404 or 410. Use it only
 *                for removed job or livestream pages (the type can no longer be
 *                verified once the page is gone).
 *
 * Quota: the default is 200 publish requests per day per Google Cloud
 * project (shared by every site that project submits for). The script
 * submits at most --max URLs per run (default 200, never more than 200).
 *
 * Requires (only when actually submitting): a Google Cloud project with the
 * Web Search Indexing API enabled, Application Default Credentials for a
 * service account, and that service account added as an Owner of the
 * Search Console property.
 *
 * Usage:
 *   node scripts/indexing-submitter.mjs --urls https://example.com/jobs/acme-engineer --dry-run
 *   node scripts/indexing-submitter.mjs --file job-urls.txt --output indexing.json
 *   node scripts/indexing-submitter.mjs --urls https://example.com/jobs/filled-role --type URL_DELETED
 *
 * Options:
 *   --urls URL[,URL]    Comma-separated URLs.
 *   --file FILE         One URL per line (# comments allowed).
 *   --type TYPE         URL_UPDATED (default) or URL_DELETED.
 *   --dry-run           Check eligibility only; submit nothing (no credentials needed).
 *   --max N             Maximum URLs to submit this run (default and hard cap 200).
 *   --timeout MS        Per-page fetch timeout in milliseconds (default 15000).
 *   --output FILE       Write a JSON report to FILE.
 *   --help              Show this help.
 *
 * Exit codes:
 *   0  every URL was eligible and submitted (or verified, with --dry-run)
 *   2  findings: at least one URL was refused as ineligible
 *   1  error: bad usage, a page could not be fetched, or the API rejected a submission
 */

import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';

export const DAILY_QUOTA = 200;
export const BANNER = [
  '*******************************************************************************',
  '* Google Indexing API policy: ONLY pages with JobPosting structured data, or  *',
  '* BroadcastEvent inside a VideoObject (livestreams). Other URLs are refused.  *',
  '* For all other pages: accurate sitemap + <lastmod>, internal links, and GSC  *',
  '* URL Inspection "Request indexing" for a handful of URLs.                    *',
  '* Quota: 200 publish requests per day per Google Cloud project.               *',
  '*******************************************************************************',
].join('\n');

const LD_RE = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
const typesOf = (n) => (Array.isArray(n?.['@type']) ? n['@type'] : n?.['@type'] ? [n['@type']] : []);

/** Flattened JSON-LD nodes from HTML (arrays and @graph expanded). Invalid blocks are skipped. */
export function jsonLdNodes(html) {
  const nodes = [];
  const add = (v) => {
    if (Array.isArray(v)) return v.forEach(add);
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v['@graph'])) v['@graph'].forEach(add);
    nodes.push(v);
  };
  for (const m of html.matchAll(LD_RE)) {
    try { add(JSON.parse(m[1].trim())); } catch { /* invalid JSON-LD cannot qualify a page */ }
  }
  return nodes;
}

/** Returns 'JobPosting' | 'BroadcastEvent' | null. */
export function eligibleType(html) {
  const nodes = jsonLdNodes(html);
  if (nodes.some((n) => typesOf(n).includes('JobPosting'))) return 'JobPosting';
  const isBroadcast = (p) => p && typeof p === 'object' && typesOf(p).includes('BroadcastEvent');
  for (const n of nodes) {
    if (!typesOf(n).includes('VideoObject')) continue;
    const pubs = Array.isArray(n.publication) ? n.publication : [n.publication];
    if (pubs.some(isBroadcast)) return 'BroadcastEvent';
  }
  return null;
}

/** Decide whether one URL may be submitted. */
export async function checkEligibility(url, type, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'ai-seo-playbook-indexing-check/1.0' } });
  } catch (e) {
    return { url, eligible: false, error: `fetch failed: ${e.cause?.code || e.message}` };
  }
  if (type === 'URL_DELETED') {
    await res.body?.cancel();
    return res.status === 404 || res.status === 410
      ? { url, eligible: true, reason: `returns ${res.status}` }
      : { url, eligible: false, refused: `URL_DELETED requires the page to return 404/410; it returns ${res.status}` };
  }
  if (!res.ok) { await res.body?.cancel(); return { url, eligible: false, error: `page returned HTTP ${res.status}` }; }
  const kind = eligibleType(await res.text());
  return kind
    ? { url, eligible: true, reason: kind }
    : { url, eligible: false, refused: 'no JobPosting or VideoObject+BroadcastEvent structured data found' };
}

async function submit(urls, type) {
  const { google } = await import('googleapis');
  const auth = await new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/indexing'] }).getClient();
  const out = [];
  for (const url of urls) {
    try {
      const res = await auth.request({ url: 'https://indexing.googleapis.com/v3/urlNotifications:publish', method: 'POST', data: { url, type } });
      out.push({ url, submitted: true, notifyTime: res.data?.urlNotificationMetadata?.latestUpdate?.notifyTime ?? null });
    } catch (err) {
      out.push({ url, submitted: false, error: err.response?.data?.error?.message || err.message });
    }
  }
  return out;
}

async function main() {
  const args = cli(import.meta.url, {
    urls: { type: 'string' },
    file: { type: 'string' },
    type: { type: 'string', default: 'URL_UPDATED' },
    'dry-run': { type: 'boolean', default: false },
    max: { type: 'string', default: String(DAILY_QUOTA) },
    timeout: { type: 'string', default: '15000' },
    output: { type: 'string' },
  });
  console.log(BANNER + '\n');
  if (!args.urls && !args.file) { console.error('Error: provide --urls or --file. Run with --help for usage.'); process.exit(1); }
  if (!['URL_UPDATED', 'URL_DELETED'].includes(args.type)) { console.error('Error: --type must be URL_UPDATED or URL_DELETED.'); process.exit(1); }
  const max = Math.min(DAILY_QUOTA, Math.max(1, parseInt(args.max, 10) || DAILY_QUOTA));
  const timeoutMs = Math.max(1000, parseInt(args.timeout, 10) || 15000);

  const list = args.file
    ? (await readFile(args.file, 'utf8')).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : args.urls.split(',').map((u) => u.trim()).filter(Boolean);
  const urls = [...new Set(list)];

  console.log(`Checking ${urls.length} URL(s) for ${args.type} eligibility...\n`);
  const checks = [];
  for (const u of urls) {
    const c = await checkEligibility(u, args.type, { timeoutMs });
    checks.push(c);
    console.log(`  ${c.eligible ? 'ELIGIBLE' : c.error ? 'ERROR   ' : 'REFUSED '} ${u}  (${c.reason || c.refused || c.error})`);
  }

  const eligible = checks.filter((c) => c.eligible).map((c) => c.url);
  const toSubmit = eligible.slice(0, max);
  if (eligible.length > max) console.log(`\n  ${eligible.length - max} eligible URL(s) held back: per-run cap is ${max} (quota: ${DAILY_QUOTA}/day per GCP project).`);

  let submissions = [];
  if (args['dry-run']) console.log('\nDry run: nothing submitted.');
  else if (toSubmit.length) {
    console.log(`\nSubmitting ${toSubmit.length} URL(s) as ${args.type}...`);
    submissions = await submit(toSubmit, args.type);
    for (const s of submissions) console.log(`  ${s.submitted ? 'OK  ' : 'FAIL'} ${s.url}${s.error ? `  (${s.error})` : ''}`);
  }

  const refused = checks.filter((c) => c.refused);
  const errors = checks.filter((c) => c.error).length + submissions.filter((s) => !s.submitted).length;
  console.log(`\nEligible: ${eligible.length}  Refused: ${refused.length}  Submitted: ${submissions.filter((s) => s.submitted).length}  Errors: ${errors}`);
  if (refused.length) console.log('Refused URLs are not eligible for the Indexing API. Use an accurate sitemap <lastmod>, internal links, or GSC URL Inspection "Request indexing".');

  if (args.output) {
    await writeFile(args.output, JSON.stringify({
      generated: new Date().toISOString(),
      policy: 'Indexing API is limited to JobPosting and BroadcastEvent-in-VideoObject pages; quota 200 publish requests/day per GCP project.',
      type: args.type,
      dryRun: args['dry-run'],
      checks,
      submissions,
      summary: { checked: checks.length, eligible: eligible.length, refused: refused.length, submitted: submissions.filter((s) => s.submitted).length, errors },
    }, null, 2) + '\n');
    console.log(`Report saved to ${args.output}`);
  }
  if (errors) process.exit(1);
  process.exit(refused.length ? 2 : 0);
}

function isMain() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isMain()) main().catch(fail);
