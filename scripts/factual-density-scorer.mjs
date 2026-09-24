#!/usr/bin/env node

/**
 * Factual Density Scorer
 *
 * Scores content files by "factual density": specific data points (money amounts,
 * percentages, multipliers, large or scaled numbers, dated references, ratios) per
 * 1,000 visible words. Each span of text counts once, even when several patterns match
 * it ("$6.6 billion" is one fact). Bare years ("in 2024") are not counted; qualified
 * dates are ("March 2026", "Q1 2026", "FY2025", "January 15").
 *
 * This is a heuristic for editing, not a ranking or citation predictor: specific, sourced
 * numbers make passages easier to quote and verify, but a high score says nothing about
 * whether the numbers are correct. Never add figures without a source.
 *
 * Usage:
 *   node scripts/factual-density-scorer.mjs --dir ./content
 *   node scripts/factual-density-scorer.mjs --dir ./src/app/blog --threshold 3 --output factual-density.json
 *
 * Options:
 *   --dir <path>          Directory to scan (required).
 *   --ext <list>          Comma-separated extensions (default: .md,.mdx,.tsx,.jsx,.html).
 *                         Dot-directories, node_modules and binary files are skipped.
 *   --threshold <n>       Target facts per 1,000 words (default: 3). Grades: A >= 2x, B >= 1x,
 *                         C >= 0.5x, D > 0, F = 0.
 *   --min-words <n>       Skip files with fewer visible words (default: 50).
 *   --vc                  Also count finance/VC-specific patterns: "Series A-F" as facts and
 *                         NASDAQ/NYSE/SEC/IPO/SPAC as entities.
 *   --output <file>       Write the JSON report.
 *
 * Output (JSON): { generated, threshold, unit: "per 1,000 words", summary, files: [{ file,
 *   wordCount, factCount, factsPer1K, entityCount, entitiesPer1K, grade, totalParagraphs,
 *   paragraphsWithoutFacts }] }
 *
 * Exit codes: 0 success, 1 error.
 */

import { writeFileSync, realpathSync } from 'node:fs';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';
import { walkContentFiles, readTextFile, parseExts, extractVisibleText, countWords, paragraphsOf } from './thin-content-detector.mjs';

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';

export const FACT_PATTERNS = [
  // Money: $1.5B, $347M, $6.6 billion, €20 million, £3.2k
  new RegExp(String.raw`[$€£¥]\s?\d[\d,]*(?:\.\d+)?(?:\s*(?:billion|million|trillion|thousand|bn|mn|[BMKT])\b)?`, 'gi'),
  // Percentages: 42%, 3.2 %, 15 percent
  /\b\d+(?:\.\d+)?\s?(?:%|percent\b)/gi,
  // Multipliers: 3.5x, 10x
  /\b\d[\d,]*(?:\.\d+)?x\b/gi,
  // Large numbers with thousands separators: 4,620,000
  /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g,
  // Scaled amounts: 6.6 billion, 14 million
  /\b\d+(?:\.\d+)?\s+(?:billion|million|trillion|thousand)\b/gi,
  // Qualified periods: Q1 2026, H2 2025, FY2025, FY 2025
  /\b(?:Q[1-4]|H[12])\s+(?:19|20)\d{2}\b|\bFY\s?(?:19|20)?\d{2}\b/g,
  // Dates: January 15, March 2026, 15 March 2026
  new RegExp(String.raw`\b(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b|\b(?:${MONTHS})\.?\s+(?:19|20)\d{2}\b|\b\d{1,2}\s+(?:${MONTHS})\.?\s+(?:19|20)\d{2}\b`, 'g'),
  // ISO dates: 2026-03-15
  /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g,
  // Ratios: 3:1, 10-to-1
  /\b\d+(?::\d+|-to-\d+)\b/g,
];

export const VC_FACT_PATTERNS = [/\bSeries\s+[A-F]\b/g];

export const ENTITY_PATTERNS = [
  // Organisations with a legal suffix: Acme Robotics Inc, Example Capital LLC
  /\b[A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*)*,?\s+(?:Inc|Corp|Corporation|Ltd|LLC|LLP|PLC|GmbH|AG|SA|S\.A\.|Co)\b\.?/g,
  // Multi-word proper names not at the start of a sentence (heuristic): "at Example Capital"
  /(?<=[a-z,;:]\s)[A-Z][a-z]+(?:\s+(?:of|and|&|de|van)?\s*[A-Z][a-z]+)+/g,
];

export const VC_ENTITY_PATTERNS = [/\b(?:NASDAQ|NYSE|S&P|SEC|IPO|SPAC)\b/g];

/** Collect match spans from patterns and merge overlaps, so each stretch of text counts once. */
export function factSpans(text, patterns = FACT_PATTERNS) {
  const spans = [];
  for (const p of patterns) {
    const re = new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`);
    for (const m of text.matchAll(re)) if (m[0].trim()) spans.push([m.index, m.index + m[0].length, m[0]]);
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] < last[1]) { if (s[1] > last[1]) { last[1] = s[1]; last[2] = text.slice(last[0], s[1]); } continue; }
    merged.push([...s]);
  }
  return merged.map(([start, end, match]) => ({ start, end, match }));
}

export const countFacts = (text, { vc = false } = {}) => factSpans(text, vc ? [...FACT_PATTERNS, ...VC_FACT_PATTERNS] : FACT_PATTERNS).length;
export const countEntities = (text, { vc = false } = {}) => factSpans(text, vc ? [...ENTITY_PATTERNS, ...VC_ENTITY_PATTERNS] : ENTITY_PATTERNS).length;

export const per1K = (n, words) => (words > 0 ? Math.round((n / words) * 10000) / 10 : 0);

export function grade(density, threshold) {
  if (density >= threshold * 2) return 'A';
  if (density >= threshold) return 'B';
  if (density >= threshold * 0.5) return 'C';
  return density > 0 ? 'D' : 'F';
}

/** Score extracted text. Paragraphs are blank-line separated (TSX block elements become breaks). */
export function scoreText(text, { threshold = 3, vc = false } = {}) {
  const wordCount = countWords(text);
  const factCount = countFacts(text, { vc });
  const entityCount = countEntities(text, { vc });
  const paragraphs = paragraphsOf(text).filter((p) => countWords(p) >= 8);
  const withoutFacts = paragraphs.filter((p) => countFacts(p, { vc }) === 0).length;
  const factsPer1K = per1K(factCount, wordCount);
  return {
    wordCount,
    factCount,
    factsPer1K,
    entityCount,
    entitiesPer1K: per1K(entityCount, wordCount),
    grade: grade(factsPer1K, threshold),
    totalParagraphs: paragraphs.length,
    paragraphsWithoutFacts: withoutFacts,
  };
}

async function main() {
  const args = cli(import.meta.url, {
    dir: { type: 'string', required: true },
    ext: { type: 'string' },
    threshold: { type: 'string', default: '3' },
    'min-words': { type: 'string', default: '50' },
    vc: { type: 'boolean', default: false },
    output: { type: 'string' },
  });
  const threshold = Number(args.threshold);
  const minWords = Number(args['min-words']);
  if (!Number.isFinite(threshold) || !Number.isFinite(minWords)) throw new Error('--threshold and --min-words must be numbers');

  const files = walkContentFiles(args.dir, parseExts(args.ext));
  if (files.length === 0) throw new Error(`No content files found in ${args.dir}`);
  console.log(`\nScoring factual density for ${files.length} files in ${args.dir}\n`);

  const results = [];
  for (const file of files) {
    const raw = readTextFile(file);
    if (raw === null) continue;
    const s = scoreText(extractVisibleText(raw, extname(file)), { threshold, vc: args.vc });
    if (s.wordCount < minWords) continue;
    results.push({ file, ...s });
  }
  results.sort((a, b) => a.factsPer1K - b.factsPer1K || a.file.localeCompare(b.file));

  const avg = results.length ? Math.round((results.reduce((sum, r) => sum + r.factsPer1K, 0) / results.length) * 10) / 10 : 0;
  const below = results.filter((r) => r.factsPer1K < threshold);
  const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const r of results) grades[r.grade]++;

  console.log('═'.repeat(60));
  console.log(' FACTUAL DENSITY REPORT (heuristic)');
  console.log('═'.repeat(60));
  console.log(`\n  Files scored:       ${results.length}`);
  console.log(`  Avg density:        ${avg} facts per 1,000 words`);
  console.log(`  Threshold:          ${threshold} per 1,000 words`);
  console.log(`  Below threshold:    ${below.length}${results.length ? ` (${Math.round((below.length / results.length) * 100)}%)` : ''}`);
  console.log(`  Grades:             A:${grades.A}  B:${grades.B}  C:${grades.C}  D:${grades.D}  F:${grades.F}`);

  const line = (r) => `  ${r.grade}  ${String(r.factsPer1K).padStart(5)}/1K  ${String(r.factCount).padStart(3)} facts  ${String(r.wordCount).padStart(5)} words  ${r.file}`;
  if (below.length) {
    console.log('\n── LOWEST DENSITY ──\n');
    for (const r of below.slice(0, 20)) {
      console.log(line(r));
      if (r.totalParagraphs && r.paragraphsWithoutFacts / r.totalParagraphs > 0.5) console.log(`     ↳ ${r.paragraphsWithoutFacts} of ${r.totalParagraphs} paragraphs have no data points`);
    }
  }
  console.log('\n── HIGHEST DENSITY ──\n');
  for (const r of results.slice(-10).reverse()) console.log(line(r));

  if (args.output) {
    const report = {
      generated: new Date().toISOString(),
      threshold,
      unit: 'per 1,000 words',
      vcPatterns: args.vc,
      summary: { filesScored: results.length, avgFactsPer1K: avg, belowThreshold: below.length, grades },
      files: results,
    };
    writeFileSync(args.output, JSON.stringify(report, null, 2) + '\n');
    console.log(`\nReport saved to ${args.output}`);
  }
  console.log('');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) main().catch(fail);
