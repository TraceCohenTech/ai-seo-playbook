#!/usr/bin/env node

/**
 * Schema Validator
 *
 * Extracts JSON-LD structured data and checks it against the required and
 * recommended properties in Google Search Central's structured data docs
 * (https://developers.google.com/search/docs/appearance/structured-data/search-gallery).
 * It catches invalid JSON, missing required properties, missing recommended
 * properties, malformed dates, and duplicate FAQPage items.
 *
 * Primary mode: rendered HTML. Validate what Google actually receives:
 *   node scripts/schema-validator.mjs --url https://example.com/blog/post
 *   node scripts/schema-validator.mjs --url https://example.com/a,https://example.com/b
 *   node scripts/schema-validator.mjs --sitemap https://example.com/sitemap.xml --limit 200
 *
 * Secondary mode: source files (.html, .md, .mdx, .tsx, .jsx). Useful in CI
 * before deploy, but less complete than rendered HTML:
 *   node scripts/schema-validator.mjs --dir ./src/app --output schema-report.json
 * Source mode reads literal <script type="application/ld+json"> blocks and the
 * Next.js pattern `<script type="application/ld+json" dangerouslySetInnerHTML={{
 * __html: JSON.stringify(x) }} />` (also `{JSON.stringify(x)}` as a child). When
 * `x` is an object literal, or a `const x = {…}` in the same file with only
 * literal values, it is validated. When it is built at runtime (function calls,
 * variables, template strings) it is reported as "unresolved": validate those
 * pages with --url.
 *
 * What is checked:
 *   - `@graph` is flattened; its children inherit the parent's @context, so
 *     they get no "missing @context" warning. Top-level arrays are flattened too.
 *   - Required properties (errors) and recommended properties (warnings) for
 *     Article/NewsArticle/BlogPosting, FAQPage, BreadcrumbList, ItemList, Dataset,
 *     Organization, WebSite, VideoObject and JobPosting. Google's Article docs list
 *     NO required properties; author, headline, image and dates are recommended.
 *   - Article authors: each author (single or array) should be a Person or
 *     Organization object with a name; author.url is recommended (info).
 *   - Duplicate FAQPage on one page is an error: Search Console reports it as an
 *     invalid item ("Duplicate field FAQPage"). Merge the questions into one FAQPage.
 *   - FAQ note: since August 2023 Google shows FAQ rich results only for
 *     well-known, authoritative government and health sites. For other sites
 *     FAQPage markup is optional; the on-page Q&A text is what matters.
 *
 * Options:
 *   --url URL[,URL]     One or more page URLs to fetch and validate.
 *   --sitemap URL       Sitemap or sitemap index; every listed page is validated.
 *   --dir PATH          Validate source files instead of rendered HTML.
 *   --limit N           Validate at most N URLs from the sitemap (default: all).
 *   --concurrency N     Parallel page fetches (default 4).
 *   --timeout MS        Per-request timeout in milliseconds (default 15000).
 *   --output FILE       Write the JSON report to FILE.
 *   --help              Show this help.
 *
 * Output: a console report, plus with --output a JSON report with totals,
 * the schema types found, per-page issues (severity error | warn | info),
 * unresolved source JSON-LD, and fetchErrors.
 *
 * Exit codes:
 *   0  no errors (warnings and info notes do not fail the run)
 *   2  findings: at least one error-severity issue
 *   1  error: bad usage, the sitemap could not be read, or a page could not be fetched
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';

const DOCS = 'https://developers.google.com/search/docs/appearance/structured-data/';
const ARTICLE = { required: [], recommended: ['author', 'datePublished', 'dateModified', 'headline', 'image'], doc: DOCS + 'article' };
export const RULES = {
  Article: ARTICLE,
  NewsArticle: ARTICLE,
  BlogPosting: ARTICLE,
  FAQPage: { required: ['mainEntity'], recommended: [], doc: DOCS + 'faqpage' },
  BreadcrumbList: { required: ['itemListElement'], recommended: [], doc: DOCS + 'breadcrumb' },
  ItemList: { required: ['itemListElement'], recommended: [], doc: DOCS + 'carousel' },
  Dataset: { required: ['name', 'description'], recommended: ['url', 'license', 'creator', 'temporalCoverage', 'variableMeasured'], doc: DOCS + 'dataset' },
  Organization: { required: [], recommended: ['name', 'url', 'logo'], doc: DOCS + 'organization' },
  WebSite: { required: ['name', 'url'], recommended: [], doc: DOCS + 'site-names' },
  VideoObject: { required: ['name', 'thumbnailUrl', 'uploadDate'], recommended: ['description', 'contentUrl', 'embedUrl', 'duration'], doc: DOCS + 'video' },
  JobPosting: { required: ['datePosted', 'description', 'hiringOrganization', 'title'], recommended: ['validThrough', 'employmentType', 'baseSalary'], doc: DOCS + 'job-posting' },
};
const DATE_FIELDS = ['datePublished', 'dateModified', 'uploadDate', 'datePosted', 'validThrough'];

// ---------- extraction: rendered HTML ----------

const SCRIPT_RE = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;

/** Return the raw JSON-LD blocks from HTML as [{ value } | { parseError, raw }]. */
export function extractFromHtml(html) {
  const blocks = [];
  let m;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(html)) !== null) {
    const raw = m[1].trim().replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
    try { blocks.push({ value: JSON.parse(raw) }); } catch (e) { blocks.push({ parseError: e.message, raw: raw.slice(0, 200) }); }
  }
  return blocks;
}

// ---------- extraction: JSX/TSX source ----------

class Dynamic extends Error {}

/** Parse a JS object/array literal with only literal values. Throws Dynamic otherwise. */
export function parseJsLiteral(src, start = 0) {
  let i = start;
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
      return;
    }
  };
  const str = () => {
    const q = src[i++];
    let out = '';
    while (i < src.length && src[i] !== q) {
      if (q === '`' && src.startsWith('${', i)) throw new Dynamic('template expression');
      if (src[i] === '\\') {
        const n = src[i + 1];
        const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
        if (n === 'u') { out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue; }
        out += map[n] ?? n; i += 2; continue;
      }
      out += src[i++];
    }
    if (src[i] !== q) throw new Dynamic('unterminated string');
    i++;
    return out;
  };
  const value = () => {
    ws();
    const c = src[i];
    if (c === '{') {
      i++;
      const obj = {};
      for (;;) {
        ws();
        if (src[i] === '}') { i++; return obj; }
        let key;
        if (src[i] === '"' || src[i] === "'" || src[i] === '`') key = str();
        else {
          const km = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
          if (!km) throw new Dynamic('computed key or spread');
          key = km[0]; i += key.length;
        }
        ws();
        if (src[i] !== ':') throw new Dynamic('shorthand property');
        i++;
        obj[key] = value();
        ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return obj; }
        throw new Dynamic('unexpected token in object');
      }
    }
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        ws();
        if (src[i] === ']') { i++; return arr; }
        if (src.startsWith('...', i)) throw new Dynamic('spread');
        arr.push(value());
        ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return arr; }
        throw new Dynamic('unexpected token in array');
      }
    }
    if (c === '"' || c === "'" || c === '`') return str();
    const lit = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?![\w$])/.exec(src.slice(i));
    if (lit) { i += lit[0].length; return JSON.parse(lit[0]); }
    throw new Dynamic('non-literal value');
  };
  const v = value();
  return { value: v, end: i };
}

/** Extract JSON-LD from JSX/TSX source. Returns [{ value } | { parseError } | { unresolved: expr, reason }]. */
export function extractFromJsx(src) {
  const blocks = [];
  const re = /JSON\.stringify\(\s*/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const before = src.slice(Math.max(0, m.index - 600), m.index);
    const tagAt = Math.max(before.lastIndexOf('<script'), before.lastIndexOf('<Script'));
    if (tagAt < 0 || before.slice(tagAt).includes('</')) continue;
    if (!/application\/ld\+json/.test(before.slice(tagAt))) continue;
    const at = m.index + m[0].length;
    try {
      if (src[at] === '{' || src[at] === '[') {
        blocks.push({ value: parseJsLiteral(src, at).value });
        continue;
      }
      const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(at))?.[0];
      const after = id ? src.slice(at + id.length).trimStart()[0] : null;
      if (!id || (after !== ')' && after !== ',')) throw new Dynamic('built at runtime (not a literal or a same-file constant)');
      const decl = new RegExp(`\\b(?:const|let|var)\\s+${id.replace(/\$/g, '\\$')}\\s*(?::[^=]+)?=\\s*`).exec(src);
      if (!decl) throw new Dynamic(`${id} is not declared in this file`);
      const start = decl.index + decl[0].length;
      if (src[start] !== '{' && src[start] !== '[') throw new Dynamic(`${id} is computed at runtime`);
      blocks.push({ value: parseJsLiteral(src, start).value });
    } catch (e) {
      if (!(e instanceof Dynamic)) throw e;
      let depth = 1;
      let j = at;
      while (j < src.length && depth > 0 && j - at < 200) { if (src[j] === '(') depth++; else if (src[j] === ')') depth--; j++; }
      const expr = src.slice(at, depth === 0 ? j - 1 : j).replace(/\s+/g, ' ').trim().slice(0, 80);
      blocks.push({ unresolved: `JSON.stringify(${expr})`, reason: e.message });
    }
  }
  // Literal JSON inside a JSX script tag (rare, but valid): only accept blocks that parse as JSON.
  for (const b of extractFromHtml(src)) if (b.value !== undefined) blocks.push(b);
  return blocks;
}

// ---------- flatten + validate ----------

const typesOf = (node) => (Array.isArray(node?.['@type']) ? node['@type'] : node?.['@type'] ? [node['@type']] : []);

/** Flatten JSON-LD blocks into top-level nodes. `@graph` children inherit @context. */
export function flattenBlocks(blocks) {
  const nodes = [];
  const add = (v, inheritedContext) => {
    if (Array.isArray(v)) { for (const x of v) add(x, inheritedContext); return; }
    if (!v || typeof v !== 'object') return;
    const ctx = v['@context'] ?? inheritedContext;
    if (Array.isArray(v['@graph'])) {
      for (const child of v['@graph']) add(child, ctx);
      if (typesOf(v).length) nodes.push({ node: v, context: ctx });
      return;
    }
    nodes.push({ node: v, context: ctx });
  };
  for (const b of blocks) if (b.value !== undefined) add(b.value, undefined);
  return nodes;
}

const has = (node, f) => node[f] !== undefined && node[f] !== null && node[f] !== '' && !(Array.isArray(node[f]) && node[f].length === 0);
const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

export function validateNode({ node, context }) {
  const issues = [];
  const types = typesOf(node);
  const label = types.join('/') || 'Unknown';
  if (!context) issues.push({ severity: 'warn', message: `${label}: missing @context (expected "https://schema.org")` });
  else if (!JSON.stringify(context).includes('schema.org')) issues.push({ severity: 'warn', message: `${label}: @context does not reference schema.org` });
  if (!types.length) { issues.push({ severity: 'warn', message: 'Node has no @type' }); return issues; }

  for (const t of types) {
    const rule = RULES[t];
    if (!rule) continue;
    for (const f of rule.required) if (!has(node, f)) issues.push({ severity: 'error', message: `${t}: missing required property "${f}"`, doc: rule.doc });
    for (const f of rule.recommended) if (!has(node, f)) issues.push({ severity: 'warn', message: `${t}: missing recommended property "${f}"`, doc: rule.doc });
  }
  for (const f of DATE_FIELDS) {
    if (typeof node[f] === 'string' && Number.isNaN(Date.parse(node[f]))) issues.push({ severity: 'warn', message: `${label}: ${f} "${node[f]}" is not an ISO 8601 date` });
  }

  if (types.some((t) => ARTICLE === RULES[t])) {
    for (const a of asArray(node.author)) {
      if (typeof a === 'string') { issues.push({ severity: 'warn', message: `${label}: author "${a}" is a string; use a Person or Organization object with a name` }); continue; }
      if (!a || typeof a !== 'object') continue;
      if (!has(a, 'name')) issues.push({ severity: 'warn', message: `${label}: author is missing "name"` });
      else if (!has(a, 'url') && !has(a, 'sameAs')) issues.push({ severity: 'info', message: `${label}: author "${a.name}" has no url (Google recommends author.url to identify the author)` });
    }
  }

  if (types.includes('FAQPage')) {
    for (const q of asArray(node.mainEntity)) {
      if (!q || typeof q !== 'object') continue;
      if (!has(q, 'name')) issues.push({ severity: 'error', message: 'FAQPage: Question missing required "name"', doc: RULES.FAQPage.doc });
      const answers = asArray(q.acceptedAnswer);
      if (!answers.length) issues.push({ severity: 'error', message: `FAQPage: Question "${q.name ?? '?'}" missing required "acceptedAnswer"`, doc: RULES.FAQPage.doc });
      for (const a of answers) if (!a || !has(a, 'text')) issues.push({ severity: 'error', message: `FAQPage: Answer to "${q.name ?? '?'}" missing required "text"`, doc: RULES.FAQPage.doc });
    }
  }

  if (types.includes('BreadcrumbList') || types.includes('ItemList')) {
    const items = asArray(node.itemListElement);
    items.forEach((it, idx) => {
      if (!it || typeof it !== 'object') return;
      if (!has(it, 'position')) issues.push({ severity: 'error', message: `${label}: ListItem ${idx + 1} missing required "position"` });
      if (types.includes('BreadcrumbList')) {
        if (!has(it, 'name') && !(it.item && typeof it.item === 'object' && has(it.item, 'name'))) issues.push({ severity: 'error', message: `BreadcrumbList: ListItem ${idx + 1} missing required "name"` });
        if (idx < items.length - 1 && !has(it, 'item')) issues.push({ severity: 'error', message: `BreadcrumbList: ListItem ${idx + 1} missing "item" (required except on the last item)` });
      }
    });
  }

  if (types.includes('JobPosting') && !has(node, 'jobLocation') && node.jobLocationType !== 'TELECOMMUTE') {
    issues.push({ severity: 'error', message: 'JobPosting: missing "jobLocation" (required unless jobLocationType is TELECOMMUTE)', doc: RULES.JobPosting.doc });
  }
  return issues;
}

/** Validate all JSON-LD blocks of one page. */
export function validatePage(blocks) {
  const issues = [];
  for (const b of blocks) if (b.parseError) issues.push({ severity: 'error', message: `Invalid JSON in ld+json block: ${b.parseError}` });
  const nodes = flattenBlocks(blocks);
  const counts = {};
  for (const n of nodes) {
    for (const t of typesOf(n.node)) counts[t] = (counts[t] || 0) + 1;
    issues.push(...validateNode(n));
  }
  if (counts.FAQPage > 1) {
    issues.push({ severity: 'error', message: `Duplicate FAQPage (found ${counts.FAQPage}). Search Console reports this as an invalid item ("Duplicate field FAQPage"); merge the questions into one FAQPage.`, doc: RULES.FAQPage.doc });
  }
  for (const [t, c] of Object.entries(counts)) {
    if (c > 1 && t !== 'FAQPage' && RULES[t]) issues.push({ severity: 'info', message: `${c} ${t} items on this page; check that this is intended` });
  }
  if (counts.FAQPage) {
    issues.push({ severity: 'info', message: 'FAQ rich results have been limited to well-known, authoritative government and health sites since Aug 2023; FAQPage markup is optional elsewhere.' });
  }
  return { types: Object.keys(counts), nodeCount: nodes.length, issues, unresolved: blocks.filter((b) => b.unresolved).map(({ unresolved, reason }) => ({ expr: unresolved, reason })) };
}

// ---------- sources: sitemap, URLs, files ----------

export function decodeXmlEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function fetchText(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'ai-seo-playbook-schema-validator/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8');
}

/** Collect page URLs from a sitemap, following sitemap indexes. Throws on fetch failure. */
export async function collectSitemapUrls(sitemapUrl, { timeoutMs = 15000, maxDepth = 3 } = {}) {
  const seen = new Set();
  const urls = [];
  async function visit(url, depth) {
    if (seen.has(url)) return;
    seen.add(url);
    let xml;
    try { xml = await fetchText(url, timeoutMs); } catch (e) { throw new Error(`Could not read sitemap ${url}: ${e.cause?.code || e.message}`); }
    const locs = [...xml.matchAll(/<(?:\w+:)?loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/(?:\w+:)?loc>/gi)].map((m) => decodeXmlEntities(m[1].trim()));
    if (/<(?:\w+:)?sitemapindex[\s>]/i.test(xml)) {
      if (depth >= maxDepth) throw new Error(`Sitemap index nesting deeper than ${maxDepth} at ${url}`);
      for (const loc of locs) await visit(loc, depth + 1);
    } else urls.push(...locs);
  }
  await visit(sitemapUrl, 0);
  return [...new Set(urls)];
}

async function mapLimit(items, limit, fn, onProgress) {
  const out = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
      onProgress?.(++done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function validateUrls(urls, { concurrency = 4, timeoutMs = 15000 } = {}) {
  const results = await mapLimit(urls, concurrency, async (url) => {
    try {
      return { target: url, ...validatePage(extractFromHtml(await fetchText(url, timeoutMs))) };
    } catch (e) {
      return { target: url, fetchError: e.name === 'TimeoutError' ? 'TIMEOUT' : (e.cause?.code || e.message) };
    }
  }, (d, n) => process.stderr.write(`\rValidated ${d}/${n} URLs`));
  if (urls.length) process.stderr.write('\n');
  return results;
}

export async function validateDir(dir) {
  const files = [];
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (['.tsx', '.jsx', '.html', '.mdx', '.md'].includes(extname(e.name).toLowerCase())) files.push(full);
    }
  }
  await walk(dir);
  files.sort();
  const results = [];
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    const ext = extname(f).toLowerCase();
    const blocks = ext === '.tsx' || ext === '.jsx' ? extractFromJsx(src) : extractFromHtml(src);
    results.push({ target: relative(dir, f).split(sep).join('/'), ...validatePage(blocks) });
  }
  return results;
}

// ---------- main ----------

const count = (rs, sev) => rs.reduce((s, r) => s + (r.issues?.filter((i) => i.severity === sev).length ?? 0), 0);

export function buildReport(mode, results) {
  const pages = results.filter((r) => !r.fetchError);
  const types = [...new Set(pages.flatMap((r) => r.types))].sort();
  return {
    generated: new Date().toISOString(),
    mode,
    totalScanned: results.length,
    withSchemas: pages.filter((r) => r.nodeCount > 0).length,
    errors: count(pages, 'error'),
    warnings: count(pages, 'warn'),
    info: count(pages, 'info'),
    schemaTypes: types,
    unresolvedSourceBlocks: pages.reduce((s, r) => s + r.unresolved.length, 0),
    fetchErrors: results.filter((r) => r.fetchError).map((r) => ({ url: r.target, error: r.fetchError })),
    pages: pages.filter((r) => r.nodeCount > 0 || r.issues.length || r.unresolved.length)
      .map((r) => ({ target: r.target, types: r.types, issues: r.issues, ...(r.unresolved.length ? { unresolved: r.unresolved } : {}) })),
  };
}

async function main() {
  const args = cli(import.meta.url, {
    url: { type: 'string' },
    sitemap: { type: 'string' },
    dir: { type: 'string' },
    limit: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    timeout: { type: 'string', default: '15000' },
    output: { type: 'string' },
  });
  const modes = ['url', 'sitemap', 'dir'].filter((k) => args[k]);
  if (modes.length !== 1) {
    console.error('Error: provide exactly one of --url, --sitemap or --dir. Run with --help for usage.');
    process.exit(1);
  }
  const concurrency = Math.max(1, parseInt(args.concurrency, 10) || 4);
  const timeoutMs = Math.max(1000, parseInt(args.timeout, 10) || 15000);

  let results;
  if (args.dir) {
    console.log(`Schema Validator: source files in ${args.dir} (secondary mode; prefer --url for rendered HTML)\n`);
    results = await validateDir(args.dir);
  } else {
    let urls = args.url ? args.url.split(',').map((u) => u.trim()).filter(Boolean) : await collectSitemapUrls(args.sitemap, { timeoutMs });
    if (args.limit) urls = urls.slice(0, Math.max(0, parseInt(args.limit, 10) || 0));
    console.log(`Schema Validator: ${urls.length} rendered page(s)\n`);
    results = await validateUrls(urls, { concurrency, timeoutMs });
  }

  const report = buildReport(args.dir ? 'source' : 'rendered', results);
  console.log('='.repeat(60));
  console.log(' SCHEMA VALIDATION REPORT');
  console.log('='.repeat(60));
  console.log(`\n  ${(args.dir ? 'Files' : 'Pages') + ' scanned:'}       ${report.totalScanned}`);
  console.log(`  With JSON-LD:        ${report.withSchemas}`);
  console.log(`  Schema types found:  ${report.schemaTypes.join(', ') || 'none'}`);
  console.log(`  Errors:              ${report.errors}`);
  console.log(`  Warnings:            ${report.warnings}`);
  console.log(`  Info notes:          ${report.info}`);
  if (args.dir) console.log(`  Unresolved blocks:   ${report.unresolvedSourceBlocks} (built at runtime; validate with --url)`);
  if (report.fetchErrors.length) console.log(`  Fetch errors:        ${report.fetchErrors.length}`);

  for (const [sev, title, mark] of [['error', 'ERRORS', 'x'], ['warn', 'WARNINGS', '!'], ['info', 'NOTES', '-']]) {
    const rows = report.pages.filter((p) => p.issues.some((i) => i.severity === sev));
    if (!rows.length) continue;
    console.log(`\n-- ${title} --\n`);
    for (const p of rows) {
      console.log(`  ${p.target}`);
      for (const i of p.issues.filter((x) => x.severity === sev)) console.log(`    ${mark} ${i.message}`);
    }
  }
  const unresolved = report.pages.filter((p) => p.unresolved);
  if (unresolved.length) {
    console.log('\n-- UNRESOLVED (JSON-LD built at runtime; validate the rendered page with --url) --\n');
    for (const p of unresolved) for (const u of p.unresolved) console.log(`  ${p.target}: ${u.expr}  (${u.reason})`);
  }
  if (report.fetchErrors.length) {
    console.log('\n-- FETCH ERRORS (not validated) --\n');
    for (const f of report.fetchErrors) console.log(`  ${f.url}  ${f.error}`);
  }

  if (args.output) {
    await writeFile(args.output, JSON.stringify(report, null, 2) + '\n');
    console.log(`\nReport saved to ${args.output}`);
  }
  if (report.fetchErrors.length) process.exit(1);
  process.exit(report.errors > 0 ? 2 : 0);
}

function isMain() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isMain()) main().catch(fail);
