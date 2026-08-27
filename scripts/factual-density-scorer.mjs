#!/usr/bin/env node

/**
 * Factual Density Scorer
 *
 * Scores content files by their "factual density" — the ratio of specific,
 * verifiable data points (numbers, dollar amounts, percentages, dates,
 * named entities) to total word count.
 *
 * Why this matters: AI engines (Perplexity, ChatGPT, Claude) cite pages
 * with high factual density 3-5x more often than opinion-heavy pages.
 * Google's helpful content system also rewards specificity over fluff.
 *
 * The guide's minimum threshold: at least 1 specific number per paragraph,
 * at least 3 stats per 1,000 words.
 *
 * Usage:
 *   node scripts/factual-density-scorer.mjs --dir ./content
 *   node scripts/factual-density-scorer.mjs --dir ./src/app/blog --threshold 3
 *   node scripts/factual-density-scorer.mjs --dir ./content --output density-report.json
 */

import { parseArgs } from 'node:util';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string' },
    threshold: { type: 'string', default: '3' },
    output: { type: 'string' },
    ext: { type: 'string' },
  },
});

if (!args.dir) {
  console.error('Usage: node scripts/factual-density-scorer.mjs --dir ./content');
  process.exit(1);
}

const THRESHOLD = parseFloat(args.threshold);

const FACT_PATTERNS = [
  // Dollar amounts: $1.5B, $347M, $6.6 billion
  /\$[\d,.]+\s*(?:billion|million|trillion|B|M|T|K)?/gi,
  // Percentages: 42%, 3.2%
  /\d+\.?\d*%/g,
  // Multipliers: 302,667x, 3.5x
  /[\d,.]+x\b/gi,
  // Large numbers with commas: 4,620,000
  /\b\d{1,3}(?:,\d{3})+\b/g,
  // Explicit amounts: 6.6 billion, 14 million
  /\b\d+\.?\d*\s+(?:billion|million|trillion|thousand|hundred)\b/gi,
  // Year references: 2024, 2025, Q1 2026
  /\b(?:Q[1-4]\s+)?20[1-3]\d\b/g,
  // Dates: January 15, March 2026
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,?\s+\d{4})?\b/gi,
  // Ratios: 3:1, 10-to-1
  /\b\d+(?::\d+|-to-\d+)\b/g,
  // Funding rounds: Series A, Series B
  /\bSeries\s+[A-F]\b/gi,
];

const ENTITY_PATTERNS = [
  // Company names with Inc/Corp/Ltd
  /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Inc|Corp|Ltd|LLC|Co)\b/g,
  // Known financial entities (common in VC/tech content)
  /\b(?:NASDAQ|NYSE|S&P|SEC|IPO|SPAC)\b/g,
];

function extractText(content, ext) {
  if (ext === '.tsx' || ext === '.jsx') {
    return content
      .replace(/^import\s.+$/gm, '')
      .replace(/^export\s.+$/gm, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/className="[^"]*"/g, '')
      .replace(/\s+/g, ' ');
  }
  if (ext === '.md' || ext === '.mdx') {
    return content
      .replace(/^---[\s\S]*?---/m, '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/!\[.*?\]\(.*?\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/#{1,6}\s/g, '')
      .replace(/[*_`~]/g, '');
  }
  return content;
}

function countFacts(text) {
  const allMatches = new Set();

  for (const pattern of FACT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      allMatches.add(`${match.index}:${match[0]}`);
    }
  }

  return allMatches.size;
}

function countEntities(text) {
  let count = 0;
  for (const pattern of ENTITY_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      count++;
    }
  }
  return count;
}

function scoreParagraphs(text) {
  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 50);
  let emptyParagraphs = 0;

  for (const p of paragraphs) {
    const facts = countFacts(p);
    if (facts === 0) emptyParagraphs++;
  }

  return {
    total: paragraphs.length,
    withoutFacts: emptyParagraphs,
    pctEmpty: paragraphs.length > 0 ? Math.round((emptyParagraphs / paragraphs.length) * 100) : 0,
  };
}

async function walkDir(dir, ext) {
  const files = [];
  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        await walk(fullPath);
      } else {
        const fileExt = extname(entry.name);
        if (ext) {
          if (fileExt === (ext.startsWith('.') ? ext : `.${ext}`)) files.push(fullPath);
        } else if (['.md', '.mdx', '.tsx', '.jsx', '.html'].includes(fileExt)) {
          files.push(fullPath);
        }
      }
    }
  }
  await walk(dir);
  return files;
}

async function main() {
  const files = await walkDir(args.dir, args.ext);

  if (files.length === 0) {
    console.error(`No files found in ${args.dir}`);
    process.exit(1);
  }

  console.log(`\nScoring factual density for ${files.length} files in ${args.dir}\n`);

  const results = [];

  for (const file of files) {
    const raw = await readFile(file, 'utf-8');
    const ext = extname(file);
    const text = extractText(raw, ext);
    const wordCount = text.split(/\s+/).filter(Boolean).length;

    if (wordCount < 50) continue;

    const factCount = countFacts(text);
    const entityCount = countEntities(text);
    const densityPer1K = Math.round((factCount / wordCount) * 10000) / 10;
    const paragraphs = scoreParagraphs(text);

    results.push({
      file,
      wordCount,
      factCount,
      entityCount,
      densityPer1K,
      paragraphs,
      grade: densityPer1K >= THRESHOLD * 2 ? 'A' :
             densityPer1K >= THRESHOLD ? 'B' :
             densityPer1K >= THRESHOLD * 0.5 ? 'C' :
             densityPer1K > 0 ? 'D' : 'F',
    });
  }

  results.sort((a, b) => a.densityPer1K - b.densityPer1K);

  const avgDensity = results.length > 0
    ? Math.round(results.reduce((sum, r) => sum + r.densityPer1K, 0) / results.length * 10) / 10
    : 0;

  const belowThreshold = results.filter(r => r.densityPer1K < THRESHOLD);
  const gradeDistrib = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const r of results) gradeDistrib[r.grade]++;

  console.log('═'.repeat(60));
  console.log(' FACTUAL DENSITY REPORT');
  console.log('═'.repeat(60));

  console.log(`\n  Files scored:       ${results.length}`);
  console.log(`  Avg density:        ${avgDensity} facts per 1K words`);
  console.log(`  Threshold:          ${THRESHOLD} per 1K words`);
  console.log(`  Below threshold:    ${belowThreshold.length} (${Math.round(belowThreshold.length / results.length * 100)}%)`);
  console.log(`  Grades:             A:${gradeDistrib.A}  B:${gradeDistrib.B}  C:${gradeDistrib.C}  D:${gradeDistrib.D}  F:${gradeDistrib.F}`);

  if (belowThreshold.length > 0) {
    console.log('\n── LOWEST DENSITY (prioritize these for AEO optimization) ──\n');
    for (const r of belowThreshold.slice(0, 20)) {
      console.log(`  ${r.grade}  ${String(r.densityPer1K).padStart(4)}/1K  ${String(r.factCount).padStart(3)} facts  ${String(r.wordCount).padStart(5)} words  ${r.file}`);
      if (r.paragraphs.pctEmpty > 50) {
        console.log(`     ↳ ${r.paragraphs.pctEmpty}% of paragraphs have zero data points`);
      }
    }
  }

  console.log('\n── TOP DENSITY ──\n');
  for (const r of results.slice(-10).reverse()) {
    console.log(`  ${r.grade}  ${String(r.densityPer1K).padStart(4)}/1K  ${String(r.factCount).padStart(3)} facts  ${String(r.wordCount).padStart(5)} words  ${r.file}`);
  }

  if (args.output) {
    const report = {
      generated: new Date().toISOString(),
      threshold: THRESHOLD,
      summary: {
        filesScored: results.length,
        avgDensity,
        belowThreshold: belowThreshold.length,
        grades: gradeDistrib,
      },
      files: results.map(r => ({
        file: r.file,
        wordCount: r.wordCount,
        factCount: r.factCount,
        entityCount: r.entityCount,
        densityPer1K: r.densityPer1K,
        grade: r.grade,
        paragraphsWithoutFacts: r.paragraphs.withoutFacts,
        totalParagraphs: r.paragraphs.total,
      })),
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
