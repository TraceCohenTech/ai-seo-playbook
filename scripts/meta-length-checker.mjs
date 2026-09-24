#!/usr/bin/env node

/**
 * Meta Length Checker
 *
 * Flags page titles longer than --max-title characters and meta descriptions longer than
 * --max-description characters. Google truncates long titles and snippets in results
 * (by pixel width, roughly 50-60 characters for titles and ~150-160 for descriptions),
 * so character counts are an approximation. Meant as a CI gate.
 *
 * Where titles/descriptions are read from:
 *   - Markdown / MDX frontmatter: top-level `title:` and `description:` (quoted or plain,
 *     CRLF or LF). Indented keys such as `openGraph:\n  title:` are ignored.
 *   - Next.js (.tsx/.jsx/.ts/.js): the top-level `title` / `description` of
 *     `export const metadata = {...}` or the object returned by `generateMetadata`.
 *     openGraph.title and twitter.title are ignored. `title: { absolute }` and
 *     `title: { default }` are supported. Values built from template literals with
 *     ${...} are dynamic and skipped (check rendered HTML for those).
 *   - HTML: <title> and <meta name="description" content="...">.
 *
 * Usage:
 *   node scripts/meta-length-checker.mjs --dir ./content
 *   node scripts/meta-length-checker.mjs --dir ./src/app --title-suffix " | Example Site"
 *
 * Options:
 *   --dir <path>              Directory to scan (required).
 *   --ext <list>              Comma-separated extensions (default: .md,.mdx,.tsx,.jsx,.ts,.js,.html).
 *                             Dot-directories, node_modules and binary files are skipped.
 *   --max-title <n>           Title limit in characters (default: 60).
 *   --max-description <n>     Description limit in characters (default: 160).
 *   --title-suffix <text>     Appended to source titles before measuring, to model a layout's
 *                             title template such as "%s | Example Site". Not applied to HTML
 *                             files (already rendered) or to Next.js `title.absolute`.
 *   --output <file>           Also write the violations as JSON.
 *
 * Output (JSON): an array of { file, issues: [{ field, value, length, limit, over, suffixApplied? }] },
 * worst first.
 *
 * Exit codes: 0 no violations, 2 violations found, 1 error.
 */

import { writeFileSync, realpathSync } from 'node:fs';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';
import { walkContentFiles, readTextFile, parseExts, splitFrontmatter, frontmatterValue, decodeEntities, skipString, matchBrace } from './thin-content-detector.mjs';

const DEFAULT_EXTS = ['.md', '.mdx', '.tsx', '.jsx', '.ts', '.js', '.html'];

/** Parse a JS string literal ("…", '…' or `…`). Returns { value } or { dynamic: true } or null. */
export function parseJsString(raw) {
  const s = raw.trim();
  const q = s[0];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  const end = skipString(s, 0);
  const body = s.slice(1, end - 1);
  if (q === '`' && body.includes('${')) return { dynamic: true };
  return { value: body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (m, e) => {
    if (e[0] === 'u') return String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ''), 16));
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: '\n', t: '\t', r: '' }[e] ?? e;
  }) };
}

/** Top-level properties of the object literal whose `{` is at openIdx: { key: rawValueSource }. */
export function readTopLevelProps(src, openIdx) {
  const props = {};
  const closeIdx = matchBrace(src, openIdx);
  let i = openIdx + 1;
  const skipValue = (j) => {
    while (j < closeIdx) {
      const c = src[j];
      if (c === '"' || c === "'" || c === '`') { j = skipString(src, j); continue; }
      if (c === '{' || c === '(' || c === '[') { j = matchBrace(src, j) + 1; continue; }
      if (c === ',') return j;
      j++;
    }
    return j;
  };
  while (i < closeIdx) {
    while (i < closeIdx && /[\s,]/.test(src[i])) i++;
    if (i >= closeIdx) break;
    const km = /^(?:(["'])([\w$-]+)\1|([\w$]+))\s*:/.exec(src.slice(i, i + 200));
    if (!km) { i = skipValue(i) + 1; continue; }
    i += km[0].length;
    const start = i;
    i = skipValue(i);
    props[km[2] || km[3]] = src.slice(start, i).trim();
  }
  return props;
}

function metadataObjectStart(src) {
  const m = /export\s+const\s+metadata\b[^=]*=\s*\{/.exec(src);
  if (m) return m.index + m[0].length - 1;
  const g = /generateMetadata\s*\(/.exec(src);
  if (g) {
    const r = /\breturn\s*\(?\s*\{/.exec(src.slice(g.index));
    if (r) return g.index + r.index + r[0].length - 1;
  }
  return -1;
}

/**
 * Extract { title, description, titleAbsolute, dynamic: [] } from a file's source.
 * Values are the literal source text, not including any layout template.
 */
export function extractMeta(content, ext) {
  const e = ext.toLowerCase();
  const out = { title: null, description: null, titleAbsolute: false, dynamic: [] };
  if (e === '.md' || e === '.mdx') {
    const { frontmatter } = splitFrontmatter(content);
    out.title = frontmatterValue(frontmatter, 'title');
    out.description = frontmatterValue(frontmatter, 'description');
  } else if (['.tsx', '.jsx', '.ts', '.js'].includes(e)) {
    const src = content.replace(/\r\n?/g, '\n');
    const start = metadataObjectStart(src);
    if (start === -1) return out;
    const props = readTopLevelProps(src, start);
    if (props.title !== undefined) {
      let raw = props.title;
      if (raw.startsWith('{')) {
        const inner = readTopLevelProps(raw, 0);
        if (inner.absolute !== undefined) { raw = inner.absolute; out.titleAbsolute = true; } else raw = inner.default ?? '';
      }
      const t = parseJsString(raw);
      if (t?.dynamic) out.dynamic.push('title'); else if (t) out.title = t.value;
    }
    if (props.description !== undefined) {
      const d = parseJsString(props.description);
      if (d?.dynamic) out.dynamic.push('description'); else if (d) out.description = d.value;
    }
  } else if (e === '.html' || e === '.htm') {
    const src = content.replace(/<svg\b[\s\S]*?<\/svg>/gi, '');
    const t = src.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (t) out.title = decodeEntities(t[1]).replace(/\s+/g, ' ').trim();
    for (const m of src.matchAll(/<meta\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
      const attrs = {};
      for (const a of m[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4];
      if ((attrs.name || '').toLowerCase() === 'description' && attrs.content !== undefined) {
        out.description = decodeEntities(attrs.content).replace(/\s+/g, ' ').trim();
        break;
      }
    }
  }
  return out;
}

const len = (s) => [...s].length;

/** Check one file's meta against limits. Returns an array of issues. */
export function checkMeta(meta, ext, { maxTitle = 60, maxDescription = 160, titleSuffix = '' } = {}) {
  const issues = [];
  if (meta.title) {
    const applySuffix = titleSuffix && !meta.titleAbsolute && !['.html', '.htm'].includes(ext.toLowerCase());
    const value = applySuffix ? meta.title + titleSuffix : meta.title;
    if (len(value) > maxTitle) {
      issues.push({ field: 'title', value, length: len(value), limit: maxTitle, over: len(value) - maxTitle, ...(applySuffix ? { suffixApplied: titleSuffix } : {}) });
    }
  }
  if (meta.description && len(meta.description) > maxDescription) {
    issues.push({ field: 'description', value: meta.description, length: len(meta.description), limit: maxDescription, over: len(meta.description) - maxDescription });
  }
  return issues;
}

async function main() {
  const args = cli(import.meta.url, {
    dir: { type: 'string', required: true },
    ext: { type: 'string' },
    'max-title': { type: 'string', default: '60' },
    'max-description': { type: 'string', default: '160' },
    'title-suffix': { type: 'string', default: '' },
    output: { type: 'string' },
  });
  const opts = { maxTitle: Number(args['max-title']), maxDescription: Number(args['max-description']), titleSuffix: args['title-suffix'] };
  if (!Number.isFinite(opts.maxTitle) || !Number.isFinite(opts.maxDescription)) throw new Error('--max-title and --max-description must be numbers');

  const files = walkContentFiles(args.dir, parseExts(args.ext, DEFAULT_EXTS));
  console.log(`\nScanning ${files.length} files in ${args.dir}\n`);

  const violations = [];
  let dynamicCount = 0;
  for (const file of files) {
    const content = readTextFile(file);
    if (content === null) continue;
    const ext = extname(file);
    const meta = extractMeta(content, ext);
    if (meta.dynamic.length) dynamicCount++;
    const issues = checkMeta(meta, ext, opts);
    if (issues.length) violations.push({ file, issues });
  }

  const worst = (v) => Math.max(...v.issues.map((i) => i.over));
  violations.sort((a, b) => worst(b) - worst(a) || a.file.localeCompare(b.file));

  const titleViolations = violations.filter((v) => v.issues.some((i) => i.field === 'title'));
  const descViolations = violations.filter((v) => v.issues.some((i) => i.field === 'description'));

  console.log('═'.repeat(60));
  console.log(' META LENGTH CHECK');
  console.log('═'.repeat(60));
  console.log(`\n  Files scanned:          ${files.length}`);
  console.log(`  Title violations:       ${titleViolations.length} (>${opts.maxTitle} chars${opts.titleSuffix ? `, suffix "${opts.titleSuffix}" applied` : ''})`);
  console.log(`  Description violations: ${descViolations.length} (>${opts.maxDescription} chars)`);
  if (dynamicCount) console.log(`  Skipped dynamic values: ${dynamicCount} file(s) build title/description at runtime; check rendered HTML`);

  for (const v of violations) {
    console.log(`\n  ${v.file}`);
    for (const issue of v.issues) {
      console.log(`    ${issue.field}: ${issue.length} chars (+${issue.over} over)`);
      console.log(`    "${issue.value.substring(0, 70)}${issue.value.length > 70 ? '...' : ''}"`);
    }
  }

  if (args.output) {
    writeFileSync(args.output, JSON.stringify(violations, null, 2) + '\n');
    console.log(`\n  Full report: ${args.output}`);
  }
  console.log('');
  if (violations.length > 0) process.exitCode = 2;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) main().catch(fail);
