#!/usr/bin/env node

/**
 * Meta Length Checker
 *
 * Scans content files for titles exceeding 60 characters and meta
 * descriptions exceeding 160 characters. Google truncates both,
 * which hurts CTR and wastes the rewrite work you've already done.
 *
 * Usage:
 *   node scripts/meta-length-checker.mjs --dir ./content
 *
 * Works with:
 *   - Markdown frontmatter (title:, description:)
 *   - TypeScript/JSX metadata exports (Next.js)
 *   - HTML <title> and <meta name="description"> tags
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, extname } from 'path';

const DEFAULTS = {
  dir: './content',
  ext: null,
  maxTitle: 60,
  maxDescription: 160,
  output: null,
};

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { ...DEFAULTS };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const val = args[i + 1];
    if (key === 'dir') config.dir = val;
    else if (key === 'ext') config.ext = val.startsWith('.') ? val : `.${val}`;
    else if (key === 'max-title') config.maxTitle = Number(val);
    else if (key === 'max-description') config.maxDescription = Number(val);
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
    } catch { /* skip unreadable */ }
  }
  return files;
}

function extractMeta(content, filePath) {
  const ext = extname(filePath);
  let title = null;
  let description = null;

  if (ext === '.md' || ext === '.mdx') {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const fm = fmMatch[1];
      const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
      const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);
      if (titleMatch) title = titleMatch[1];
      if (descMatch) description = descMatch[1];
    }
  } else if (ext === '.tsx' || ext === '.ts' || ext === '.jsx' || ext === '.js') {
    // Next.js metadata export
    const titleMatch = content.match(/title:\s*["'`]([^"'`]+)["'`]/);
    const descMatch = content.match(/description:\s*["'`]([^"'`]+)["'`]/);
    if (titleMatch) title = titleMatch[1];
    if (descMatch) description = descMatch[1];
  } else if (ext === '.html') {
    const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
    const descMatch = content.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
    if (titleMatch) title = titleMatch[1];
    if (descMatch) description = descMatch[1];
  }

  return { title, description };
}

function main() {
  const config = parseArgs();
  const files = walkDir(config.dir, config.ext);

  console.log(`\nScanning ${files.length} files in ${config.dir}\n`);

  const violations = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const meta = extractMeta(content, file);

    const issues = [];

    if (meta.title && meta.title.length > config.maxTitle) {
      issues.push({
        field: 'title',
        value: meta.title,
        length: meta.title.length,
        limit: config.maxTitle,
        over: meta.title.length - config.maxTitle,
      });
    }

    if (meta.description && meta.description.length > config.maxDescription) {
      issues.push({
        field: 'description',
        value: meta.description,
        length: meta.description.length,
        limit: config.maxDescription,
        over: meta.description.length - config.maxDescription,
      });
    }

    if (issues.length > 0) {
      violations.push({ file, issues });
    }
  }

  // Sort by worst violations first
  violations.sort((a, b) => {
    const aMax = Math.max(...a.issues.map(i => i.over));
    const bMax = Math.max(...b.issues.map(i => i.over));
    return bMax - aMax;
  });

  const titleViolations = violations.filter(v => v.issues.some(i => i.field === 'title'));
  const descViolations = violations.filter(v => v.issues.some(i => i.field === 'description'));

  console.log('═'.repeat(60));
  console.log(' META LENGTH CHECK');
  console.log('═'.repeat(60));
  console.log(`\n  Files scanned:          ${files.length}`);
  console.log(`  Title violations:       ${titleViolations.length} (>${config.maxTitle} chars)`);
  console.log(`  Description violations: ${descViolations.length} (>${config.maxDescription} chars)`);
  console.log(`  Total violations:       ${violations.length}`);

  for (const v of violations) {
    console.log(`\n  ${v.file}`);
    for (const issue of v.issues) {
      console.log(`    ${issue.field}: ${issue.length} chars (+${issue.over} over)`);
      console.log(`    "${issue.value.substring(0, 70)}${issue.value.length > 70 ? '...' : ''}"`);
    }
  }

  if (config.output) {
    const { writeFileSync } = await import('fs');
    writeFileSync(config.output, JSON.stringify(violations, null, 2));
    console.log(`\n  Full report: ${config.output}`);
  }

  console.log('');

  // Exit non-zero for CI integration
  if (violations.length > 0) process.exit(1);
}

main();
