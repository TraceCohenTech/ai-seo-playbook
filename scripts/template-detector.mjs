#!/usr/bin/env node

/**
 * AI Template Fingerprint Detector
 *
 * Scans a directory of content files for repeated phrases, shared openers/closers,
 * and other patterns that signal AI-generated content at scale.
 *
 * Usage:
 *   node scripts/template-detector.mjs --dir ./content
 *   node scripts/template-detector.mjs --dir ./src/app/blog --ext .tsx --threshold 5
 *
 * This catches the patterns Google's scaled-content-abuse systems look for:
 * identical transitional phrases across hundreds of posts.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, extname } from 'path';

const DEFAULTS = {
  dir: './content',
  ext: null, // all text files
  threshold: 3, // minimum occurrences to flag
  output: null,
};

// Known AI template phrases — extend this list with your own
const KNOWN_PATTERNS = [
  // Openers
  /the (?:short|quick|simple) answer (?:is|here)/gi,
  /(?:the )?longer answer is (?:more )?interesting/gi,
  /let(?:'s| us) (?:dive|dig|break|unpack|explore)/gi,
  /in (?:this|today's) (?:post|article|piece|guide)/gi,
  /if you(?:'ve| have) been (?:following|watching|paying attention)/gi,

  // Transitions
  /it's worth (?:noting|mentioning|pointing out)/gi,
  /(?:but )?here's (?:the thing|where it gets interesting|the kicker)/gi,
  /the (?:real|bigger|more interesting) (?:question|story|picture)/gi,
  /(?:but )?what does this (?:mean|look like|imply) (?:for|in practice)/gi,
  /to (?:put|place) (?:this|that|it) in (?:context|perspective)/gi,

  // Closers
  /what to watch(?::| for)/gi,
  /(?:the )?bottom line(?::| is| here)/gi,
  /only time will tell/gi,
  /it remains to be seen/gi,
  /(?:the )?takeaway(?::| is| here)/gi,
  /looking (?:ahead|forward),? (?:the|we|it)/gi,

  // Hedging
  /it's (?:important|crucial|critical|essential|vital) to (?:note|remember|understand)/gi,
  /(?:while|although) (?:it's|it is) (?:too early|difficult|hard) to (?:say|tell|know)/gi,
  /there(?:'s| is) no (?:denying|question|doubt)/gi,
  /whether .{10,40} remains (?:to be seen|unclear|an open question)/gi,

  // Filler
  /in an? (?:era|world|landscape|environment) (?:where|of|defined by)/gi,
  /(?:the )?(?:rapidly )?(?:evolving|shifting|changing) landscape/gi,
  /at the (?:intersection|crossroads|confluence) of/gi,
  /(?:represents|marks|signals) a (?:significant|major|important|pivotal|crucial) (?:shift|moment|milestone|turning point)/gi,
];

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { ...DEFAULTS };

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const val = args[i + 1];
    if (key === 'dir') config.dir = val;
    else if (key === 'ext') config.ext = val.startsWith('.') ? val : `.${val}`;
    else if (key === 'threshold') config.threshold = Number(val);
    else if (key === 'output') config.output = val;
  }

  return config;
}

function walkDir(dir, ext) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walkDir(full, ext));
    } else if (!ext || extname(full) === ext) {
      files.push(full);
    }
  }
  return files;
}

function extractText(content, ext) {
  if (ext === '.tsx' || ext === '.jsx') {
    // Strip JSX/TSX: remove imports, exports, component wrappers, JSX tags
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
      .replace(/^---[\s\S]*?---/m, '') // frontmatter
      .replace(/!\[.*?\]\(.*?\)/g, '') // images
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → text
      .replace(/#{1,6}\s/g, '') // headings
      .replace(/[*_`~]/g, '');
  }
  return content;
}

function main() {
  const config = parseArgs();
  const files = walkDir(config.dir, config.ext);

  if (files.length === 0) {
    console.error(`No files found in ${config.dir}${config.ext ? ` with extension ${config.ext}` : ''}`);
    process.exit(1);
  }

  console.log(`\nScanning ${files.length} files in ${config.dir}\n`);

  // Track known pattern matches
  const patternHits = new Map(); // pattern string → [{ file, match }]

  // Track N-gram frequency for unknown patterns
  const ngramFreq = new Map(); // ngram → [file]

  // Track opener/closer patterns
  const openers = new Map(); // first 60 chars → [file]
  const closers = new Map(); // last 60 chars → [file]

  for (const file of files) {
    const raw = readFileSync(file, 'utf-8');
    const ext = extname(file);
    const text = extractText(raw, ext);

    // Check known patterns
    for (const pattern of KNOWN_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const key = pattern.source;
        if (!patternHits.has(key)) patternHits.set(key, []);
        patternHits.get(key).push({ file, match: match[0] });
      }
    }

    // Extract sentences for N-gram analysis
    const sentences = text.split(/[.!?]+/).map(s => s.trim().toLowerCase()).filter(s => s.length > 20);

    for (const sentence of sentences) {
      // 5-word N-grams
      const words = sentence.split(/\s+/);
      for (let i = 0; i <= words.length - 5; i++) {
        const ngram = words.slice(i, i + 5).join(' ');
        if (!ngramFreq.has(ngram)) ngramFreq.set(ngram, new Set());
        ngramFreq.get(ngram).add(file);
      }
    }

    // Track openers and closers
    const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 30);
    if (paragraphs.length > 0) {
      const opener = paragraphs[0].slice(0, 60).toLowerCase().trim();
      if (!openers.has(opener)) openers.set(opener, []);
      openers.get(opener).push(file);

      const closer = paragraphs[paragraphs.length - 1].slice(-60).toLowerCase().trim();
      if (!closers.has(closer)) closers.set(closer, []);
      closers.get(closer).push(file);
    }
  }

  // Report
  console.log('═'.repeat(70));
  console.log(' KNOWN TEMPLATE PATTERNS');
  console.log('═'.repeat(70));

  const sortedPatterns = [...patternHits.entries()]
    .filter(([, hits]) => hits.length >= config.threshold)
    .sort((a, b) => b[1].length - a[1].length);

  if (sortedPatterns.length === 0) {
    console.log('\n  No known template patterns found above threshold.\n');
  } else {
    for (const [pattern, hits] of sortedPatterns) {
      const uniqueFiles = new Set(hits.map(h => h.file)).size;
      const example = hits[0].match;
      console.log(`\n  ${hits.length} matches across ${uniqueFiles} files`);
      console.log(`  Pattern: ${pattern}`);
      console.log(`  Example: "${example}"`);
    }
  }

  console.log('\n' + '═'.repeat(70));
  console.log(' REPEATED PHRASES (discovered via N-gram analysis)');
  console.log('═'.repeat(70));

  const repeatedNgrams = [...ngramFreq.entries()]
    .filter(([, fileSet]) => fileSet.size >= config.threshold)
    .map(([ngram, fileSet]) => ({ ngram, count: fileSet.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  if (repeatedNgrams.length === 0) {
    console.log('\n  No repeated 5-word phrases found above threshold.\n');
  } else {
    for (const { ngram, count } of repeatedNgrams) {
      console.log(`  ${String(count).padStart(4)} files: "${ngram}"`);
    }
  }

  console.log('\n' + '═'.repeat(70));
  console.log(' SHARED CLOSERS');
  console.log('═'.repeat(70));

  const sharedClosers = [...closers.entries()]
    .filter(([, files]) => files.length >= config.threshold)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10);

  for (const [closer, matchFiles] of sharedClosers) {
    const pct = Math.round((matchFiles.length / files.length) * 100);
    console.log(`\n  ${matchFiles.length} files (${pct}%): "...${closer}"`);
  }

  // Summary
  const totalPatternFiles = new Set(sortedPatterns.flatMap(([, hits]) => hits.map(h => h.file))).size;
  const pctAffected = Math.round((totalPatternFiles / files.length) * 100);

  console.log('\n' + '═'.repeat(70));
  console.log(' SUMMARY');
  console.log('═'.repeat(70));
  console.log(`\n  Files scanned:            ${files.length}`);
  console.log(`  Files with template hits: ${totalPatternFiles} (${pctAffected}%)`);
  console.log(`  Unique patterns found:    ${sortedPatterns.length}`);
  console.log(`  Repeated phrases found:   ${repeatedNgrams.length}`);
  console.log(`  Shared closers:           ${sharedClosers.length}\n`);

  if (pctAffected > 20) {
    console.log('  ⚠ WARNING: Over 20% of content has template fingerprints.');
    console.log('  This is a scaled-content-abuse risk. Prioritize purging');
    console.log('  top-traffic files first, then batch the rest.\n');
  }

  if (config.output) {
    const report = {
      generated: new Date().toISOString(),
      filesScanned: files.length,
      filesWithHits: totalPatternFiles,
      pctAffected,
      knownPatterns: sortedPatterns.map(([pattern, hits]) => ({
        pattern,
        matches: hits.length,
        files: [...new Set(hits.map(h => h.file))],
        example: hits[0].match,
      })),
      repeatedPhrases: repeatedNgrams,
      sharedClosers: sharedClosers.map(([closer, matchFiles]) => ({
        closer,
        count: matchFiles.length,
      })),
    };
    writeFileSync(config.output, JSON.stringify(report, null, 2));
    console.log(`\nReport saved to ${config.output}`);
  }
}

main();
