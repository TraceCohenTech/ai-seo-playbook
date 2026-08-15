#!/usr/bin/env node

/**
 * Internal Link Orphan Finder
 *
 * Scans your content files to find pages with zero inbound internal links.
 * These "orphan" pages are invisible to Google's link-graph crawler and
 * will rank poorly regardless of content quality.
 *
 * Usage:
 *   node scripts/orphan-finder.mjs --dir ./src/app/blog --base https://example.com
 *
 * What it does:
 *   1. Crawls all content files and extracts internal links
 *   2. Builds an inbound link count for every page
 *   3. Reports pages with zero or very few inbound links
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, extname, basename, dirname } from 'path';

const DEFAULTS = {
  dir: './content',
  base: '',
  ext: null,
};

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { ...DEFAULTS };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const val = args[i + 1];
    if (key === 'dir') config.dir = val;
    else if (key === 'base') config.base = val.replace(/\/$/, '');
    else if (key === 'ext') config.ext = val.startsWith('.') ? val : `.${val}`;
  }
  return config;
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
  // Next.js [slug] convention: directory name is the slug
  if (file === 'page') return dir;
  // Flat file convention: filename is the slug
  return file;
}

function extractLinks(content, base) {
  const links = new Set();
  // href="/path" or href="https://base/path"
  const hrefPattern = /href=["']([^"']+)["']/g;
  let match;
  while ((match = hrefPattern.exec(content)) !== null) {
    let url = match[1];
    // Normalize to path
    if (base && url.startsWith(base)) url = url.slice(base.length);
    if (url.startsWith('/') && !url.startsWith('//')) {
      // Extract slug from path
      const slug = url.split('/').filter(Boolean).pop();
      if (slug && !slug.includes('.') && !slug.startsWith('#')) {
        links.add(slug);
      }
    }
  }
  // Also check for slug references in relatedPosts arrays etc
  const relatedPattern = /['"]([a-z0-9](?:[a-z0-9-]*[a-z0-9]))['"]/g;
  while ((match = relatedPattern.exec(content)) !== null) {
    const slug = match[1];
    if (slug.length > 5 && slug.includes('-')) {
      links.add(slug);
    }
  }
  return links;
}

function main() {
  const config = parseArgs();
  const files = walkDir(config.dir, config.ext);

  if (files.length === 0) {
    console.error(`No files found in ${config.dir}`);
    process.exit(1);
  }

  console.log(`\nScanning ${files.length} files for internal links\n`);

  // Build the link graph
  const allSlugs = new Set();
  const inboundCount = new Map();
  const outboundLinks = new Map();

  // First pass: identify all slugs
  for (const file of files) {
    const slug = extractSlug(file);
    allSlugs.add(slug);
    inboundCount.set(slug, 0);
  }

  // Second pass: count inbound links
  for (const file of files) {
    const sourceSlug = extractSlug(file);
    const content = readFileSync(file, 'utf-8');
    const links = extractLinks(content, config.base);
    const validLinks = new Set();

    for (const targetSlug of links) {
      if (targetSlug !== sourceSlug && allSlugs.has(targetSlug)) {
        validLinks.add(targetSlug);
        inboundCount.set(targetSlug, (inboundCount.get(targetSlug) || 0) + 1);
      }
    }
    outboundLinks.set(sourceSlug, validLinks.size);
  }

  // Find orphans
  const orphans = [...inboundCount.entries()]
    .filter(([, count]) => count === 0)
    .map(([slug]) => slug)
    .sort();

  const lowLink = [...inboundCount.entries()]
    .filter(([, count]) => count === 1)
    .map(([slug]) => slug)
    .sort();

  // Report
  console.log('═'.repeat(60));
  console.log(' INTERNAL LINK AUDIT');
  console.log('═'.repeat(60));

  console.log(`\n  Total pages:          ${allSlugs.size}`);
  console.log(`  Orphans (0 links):    ${orphans.length} (${Math.round(orphans.length / allSlugs.size * 100)}%)`);
  console.log(`  Low-link (1 link):    ${lowLink.length}`);
  console.log(`  Well-linked (2+):     ${allSlugs.size - orphans.length - lowLink.length}`);

  if (orphans.length > 0) {
    console.log(`\n  ORPHAN PAGES (zero inbound internal links):\n`);
    for (const slug of orphans) {
      const outbound = outboundLinks.get(slug) || 0;
      console.log(`    ${slug}  (${outbound} outbound links)`);
    }
  }

  if (lowLink.length > 0 && lowLink.length <= 30) {
    console.log(`\n  LOW-LINK PAGES (only 1 inbound link):\n`);
    for (const slug of lowLink) {
      console.log(`    ${slug}`);
    }
  }

  // Recommendations
  console.log('\n' + '═'.repeat(60));
  console.log(' RECOMMENDATIONS');
  console.log('═'.repeat(60));

  if (orphans.length > 0) {
    console.log(`\n  1. Add at least 2 internal links TO each orphan page from`);
    console.log('     related content. Prioritize high-traffic pages as link sources.');
    console.log(`\n  2. Set up a daily/weekly cron to work through the orphan list`);
    console.log('     at 8-10 pages per run. See the guide for the linking queue pattern.');
  }

  const noOutbound = [...outboundLinks.entries()].filter(([, c]) => c === 0).length;
  if (noOutbound > 0) {
    console.log(`\n  3. ${noOutbound} pages have zero outbound internal links.`);
    console.log('     These are dead ends — add related content links to keep');
    console.log('     readers (and crawlers) moving through the site.');
  }

  console.log('');
}

main();
