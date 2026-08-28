#!/usr/bin/env node

/**
 * Thin Content Detector
 *
 * Identifies pages that should be noindexed to protect crawl budget
 * and prevent Google's "crawled — currently not indexed" problem.
 *
 * Thin content dilutes your site's quality signal. Google has limited
 * crawl budget — every thin page it crawls is a page it didn't spend
 * on your good content. Noindexing thin pages concentrates authority.
 *
 * Usage:
 *   node scripts/thin-content-detector.mjs --dir ./content
 *
 * The script identifies three categories:
 *   1. Word count below threshold (default: 300 words)
 *   2. Hub/category pages with too few child items (default: <3)
 *   3. Pages that are mostly boilerplate (nav/footer/chrome > content)
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, extname, basename, dirname } from 'path';

const DEFAULTS = {
  dir: './content',
  ext: null,
  minWords: 300,
  minChildren: 3,
  maxBoilerplateRatio: 0.6,
  output: 'thin-content.json',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { ...DEFAULTS };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const val = args[i + 1];
    if (key === 'dir') config.dir = val;
    else if (key === 'ext') config.ext = val.startsWith('.') ? val : `.${val}`;
    else if (key === 'min-words') config.minWords = Number(val);
    else if (key === 'min-children') config.minChildren = Number(val);
    else if (key === 'output') config.output = val;
  }
  return config;
}

function walkDir(dir, ext) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory() && !entry.startsWith('.') && entry !== 'node_modules') {
        files.push(...walkDir(full, ext));
      } else if (!ext || extname(full) === ext) {
        files.push(full);
      }
    } catch { /* skip */ }
  }
  return files;
}

function stripCode(content) {
  return content
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/import\s+.*?(?:from\s+)?['"][^'"]+['"];?/g, '')
    .replace(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class)\s/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function analyzeFile(filePath, content) {
  const text = stripCode(content);
  const words = text.split(/\s+/).filter(w => w.length > 2);
  const wordCount = words.length;

  // Detect hub/category pages (contain lists of links but little prose)
  const linkCount = (content.match(/href=/gi) || []).length;
  const isHub = linkCount > 10 && wordCount < 500;

  // Detect boilerplate ratio (imports, exports, JSX chrome vs actual text)
  const totalLines = content.split('\n').length;
  const codeLines = content.split('\n').filter(l =>
    /^\s*(import |export |const |let |var |function |return |<\/|<[A-Z])/.test(l)
  ).length;
  const boilerplateRatio = totalLines > 0 ? codeLines / totalLines : 0;

  const issues = [];

  if (wordCount < 300) {
    issues.push({
      type: 'thin',
      detail: `${wordCount} words (minimum: 300)`,
      severity: wordCount < 100 ? 'critical' : 'warning',
    });
  }

  if (isHub) {
    issues.push({
      type: 'hub_thin',
      detail: `Hub page with ${linkCount} links but only ${wordCount} words of prose`,
      severity: 'warning',
    });
  }

  if (boilerplateRatio > 0.6 && wordCount < 500) {
    issues.push({
      type: 'boilerplate',
      detail: `${Math.round(boilerplateRatio * 100)}% boilerplate code, ${wordCount} words of content`,
      severity: 'warning',
    });
  }

  return { wordCount, linkCount, boilerplateRatio, issues };
}

function main() {
  const config = parseArgs();
  const files = walkDir(config.dir, config.ext);

  console.log(`\nScanning ${files.length} files for thin content...\n`);

  const results = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const analysis = analyzeFile(file, content);

    if (analysis.issues.length > 0) {
      results.push({
        file,
        wordCount: analysis.wordCount,
        ...analysis,
        recommendation: analysis.issues.some(i => i.severity === 'critical')
          ? 'NOINDEX'
          : 'REVIEW',
      });
    }
  }

  results.sort((a, b) => a.wordCount - b.wordCount);

  const critical = results.filter(r => r.recommendation === 'NOINDEX');
  const review = results.filter(r => r.recommendation === 'REVIEW');

  console.log('═'.repeat(60));
  console.log(' THIN CONTENT REPORT');
  console.log('═'.repeat(60));
  console.log(`\n  Files scanned:     ${files.length}`);
  console.log(`  Thin pages found:  ${results.length}`);
  console.log(`  NOINDEX (critical): ${critical.length}`);
  console.log(`  REVIEW (warning):   ${review.length}`);

  for (const tier of [
    { label: 'NOINDEX — these pages hurt your crawl budget', items: critical },
    { label: 'REVIEW — may need content or noindex', items: review },
  ]) {
    if (tier.items.length === 0) continue;
    console.log(`\n  ${tier.label}:`);
    for (const r of tier.items.slice(0, 20)) {
      console.log(`    ${r.file} (${r.wordCount} words)`);
      for (const issue of r.issues) {
        console.log(`      → ${issue.detail}`);
      }
    }
    if (tier.items.length > 20) console.log(`    ... and ${tier.items.length - 20} more`);
  }

  writeFileSync(config.output, JSON.stringify(results, null, 2));
  console.log(`\n  Full report: ${config.output}\n`);
}

main();
