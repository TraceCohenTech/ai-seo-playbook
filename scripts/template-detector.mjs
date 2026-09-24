#!/usr/bin/env node

/**
 * Template Phrase Detector
 *
 * Scans content files for the stock phrases listed in config/anti-ai-rules.json
 * (blockedPhrases, grouped by category), plus repeated 5-word phrases and shared
 * closing lines discovered across files. Repeated boilerplate phrasing across many pages
 * is a heuristic sign of templated, low-effort content; Google's spam policies
 * target "scaled content abuse" (many pages made mainly to rank, with little value).
 * A hit is a prompt to edit, not proof of anything.
 *
 * Text is extracted from what readers see: frontmatter, imports/exports, code, JSX
 * attributes/expressions and HTML tags are removed first (see thin-content-detector.mjs).
 *
 * Usage:
 *   node scripts/template-detector.mjs --dir ./content
 *   node scripts/template-detector.mjs --dir ./src/app/blog --ext .tsx --threshold 5 --output template-scan.json
 *
 * Options:
 *   --dir <path>        Directory to scan (required).
 *   --ext <list>        Comma-separated extensions (default: .md,.mdx,.tsx,.jsx,.html).
 *                       Dot-directories, node_modules and binary files are skipped.
 *   --threshold <n>     Minimum occurrences (phrases) / files (n-grams, closers) to report (default: 3).
 *   --config <file>     Phrase list JSON with a `blockedPhrases: { category: [phrase, ...] }` object
 *                       (default: config/anti-ai-rules.json). Edit that file to change the phrases.
 *   --output <file>     Write the JSON report.
 *
 * Output (JSON): { generated, directory, config, filesScanned, filesWithHits, pctAffected,
 *   byCategoryCount, knownPatterns: [{ phrase, category, matches, files, example }],
 *   flaggedFiles: [{ file, phraseCount, phrases: [{ phrase, category, count }] }],
 *   repeatedPhrases: [{ ngram, count }], sharedClosers: [{ closer, count }] }
 *
 * Exit codes: 0 success (findings are not an error), 1 error.
 */

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { extname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';
import { walkContentFiles, readTextFile, parseExts, extractVisibleText, paragraphsOf } from './thin-content-detector.mjs';

export const DEFAULT_CONFIG = fileURLToPath(new URL('../config/anti-ai-rules.json', import.meta.url));

/** Load `blockedPhrases` from an anti-ai-rules style JSON file → [{ phrase, category }]. */
export function loadPhrases(configPath = DEFAULT_CONFIG) {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  const groups = cfg.blockedPhrases;
  if (!groups || typeof groups !== 'object') throw new Error(`${configPath}: missing "blockedPhrases" object`);
  const out = [];
  for (const [category, list] of Object.entries(groups)) {
    if (!Array.isArray(list)) continue;
    for (const phrase of list) if (typeof phrase === 'string' && phrase.trim()) out.push({ phrase: phrase.trim(), category });
  }
  return out;
}

const normalizeQuotes = (s) => s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');

/** Compile phrases into case-insensitive regexes (whitespace-flexible, word-bounded, curly quotes normalised). */
export function compilePhrases(phrases) {
  return phrases.map((p) => {
    const body = normalizeQuotes(p.phrase).split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const pre = /^\w/.test(p.phrase) ? '\\b' : '';
    const post = /\w$/.test(p.phrase) ? '\\b' : '';
    return { ...p, re: new RegExp(`${pre}${body}${post}`, 'gi') };
  });
}

/**
 * Find phrase hits in text. Overlapping hits (e.g. "in this article" inside
 * "in this article, we'll explore") are counted once, keeping the longest phrase.
 */
export function findPhrases(text, compiled) {
  const t = normalizeQuotes(text);
  const hits = [];
  for (const p of compiled) {
    p.re.lastIndex = 0;
    for (const m of t.matchAll(p.re)) hits.push({ phrase: p.phrase, category: p.category, start: m.index, end: m.index + m[0].length, match: m[0] });
  }
  hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept = [];
  for (const h of hits) {
    const last = kept[kept.length - 1];
    if (last && h.start < last.end) {
      if (h.end - h.start > last.end - last.start) kept[kept.length - 1] = h;
      continue;
    }
    kept.push(h);
  }
  return kept;
}

/** Scan a list of { file, text } documents. Pure; used by main() and the tests. */
export function scanDocuments(docs, compiled, threshold = 3) {
  const phraseHits = new Map();
  const perFile = [];
  const ngramFreq = new Map();
  const closers = new Map();

  for (const { file, text } of docs) {
    const hits = findPhrases(text, compiled);
    const counts = new Map();
    for (const h of hits) {
      if (!phraseHits.has(h.phrase)) phraseHits.set(h.phrase, { category: h.category, hits: [] });
      phraseHits.get(h.phrase).hits.push({ file, match: h.match });
      const c = counts.get(h.phrase) || { phrase: h.phrase, category: h.category, count: 0 };
      c.count++;
      counts.set(h.phrase, c);
    }
    if (hits.length) perFile.push({ file, phraseCount: hits.length, phrases: [...counts.values()].sort((a, b) => b.count - a.count) });

    const sentences = normalizeQuotes(text).split(/[.!?]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 20);
    const seen = new Set();
    for (const sentence of sentences) {
      const words = sentence.split(/\s+/);
      for (let i = 0; i <= words.length - 5; i++) {
        const ngram = words.slice(i, i + 5).join(' ');
        if (seen.has(ngram)) continue;
        seen.add(ngram);
        if (!ngramFreq.has(ngram)) ngramFreq.set(ngram, new Set());
        ngramFreq.get(ngram).add(file);
      }
    }

    const paragraphs = paragraphsOf(text).filter((p) => p.length > 30);
    if (paragraphs.length) {
      const closer = paragraphs[paragraphs.length - 1].slice(-60).toLowerCase().trim();
      if (!closers.has(closer)) closers.set(closer, []);
      closers.get(closer).push(file);
    }
  }

  const knownPatterns = [...phraseHits.entries()]
    .filter(([, v]) => v.hits.length >= threshold)
    .sort((a, b) => b[1].hits.length - a[1].hits.length || a[0].localeCompare(b[0]))
    .map(([phrase, v]) => ({ phrase, category: v.category, matches: v.hits.length, files: [...new Set(v.hits.map((h) => h.file))], example: v.hits[0].match }));

  const byCategoryCount = {};
  for (const [, v] of phraseHits) byCategoryCount[v.category] = (byCategoryCount[v.category] || 0) + v.hits.length;

  const repeatedPhrases = [...ngramFreq.entries()]
    .filter(([, s]) => s.size >= threshold)
    .map(([ngram, s]) => ({ ngram, count: s.size }))
    .sort((a, b) => b.count - a.count || a.ngram.localeCompare(b.ngram))
    .slice(0, 30);

  const sharedClosers = [...closers.entries()]
    .filter(([, f]) => f.length >= threshold)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10)
    .map(([closer, f]) => ({ closer, count: f.length }));

  const filesWithHits = new Set(knownPatterns.flatMap((p) => p.files)).size;
  return {
    filesScanned: docs.length,
    filesWithHits,
    pctAffected: docs.length ? Math.round((filesWithHits / docs.length) * 100) : 0,
    byCategoryCount,
    knownPatterns,
    flaggedFiles: perFile.sort((a, b) => b.phraseCount - a.phraseCount || a.file.localeCompare(b.file)),
    repeatedPhrases,
    sharedClosers,
  };
}

async function main() {
  const args = cli(import.meta.url, {
    dir: { type: 'string', required: true },
    ext: { type: 'string' },
    threshold: { type: 'string', default: '3' },
    config: { type: 'string', default: DEFAULT_CONFIG },
    output: { type: 'string' },
  });
  const threshold = Number(args.threshold);
  if (!Number.isFinite(threshold) || threshold < 1) throw new Error('--threshold must be a positive number');
  const compiled = compilePhrases(loadPhrases(args.config));

  const files = walkContentFiles(args.dir, parseExts(args.ext));
  if (files.length === 0) throw new Error(`No content files found in ${args.dir}`);

  const docs = [];
  for (const file of files) {
    const raw = readTextFile(file);
    if (raw !== null) docs.push({ file, text: extractVisibleText(raw, extname(file)) });
  }
  console.log(`\nScanning ${docs.length} files in ${args.dir} (${compiled.length} phrases from ${relative(process.cwd(), args.config)})\n`);
  const r = scanDocuments(docs, compiled, threshold);

  console.log('═'.repeat(70));
  console.log(` CONFIGURED TEMPLATE PHRASES (>= ${threshold} matches)`);
  console.log('═'.repeat(70));
  if (r.knownPatterns.length === 0) console.log('\n  None above threshold.');
  for (const p of r.knownPatterns) {
    console.log(`\n  ${p.matches} matches across ${p.files.length} files  [${p.category}]`);
    console.log(`  Phrase:  "${p.phrase}"`);
  }

  console.log('\n' + '═'.repeat(70));
  console.log(' REPEATED 5-WORD PHRASES (n-gram discovery)');
  console.log('═'.repeat(70));
  if (r.repeatedPhrases.length === 0) console.log('\n  None above threshold.');
  for (const { ngram, count } of r.repeatedPhrases) console.log(`  ${String(count).padStart(4)} files: "${ngram}"`);

  console.log('\n' + '═'.repeat(70));
  console.log(' SHARED CLOSERS');
  console.log('═'.repeat(70));
  if (r.sharedClosers.length === 0) console.log('\n  None above threshold.');
  for (const c of r.sharedClosers) console.log(`\n  ${c.count} files (${Math.round((c.count / r.filesScanned) * 100)}%): "...${c.closer}"`);

  console.log('\n' + '═'.repeat(70));
  console.log(' SUMMARY');
  console.log('═'.repeat(70));
  console.log(`\n  Files scanned:            ${r.filesScanned}`);
  console.log(`  Files with phrase hits:   ${r.flaggedFiles.length} (any phrase), ${r.filesWithHits} (phrases above threshold, ${r.pctAffected}%)`);
  console.log(`  Phrases above threshold:  ${r.knownPatterns.length}`);
  console.log(`  Repeated 5-word phrases:  ${r.repeatedPhrases.length}`);
  console.log(`  Shared closers:           ${r.sharedClosers.length}\n`);
  if (r.pctAffected > 20) {
    console.log('  Note: over 20% of files share configured template phrases. Consider editing the');
    console.log('  highest-traffic pages first; vary openers and closers rather than swapping synonyms.\n');
  }

  if (args.output) {
    const report = { generated: new Date().toISOString(), directory: args.dir, config: relative(process.cwd(), args.config), ...r };
    writeFileSync(args.output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Report saved to ${args.output}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) main().catch(fail);
