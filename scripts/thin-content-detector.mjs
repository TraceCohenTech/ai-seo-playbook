#!/usr/bin/env node

/**
 * Thin Content Detector
 *
 * Finds content files with little visible text, so you can decide whether to expand,
 * merge or noindex them. Thin pages dilute a site's overall quality signals and often
 * end up as "Crawled - currently not indexed" in Search Console. (Crawl budget is rarely
 * the issue: Google says it matters mainly for very large sites.)
 *
 * The word count is of VISIBLE text: imports/exports, frontmatter, code, JSX attributes,
 * JSX expressions, <script>/<style> and HTML tags are removed first. For Next.js
 * App Router pages (page.tsx) only the text inside JSX elements is counted. Text that a
 * page renders from data at runtime (arrays, CMS, props) is not visible in the source and
 * is not counted, so check rendered HTML (save it as .html and scan that) when in doubt.
 * Dynamic route files (a [param] directory, e.g. blog/[slug]/page.tsx) are skipped for that reason.
 *
 * Usage:
 *   node scripts/thin-content-detector.mjs --dir ./content
 *   node scripts/thin-content-detector.mjs --dir ./src/app --min-words 250 --min-age-days 180
 *
 * Options:
 *   --dir <path>            Directory to scan (required).
 *   --ext <list>            Comma-separated extensions (default: .md,.mdx,.tsx,.jsx,.html).
 *                           Dot-directories, node_modules and binary files are always skipped.
 *   --min-words <n>         Pages below this many visible words are "thin" (default: 300).
 *                           Pages below a third of it are "critical".
 *   --min-age-days <n>      A critical page is only labelled NOINDEX_CANDIDATE when it is at
 *                           least this old (default: 90). Age comes from a frontmatter / metadata
 *                           date (date, publishedAt, datePublished, ...) or, failing that, the
 *                           file's mtime (unreliable in fresh git checkouts; reported as ageSource).
 *   --output <file>         JSON report path (default: thin-content.json).
 *
 * Labels (heuristics; nothing here is applied automatically):
 *   NOINDEX_CANDIDATE  critical word count AND older than --min-age-days. This script has no
 *                      traffic data: confirm the page has ~zero clicks/impressions in Search
 *                      Console (or use content-audit.mjs, which joins GSC) before noindexing.
 *   REVIEW             thin, link-heavy with little prose, or too new to judge.
 *
 * Output: a JSON array of flagged files:
 *   { file, wordCount, linkCount, ageDays, ageSource, issues: [{type, detail, severity}], recommendation }
 *
 * Exit codes: 0 success (findings are not an error), 1 error.
 *
 * The file also exports the shared content helpers (walkContentFiles, extractVisibleText,
 * countWords, pageAge, ...) used by the other content scripts.
 */

import { readdirSync, readFileSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';

// ───────────────────────── shared content helpers ─────────────────────────

export const DEFAULT_EXTS = ['.md', '.mdx', '.tsx', '.jsx', '.html'];

/** Parse "--ext .md,mdx" into ['.md', '.mdx']. */
export function parseExts(value, fallback = DEFAULT_EXTS) {
  if (!value) return fallback;
  return value.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean).map((e) => (e.startsWith('.') ? e : `.${e}`));
}

/** Recursively list files with one of `exts`, skipping dot-entries and node_modules. */
export function walkContentFiles(dir, exts = DEFAULT_EXTS) {
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) files.push(...walkContentFiles(full, exts));
    else if (st.isFile() && exts.includes(extname(entry).toLowerCase())) files.push(full);
  }
  return files;
}

/** Read a file as UTF-8 text, or return null if it looks binary (contains a NUL byte). */
export function readTextFile(file) {
  const buf = readFileSync(file);
  if (buf.includes(0)) return null;
  return buf.toString('utf8').replace(/^﻿/, '');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', hellip: '…', copy: '©' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Split off YAML frontmatter. Handles CRLF (input is normalised to \n first). */
export function splitFrontmatter(content) {
  const src = content.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const m = src.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  return m ? { frontmatter: m[1], body: src.slice(m[0].length) } : { frontmatter: null, body: src };
}

/** Parse one YAML scalar (quote-aware: "a \"b\"", 'it''s', plain # comment). */
export function parseYamlScalar(raw) {
  const s = raw.trim();
  if (s.startsWith('"')) {
    const m = s.match(/^"((?:[^"\\]|\\.)*)"/);
    return m ? m[1].replace(/\\(["\\/])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t') : s.slice(1);
  }
  if (s.startsWith("'")) {
    const m = s.match(/^'((?:[^']|'')*)'/);
    return m ? m[1].replace(/''/g, "'") : s.slice(1);
  }
  return s.replace(/\s+#.*$/, '').trim();
}

/** Read a top-level frontmatter key (indented keys, e.g. openGraph.title, are ignored). Supports | and > block scalars. */
export function frontmatterValue(frontmatter, key) {
  if (!frontmatter) return null;
  const lines = frontmatter.split('\n');
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[ \\t]*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const rest = m[1].trim();
    if (/^[|>][-+]?$/.test(rest)) {
      const block = [];
      for (let j = i + 1; j < lines.length && (/^\s+\S/.test(lines[j]) || lines[j].trim() === ''); j++) block.push(lines[j].trim());
      return rest.startsWith('>') ? block.filter(Boolean).join(' ') : block.join('\n').trim();
    }
    if (rest === '') return null;
    return parseYamlScalar(rest);
  }
  return null;
}

// --- JS/TS scanning primitives (heuristic, not a full parser) ---

const isWordChar = (c) => c !== undefined && /[\w$]/.test(c);

/** From an opening quote at i, return the index just past the closing quote. */
export function skipString(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (q === '`' && c === '$' && src[j + 1] === '{') { j = matchBrace(src, j + 1) + 1; continue; }
    if (c === q) return j + 1;
    if (c === '\n' && q !== '`') return j + 1; // unterminated: stop at end of line
    j++;
  }
  return j;
}

/** From an opening bracket at i ({, ( or [), return the index of its matching closer. */
export function matchBrace(src, i) {
  const open = src[i];
  const close = { '{': '}', '(': ')', '[': ']' }[open];
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    // A quote opens a string only after a non-word character, so apostrophes in JSX text ("don't") are ignored.
    if ((c === '"' || c === "'" || c === '`') && !isWordChar(src[j - 1])) { j = skipString(src, j) - 1; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return j; }
  }
  return src.length - 1;
}

function stripJsComments(src) {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ') // {/* JSX comment */}
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]+\/\/ .*$/gm, '');
}

/** Remove top-level import/export statements (multi-line aware). Used for MDX. */
export function dropModuleStatements(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const atLineStart = i === 0 || src[i - 1] === '\n';
    if (atLineStart && /^(import|export)\b/.test(src.slice(i, i + 7))) {
      let j = i;
      while (j < src.length && src[j] !== '\n') {
        const c = src[j];
        if (c === '"' || c === "'" || c === '`') { j = skipString(src, j); continue; }
        if (c === '{' || c === '(' || c === '[') { j = matchBrace(src, j) + 1; continue; }
        j++;
      }
      i = j;
      continue;
    }
    out += src[i++];
  }
  return out;
}

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote', 'pre', 'table', 'tr', 'td', 'th', 'thead', 'tbody', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'details', 'summary', 'br', 'hr', 'form', 'label', 'button']);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'code', 'pre']);

function scanTag(src, i) {
  let j = i + 1;
  const closing = src[j] === '/';
  if (closing) j++;
  const nm = /^[A-Za-z][\w.:-]*/.exec(src.slice(j, j + 100));
  const name = nm ? nm[0] : '';
  j += name.length;
  while (j < src.length && src[j] !== '>') {
    const c = src[j];
    if (c === '"' || c === "'") { const k = src.indexOf(c, j + 1); j = k === -1 ? src.length : k + 1; continue; }
    if (c === '{') { j = matchBrace(src, j) + 1; continue; }
    j++;
  }
  const selfClosing = src[j - 1] === '/';
  return { end: j, name, closing, selfClosing };
}

const TAG_CONTEXT = /[([{},;:?=>&|!]/;
function isTagStart(src, i, depth) {
  const next = src[i + 1];
  if (!(next && (/[A-Za-z>]/.test(next) || next === '/'))) return false;
  if (depth > 0) return true;
  let k = i - 1;
  while (k >= 0 && /\s/.test(src[k])) k--;
  if (k < 0) return true;
  if (TAG_CONTEXT.test(src[k])) return true;
  return /\b(return|yield|default)$/.test(src.slice(Math.max(0, k - 6), k + 1));
}

/**
 * Visible text of JSX: only text inside JSX elements (depth > 0) is emitted; attributes,
 * non-literal {expressions}, generics and surrounding TS code are dropped. Block-level
 * elements become paragraph breaks.
 */
export function jsxToText(src) {
  let out = '';
  let depth = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '<' && isTagStart(src, i, depth)) {
      const t = scanTag(src, i);
      const lname = t.name.toLowerCase();
      if (!t.closing && !t.selfClosing && SKIP_TAGS.has(lname)) {
        const close = src.toLowerCase().indexOf(`</${lname}`, t.end);
        const gt = close === -1 ? -1 : src.indexOf('>', close);
        i = gt === -1 ? n : gt + 1;
        out += '\n\n';
        continue;
      }
      if (t.closing) depth = Math.max(0, depth - 1);
      else if (!t.selfClosing) depth++;
      if (BLOCK_TAGS.has(lname)) out += '\n\n';
      i = t.end + 1;
      continue;
    }
    if (depth === 0) {
      if ((c === '"' || c === "'" || c === '`') && !isWordChar(src[i - 1])) { i = skipString(src, i); continue; }
      i++;
      continue;
    }
    if (c === '{') {
      const j = matchBrace(src, i);
      const inner = src.slice(i + 1, j);
      const lit = inner.match(/^\s*(["'`])([\s\S]*)\1\s*$/);
      if (lit && !(lit[1] === '`' && lit[2].includes('${'))) out += lit[2];
      else out += ` ${jsxToText(inner)} `;
      i = j + 1;
      continue;
    }
    out += /\s/.test(c) ? ' ' : c;
    i++;
  }
  return out;
}

function markdownToText(src) {
  return src
    .replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, '\n')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/^[ \t]*\[[^\]]+\]:[ \t]*\S+.*$/gm, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '')
    .replace(/(\*\*|__|~~)/g, '')
    .replace(/(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)/g, '$1$2');
}

function htmlToText(src) {
  let s = src.replace(/<!--[\s\S]*?-->/g, ' ');
  const main = s.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) s = main[1];
  s = s.replace(/<(script|style|noscript|template|svg|head|nav|footer)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(new RegExp(`</?(?:${[...BLOCK_TAGS].join('|')})\\b[^>]*>`, 'gi'), '\n\n');
  s = s.replace(/<[^>]+>/g, ' ');
  return s;
}

function tidy(text) {
  return decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract the visible text of a content file. Paragraphs are separated by blank lines.
 * ext: .md .mdx .tsx .jsx .html (.htm); anything else is treated as plain text.
 */
export function extractVisibleText(content, ext) {
  const e = ext.toLowerCase();
  const src = content.replace(/\r\n?/g, '\n');
  if (e === '.tsx' || e === '.jsx' || e === '.ts' || e === '.js') return tidy(jsxToText(stripJsComments(src)));
  if (e === '.md' || e === '.mdx') {
    let body = splitFrontmatter(src).body;
    if (e === '.mdx') {
      body = dropModuleStatements(body).replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
      let out = '';
      for (let i = 0; i < body.length; i++) {
        if (body[i] === '{') { i = matchBrace(body, i); out += ' '; continue; }
        out += body[i];
      }
      body = out;
    }
    return tidy(markdownToText(body));
  }
  if (e === '.html' || e === '.htm') return tidy(htmlToText(src));
  return tidy(src);
}

/** Count words: whitespace-separated tokens containing at least one letter or digit. */
export function countWords(text) {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Split extracted text into paragraphs. */
export function paragraphsOf(text) {
  return text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const DATE_KEYS = ['datePublished', 'publishedAt', 'published_at', 'published', 'pubDate', 'date', 'created', 'createdAt'];

/** Find a publish date in frontmatter, Next.js metadata / JSON-LD, or HTML meta. Returns a Date or null. */
export function findPublishDate(content) {
  const { frontmatter } = splitFrontmatter(content);
  for (const k of DATE_KEYS) {
    const v = frontmatterValue(frontmatter, k);
    if (v) { const d = new Date(v); if (!Number.isNaN(d.getTime())) return d; }
  }
  const patterns = [
    /["']?(?:datePublished|publishedTime|publishedAt|pubDate)["']?\s*:\s*["'`](\d{4}-\d{2}-\d{2}[^"'`]*)["'`]/,
    /<meta\s[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i,
    /<meta\s[^>]*content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i,
    /\b(?:date|published)\s*:\s*["'`](\d{4}-\d{2}-\d{2}[^"'`]*)["'`]/,
  ];
  for (const p of patterns) {
    const m = content.match(p);
    if (m) { const d = new Date(m[1]); if (!Number.isNaN(d.getTime())) return d; }
  }
  return null;
}

/** Page age in days from a content date, falling back to file mtime. */
export function pageAge(file, content, now = new Date()) {
  const d = findPublishDate(content);
  if (d) return { ageDays: Math.floor((now - d) / 86400000), ageSource: 'content-date', date: d.toISOString().slice(0, 10) };
  const mtime = statSync(file).mtime;
  return { ageDays: Math.floor((now - mtime) / 86400000), ageSource: 'file-mtime', date: mtime.toISOString().slice(0, 10) };
}

/** Internal/external link targets written in the source: href="…", href={'…'}, Markdown [x](…) and [x]: … */
export function extractLinkTargets(content) {
  const src = content.replace(/\r\n?/g, '\n');
  const out = [];
  const patterns = [
    /\bhref\s*=\s*(?:\{\s*)?(["'`])([^"'`\n]+?)\1/g,
    /(?<!!)\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g,
    /^[ \t]*\[[^\]]+\]:[ \t]*<?(\S+?)>?(?:[ \t]+["'(].*)?$/gm,
  ];
  for (const p of patterns) {
    for (const m of src.matchAll(p)) {
      const url = p === patterns[0] ? m[2] : m[1];
      if (url.includes('${')) continue;
      out.push(url);
    }
  }
  return out;
}

/**
 * Map a content file to its URL path, relative to the scanned dir.
 *   blog/foo/page.tsx → /blog/foo   (App Router; (groups) and @slots dropped)
 *   posts/foo.md      → /posts/foo  ; index.md → directory path
 * Returns null for dynamic routes ([slug]) whose URL depends on data.
 */
export function urlPathForFile(file, dir, prefix = '') {
  let rel = relative(dir, file).split(sep).join('/');
  rel = rel.replace(/^(?:src\/)?app\//, '').replace(/\.[^./]+$/, '');
  let segs = rel.split('/');
  if (['page', 'index'].includes(segs[segs.length - 1])) segs.pop();
  segs = segs.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'));
  if (segs.some((s) => /^\[.*\]$/.test(s))) return null;
  return normalizePath(`${prefix.replace(/\/$/, '')}/${segs.join('/')}`);
}

export function normalizePath(p) {
  let out = p.replace(/\/{2,}/g, '/').replace(/[?#].*$/, '');
  try { out = decodeURI(out); } catch { /* keep as is */ }
  if (out.length > 1) out = out.replace(/\/$/, '');
  return out.startsWith('/') ? out : `/${out}`;
}

// ───────────────────────── thin-content analysis ─────────────────────────

/** Analyse one file. Pure except for `age`, which the caller supplies. */
export function analyzeThin({ text, content, age, minWords = 300, minAgeDays = 90 }) {
  const wordCount = countWords(text);
  const linkCount = extractLinkTargets(content).length;
  const issues = [];
  const critical = wordCount < minWords / 3;
  if (wordCount < minWords) {
    issues.push({ type: 'thin', detail: `${wordCount} visible words (minimum: ${minWords})`, severity: critical ? 'critical' : 'warning' });
  }
  if (linkCount > 10 && wordCount < Math.max(minWords, 500)) {
    issues.push({ type: 'link_heavy', detail: `${linkCount} links but only ${wordCount} words of prose (hub/list page?)`, severity: 'warning' });
  }
  let recommendation = null;
  if (issues.length) {
    const oldEnough = age && age.ageDays >= minAgeDays;
    recommendation = critical && oldEnough ? 'NOINDEX_CANDIDATE' : 'REVIEW';
    if (critical && !oldEnough) issues.push({ type: 'too_new', detail: `only ${age?.ageDays ?? '?'} days old (min-age-days: ${minAgeDays}); give it time before judging`, severity: 'info' });
  }
  return { wordCount, linkCount, issues, recommendation };
}

async function main() {
  const args = cli(import.meta.url, {
    dir: { type: 'string', required: true },
    ext: { type: 'string' },
    'min-words': { type: 'string', default: '300' },
    'min-age-days': { type: 'string', default: '90' },
    output: { type: 'string', default: 'thin-content.json' },
  });
  const minWords = Number(args['min-words']);
  const minAgeDays = Number(args['min-age-days']);
  if (!Number.isFinite(minWords) || !Number.isFinite(minAgeDays)) throw new Error('--min-words and --min-age-days must be numbers');

  const files = walkContentFiles(args.dir, parseExts(args.ext));
  console.log(`\nScanning ${files.length} files for thin content...\n`);

  const results = [];
  let skippedBinary = 0;
  let skippedDynamic = 0;
  for (const file of files) {
    if (/(^|[\\/])\[[^\]\\/]+\]([\\/]|$)/.test(file)) { skippedDynamic++; continue; }
    const content = readTextFile(file);
    if (content === null) { skippedBinary++; continue; }
    const text = extractVisibleText(content, extname(file));
    const age = pageAge(file, content);
    const a = analyzeThin({ text, content, age, minWords, minAgeDays });
    if (a.issues.length) {
      results.push({ file, wordCount: a.wordCount, linkCount: a.linkCount, ageDays: age.ageDays, ageSource: age.ageSource, issues: a.issues, recommendation: a.recommendation });
    }
  }
  results.sort((a, b) => a.wordCount - b.wordCount || a.file.localeCompare(b.file));

  const candidates = results.filter((r) => r.recommendation === 'NOINDEX_CANDIDATE');
  const review = results.filter((r) => r.recommendation === 'REVIEW');

  console.log('═'.repeat(60));
  console.log(' THIN CONTENT REPORT');
  console.log('═'.repeat(60));
  console.log(`\n  Files scanned:        ${files.length}${skippedBinary ? ` (${skippedBinary} binary skipped)` : ''}`);
  if (skippedDynamic) console.log(`  Dynamic routes:       ${skippedDynamic} skipped ([slug] pages render their text from data)`);
  console.log(`  Thin pages found:     ${results.length}`);
  console.log(`  NOINDEX_CANDIDATE:    ${candidates.length}`);
  console.log(`  REVIEW:               ${review.length}`);

  for (const tier of [
    { label: `NOINDEX_CANDIDATE: under ${Math.round(minWords / 3)} words and ${minAgeDays}+ days old. Confirm ~zero traffic in GSC first`, items: candidates },
    { label: 'REVIEW: expand, merge, or leave (short pages such as tools can rank fine)', items: review },
  ]) {
    if (tier.items.length === 0) continue;
    console.log(`\n  ${tier.label}:`);
    for (const r of tier.items.slice(0, 20)) {
      console.log(`    ${r.file} (${r.wordCount} words, ${r.ageDays}d old via ${r.ageSource})`);
      for (const issue of r.issues) console.log(`      → ${issue.detail}`);
    }
    if (tier.items.length > 20) console.log(`    ... and ${tier.items.length - 20} more`);
  }

  writeFileSync(args.output, JSON.stringify(results, null, 2) + '\n');
  console.log(`\n  Full report: ${args.output}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) main().catch(fail);
