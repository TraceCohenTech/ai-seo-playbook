#!/usr/bin/env node

/**
 * Broken Link Checker
 *
 * Scans content files (.md, .mdx, .tsx, .jsx, .html) for links (`href="…"`,
 * Markdown `[text](url)`, `![alt](src)` and `[ref]: url` definitions), resolves
 * each link to an absolute URL, and checks it over HTTP.
 *
 * How links are resolved:
 *   - Absolute links (https://…) are checked as-is.
 *   - Root-relative links (/blog/x) are joined to --base-url.
 *   - Page-relative links (other-post, ../guides/x) are resolved against the
 *     URL of the page that contains them. Each file's URL is derived from its
 *     path: `app/blog/foo/page.tsx` -> /blog/foo (App Router), `blog/foo.md` -> /blog/foo.
 *   - Links to Markdown files (./other.md, ../x.mdx) are resolved on disk
 *     relative to the file, as Markdown renderers do. A missing target file is
 *     reported as broken without any HTTP request. Relative links in Markdown
 *     to other files that exist on disk (../images/logo.png) are file
 *     references too, and are not fetched.
 *   - Fenced code blocks in Markdown are ignored. Fragments (#…) are stripped.
 *
 * Relative links need --base-url. If relative links are found without it, the
 * script stops with exit 1 (use --external-only to check only absolute links).
 *
 * HTTP behaviour: HEAD first; if the server answers 400/403/405/501/999 to HEAD
 * the link is retried with GET, because many hosts reject HEAD. Requests are
 * throttled per host (default 1 request/second per host) and capped by a
 * global concurrency limit.
 *
 * Results:
 *   broken      404/410, other 4xx, 5xx, DNS or connection failures, missing local
 *               Markdown files, malformed URLs
 *   unverified  401/403/429/999 after the GET retry, or timeouts: the server refused
 *               to answer a bot, which does not prove the link is broken. REVIEW by hand.
 *   redirected  resolved OK after a redirect; consider linking to the final URL.
 *
 * Usage:
 *   node scripts/broken-link-checker.mjs --dir ./content --base-url https://example.com
 *   node scripts/broken-link-checker.mjs --dir ./content --external-only
 *   node scripts/broken-link-checker.mjs --dir ./src/app --base-url https://example.com --internal-only --output links.json
 *
 * Options:
 *   --dir PATH          Directory to scan (required).
 *   --base-url URL      Site origin, e.g. https://example.com. Required for relative links.
 *   --external-only     Check only links to other hosts.
 *   --internal-only     Check only links to the --base-url host (requires --base-url).
 *   --concurrency N     Maximum requests in flight overall (default 4).
 *   --rate N            Maximum requests per second per host (default 1).
 *   --timeout MS        Per-request timeout in milliseconds (default 15000).
 *   --output FILE       Write the JSON report to FILE.
 *   --help              Show this help.
 *
 * Output: a console summary, plus with --output a JSON report listing
 * broken, unverified and redirected links with the files (and line numbers)
 * that contain them.
 *
 * Exit codes:
 *   0  no broken links
 *   2  findings: at least one broken link
 *   1  error: bad usage, or relative links found without --base-url
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join, relative, extname, dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';

const SCAN_EXT = new Set(['.md', '.mdx', '.tsx', '.jsx', '.html']);
const MD_EXT = /\.(md|mdx)$/i;
const PAGE_RE = /^page\.(tsx|jsx|js|mdx|md)$/;
const HEAD_FALLBACK = new Set([400, 403, 405, 501, 999]);
const UNVERIFIED = new Set([401, 403, 429, 999]);

// ---------- extraction ----------

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Return [{ raw, line }] for every link in a file's text. */
export function extractLinks(text, ext) {
  let body = text;
  if (ext === '.md' || ext === '.mdx') {
    // Blank out fenced code blocks but keep offsets (so line numbers stay right).
    body = body.replace(/^(```|~~~)[\s\S]*?^\1/gm, (m) => m.replace(/[^\n]/g, ' '));
  }
  const found = [];
  const patterns = [/\bhref\s*=\s*\{?\s*["']([^"'\n]+)["']/g];
  if (ext === '.md' || ext === '.mdx') {
    patterns.push(
      /\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g, // [text](url) and ![alt](src)
      /^\s{0,3}\[[^\]\n]+\]:\s*<?(\S+?)>?(?:\s+["'(].*)?\s*$/gm, // [ref]: url
    );
  }
  for (const re of patterns) {
    let m;
    while ((m = re.exec(body)) !== null) {
      const raw = m[1].trim();
      if (!raw || raw.startsWith('#')) continue;
      if (/^(mailto|tel|javascript|data|sms):/i.test(raw)) continue;
      if (raw.includes('${') || raw.includes('{') || raw.includes('}')) continue; // template, not a literal URL
      found.push({ raw, line: lineOf(body, m.index) });
    }
  }
  return found;
}

/** URL path of a content file relative to the scanned directory (posix path). */
export function fileRoute(relPath, appRouter) {
  const parts = relPath.split('/');
  const file = parts.pop();
  if (appRouter && PAGE_RE.test(file)) {
    return '/' + parts.filter((p) => !/^\(.*\)$/.test(p)).join('/');
  }
  const base = file.replace(/\.[^.]+$/, '');
  return '/' + (base === 'index' ? parts : [...parts, base]).join('/');
}

/**
 * Resolve one raw link from a file. Returns
 *   { kind: 'url', url } | { kind: 'local', target, exists, url? } | { kind: 'needs-base' } | { kind: 'skip' }
 */
export function resolveLink(raw, { absFile, rootDir, appRouter, baseUrl }) {
  const noFrag = raw.split('#')[0];
  if (!noFrag) return { kind: 'skip' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(noFrag)) {
    return /^https?:/i.test(noFrag) ? { kind: 'url', url: new URL(noFrag).href } : { kind: 'skip' };
  }
  if (noFrag.startsWith('//')) return { kind: 'url', url: new URL('https:' + noFrag).href };

  const pathOnly = noFrag.split('?')[0];
  if (!pathOnly.startsWith('/')) {
    let target;
    try { target = resolve(dirname(absFile), decodeURIComponent(pathOnly)); } catch { target = resolve(dirname(absFile), pathOnly); }
    const isMdLink = MD_EXT.test(pathOnly);
    const inMarkdown = MD_EXT.test(absFile);
    // Links to .md/.mdx files, and relative links in Markdown whose target exists on disk
    // (images, downloads), are file references: check the file, not a URL.
    if (isMdLink || (inMarkdown && /\.[a-z0-9]+$/i.test(pathOnly) && existsSync(target))) {
      const exists = existsSync(target);
      return { kind: 'local', target, exists };
    }
  }
  if (!baseUrl) return { kind: 'needs-base' };
  if (noFrag.startsWith('/')) return { kind: 'url', url: new URL(noFrag, baseUrl).href };
  const rel = relative(rootDir, absFile).split(sep).join('/');
  const pageUrl = new URL(fileRoute(rel, appRouter), baseUrl).href;
  return { kind: 'url', url: new URL(noFrag, pageUrl).href };
}

async function listFiles(dir) {
  const out = [];
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (SCAN_EXT.has(extname(e.name).toLowerCase())) out.push(full);
    }
  }
  await walk(dir);
  return out.sort();
}

/** Scan a directory. Returns { files, urls: Map(url -> { sources }), local, needsBase, invalid }. */
export async function collectLinks(dir, baseUrl) {
  const rootDir = resolve(dir);
  const files = await listFiles(rootDir);
  const appRouter = files.some((f) => PAGE_RE.test(f.split(sep).pop()));
  const urls = new Map();
  const local = [];
  const needsBase = [];
  const invalid = [];
  for (const absFile of files) {
    const text = await readFile(absFile, 'utf8');
    const relFile = relative(rootDir, absFile).split(sep).join('/');
    for (const { raw, line } of extractLinks(text, extname(absFile).toLowerCase())) {
      const source = `${relFile}:${line}`;
      let r;
      try { r = resolveLink(raw, { absFile, rootDir, appRouter, baseUrl }); } catch { invalid.push({ link: raw, source }); continue; }
      if (r.kind === 'skip') continue;
      if (r.kind === 'needs-base') { needsBase.push({ link: raw, source }); continue; }
      if (r.kind === 'local') {
        local.push({ link: raw, source, target: relative(rootDir, r.target).split(sep).join('/'), exists: r.exists });
        continue;
      }
      if (!urls.has(r.url)) urls.set(r.url, { sources: [] });
      urls.get(r.url).sources.push(source);
    }
  }
  return { files: files.length, urls, local, needsBase, invalid };
}

// ---------- throttled HTTP ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Per-host throttle: at most `rate` request starts per second per host. */
export function hostThrottle(rate) {
  const interval = rate > 0 ? 1000 / rate : 0;
  const nextAt = new Map();
  return async (url) => {
    const host = new URL(url).host;
    const now = Date.now();
    const at = Math.max(now, nextAt.get(host) ?? 0);
    nextAt.set(host, at + interval);
    if (at > now) await sleep(at - now);
  };
}

export async function checkUrl(url, { throttle, timeoutMs = 15000, fetchImpl = fetch }) {
  const opts = (method) => ({ method, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'ai-seo-playbook-link-checker/1.0' } });
  try {
    await throttle(url);
    let res = await fetchImpl(url, opts('HEAD'));
    await res.body?.cancel();
    let method = 'HEAD';
    if (HEAD_FALLBACK.has(res.status)) {
      await throttle(url);
      res = await fetchImpl(url, opts('GET'));
      await res.body?.cancel();
      method = 'GET';
    }
    const finalUrl = res.url && res.url !== url ? res.url : null;
    let state = res.ok ? 'ok' : UNVERIFIED.has(res.status) ? 'unverified' : 'broken';
    return { url, status: res.status, method, state, redirected: !!(res.redirected || finalUrl), finalUrl };
  } catch (err) {
    const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return { url, status: 0, state: timeout ? 'unverified' : 'broken', error: timeout ? 'TIMEOUT' : (err.cause?.code || err.message) };
  }
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

// ---------- main ----------

async function main() {
  const args = cli(import.meta.url, {
    dir: { type: 'string', required: true },
    'base-url': { type: 'string' },
    'external-only': { type: 'boolean', default: false },
    'internal-only': { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '4' },
    rate: { type: 'string', default: '1' },
    timeout: { type: 'string', default: '15000' },
    output: { type: 'string' },
  });
  const baseUrl = args['base-url'];
  if (args['internal-only'] && !baseUrl) { console.error('Error: --internal-only requires --base-url.'); process.exit(1); }
  if (args['internal-only'] && args['external-only']) { console.error('Error: choose one of --internal-only / --external-only.'); process.exit(1); }
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) { console.error('Error: --base-url must start with http:// or https://'); process.exit(1); }
  const concurrency = Math.max(1, parseInt(args.concurrency, 10) || 4);
  const rate = Number(args.rate) > 0 ? Number(args.rate) : 1;
  const timeoutMs = Math.max(1000, parseInt(args.timeout, 10) || 15000);

  console.log(`Scanning ${args.dir} for links...`);
  const { files, urls, local, needsBase, invalid } = await collectLinks(args.dir, baseUrl);

  if (needsBase.length && !args['external-only']) {
    console.error(`Error: found ${needsBase.length} relative link(s) but no --base-url, so they cannot be resolved. First few:`);
    for (const n of needsBase.slice(0, 5)) console.error(`  ${n.link}  (${n.source})`);
    console.error('Pass --base-url https://your-site.example, or --external-only to check only absolute links.');
    process.exit(1);
  }

  const baseHost = baseUrl ? new URL(baseUrl).host : null;
  let toCheck = [...urls.keys()];
  if (args['external-only']) toCheck = toCheck.filter((u) => new URL(u).host !== baseHost);
  if (args['internal-only']) toCheck = toCheck.filter((u) => new URL(u).host === baseHost);
  const localChecked = args['external-only'] ? [] : local;

  console.log(`  ${files} files, ${toCheck.length} unique URLs to check, ${localChecked.length} local Markdown links`);
  console.log(`  Throttle: ${rate} request(s)/second per host, ${concurrency} in flight overall\n`);

  const throttle = hostThrottle(rate);
  const results = await mapLimit(toCheck, concurrency, (u) => checkUrl(u, { throttle, timeoutMs }),
    (d, n) => process.stderr.write(`\rChecked ${d}/${n}`));
  if (toCheck.length) process.stderr.write('\n');

  const withSources = (r) => ({ ...r, sources: urls.get(r.url).sources });
  const broken = results.filter((r) => r.state === 'broken').map(withSources);
  const unverified = results.filter((r) => r.state === 'unverified').map(withSources);
  const redirected = results.filter((r) => r.state === 'ok' && r.redirected).map(withSources);
  const missingLocal = localChecked.filter((l) => !l.exists);

  console.log('=== BROKEN LINK REPORT ===\n');
  console.log(`URLs checked:          ${results.length}`);
  console.log(`  OK:                  ${results.filter((r) => r.state === 'ok' && !r.redirected).length}`);
  console.log(`  Redirected (OK):     ${redirected.length}`);
  console.log(`  Broken:              ${broken.length}`);
  console.log(`  Unverified:          ${unverified.length}`);
  console.log(`Local Markdown links:  ${localChecked.length} (${missingLocal.length} missing)`);

  const where = (s) => `${s.slice(0, 3).join(', ')}${s.length > 3 ? ` (+${s.length - 3} more)` : ''}`;
  if (invalid.length) console.log(`Malformed URLs:        ${invalid.length}`);
  if (broken.length || missingLocal.length || invalid.length) {
    console.log('\n--- BROKEN ---\n');
    for (const b of broken) {
      console.log(`  ${b.status || 'ERR'} ${b.url}${b.error ? `  (${b.error})` : ''}`);
      console.log(`      in ${where(b.sources)}`);
    }
    for (const l of missingLocal) console.log(`  MISSING FILE ${l.link} -> ${l.target}\n      in ${l.source}`);
    for (const l of invalid) console.log(`  MALFORMED ${l.link}\n      in ${l.source}`);
  }
  if (unverified.length) {
    console.log('\n--- UNVERIFIED (server refused a bot or timed out; REVIEW by hand) ---\n');
    for (const u of unverified) console.log(`  ${u.status || u.error} ${u.url}\n      in ${where(u.sources)}`);
  }
  if (redirected.length) {
    console.log('\n--- REDIRECTED (consider linking to the final URL) ---\n');
    for (const r of redirected.slice(0, 20)) console.log(`  ${r.url}\n    -> ${r.finalUrl}`);
    if (redirected.length > 20) console.log(`  ... and ${redirected.length - 20} more`);
  }

  if (args.output) {
    await writeFile(args.output, JSON.stringify({
      generated: new Date().toISOString(),
      dir: args.dir,
      baseUrl: baseUrl ?? null,
      throttle: { requestsPerSecondPerHost: rate, concurrency },
      filesScanned: files,
      totalChecked: results.length,
      broken: broken.map((b) => ({ url: b.url, status: b.status, error: b.error, method: b.method, sources: b.sources })),
      missingLocalFiles: missingLocal.map((l) => ({ link: l.link, target: l.target, source: l.source })),
      malformed: invalid,
      unverified: unverified.map((u) => ({ url: u.url, status: u.status, error: u.error, sources: u.sources })),
      redirected: redirected.map((r) => ({ url: r.url, finalUrl: r.finalUrl, sources: r.sources })),
    }, null, 2) + '\n');
    console.log(`\nReport saved to ${args.output}`);
  }

  process.exit(broken.length || missingLocal.length || invalid.length ? 2 : 0);
}

function isMain() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isMain()) main().catch(fail);
